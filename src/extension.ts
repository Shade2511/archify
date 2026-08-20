import * as vscode from 'vscode';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { existsSync, readdirSync } from 'fs';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "archify" is now active!');

    let currentPanel: vscode.WebviewPanel | undefined;
    let webviewReady = false;
    let pendingPointers: Array<{ command: string; data: unknown }> = [];

    // 1. REGISTER YOUR WEBVIEW COMMAND
    let webviewDisposable = vscode.commands.registerCommand('archify.OpenWebview', () => {
        if (currentPanel) {
            currentPanel.reveal(vscode.ViewColumn.Two);
        } else {
            const buildRoot = vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'build');
            const distRoot = vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'dist');

            currentPanel = vscode.window.createWebviewPanel(
                'archifyCanvas',
                'Architecture Canvas',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    localResourceRoots: [buildRoot, distRoot],
                    retainContextWhenHidden: true, // Keep the state of the webview even when it's not visible
                }
            );

            webviewReady = false;
            pendingPointers = [];

            currentPanel.webview.html = getWebviewContent(currentPanel.webview, context.extensionUri);

            // Listen for messages from the webview (persistence, errors, diagnostics)
            currentPanel.webview.onDidReceiveMessage(async message => {
                if (message?.command === 'saveDocument') {
                    // Persist the tldraw snapshot with the project
                    await saveCanvasFile(getCanvasFileUri(context), message.snapshot);
                } else if (message?.command === 'webviewReady') {
                    webviewReady = true;
                    // Send the persisted canvas (if any) to the freshly mounted webview
                    const snapshot = await readCanvasFile(getCanvasFileUri(context));
                    if (snapshot && currentPanel) {
                        await currentPanel.webview.postMessage({ command: 'loadDocument', snapshot });
                    }
                    // Flush any MakePointer actions that ran before the webview was ready
                    if (currentPanel && pendingPointers.length > 0) {
                        for (const queued of pendingPointers) {
                            await currentPanel.webview.postMessage(queued);
                        }
                        pendingPointers = [];
                    }
                } else if (message?.command === 'navigateToCode') {
                    // User clicked a pointer shape: jump to the referenced code
                    await navigateToCode(message.data);
                } else if (message?.command === 'webviewError') {
                    const raw = typeof message.message === 'string' ? message.message : JSON.stringify(message.message);
                    const msg = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
                    console.warn('Webview reported an error:', raw);
                    // Offer user a quick reload action to recover the webview state
                    const choice = await vscode.window.showWarningMessage(`Webview error: ${msg}`, 'Reload Webview');
                    if (choice === 'Reload Webview') {
                        // Dispose current panel and reopen it to get a fresh webview context
                        try {
                            if (currentPanel) {
                                currentPanel.dispose();
                                currentPanel = undefined;
                            }
                            // Re-open the webview (will recreate panel)
                            await vscode.commands.executeCommand('archify.OpenWebview');
                        } catch (e) {
                            console.error('Failed to reload webview panel:', e);
                            vscode.window.showErrorMessage('Failed to reload webview. Check the developer console for details.');
                        }
                    }
                } else if (message?.command === 'userRequestedReload') {
                    // webview asked to be reloaded (user clicked reload inside webview)
                    if (currentPanel) {
                        currentPanel.dispose();
                        currentPanel = undefined;
                        // recreate
                        await vscode.commands.executeCommand('archify.OpenWebview');
                    }
                } else {
                    console.log('Message from webview:', message);
                }
            });

            currentPanel.onDidDispose(() => {
                currentPanel = undefined;
                webviewReady = false;
                pendingPointers = [];
            });
        }
    });

    // 2. YOUR TEXT SELECTION LOGIC (Now sending data to the panel)
    let pointerDisposable = vscode.commands.registerCommand('archify.MakePointer', async () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showWarningMessage('Open a file before adding a pointer to the map.');
            return;
        }

        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

        // Store a workspace-relative path so the canvas file can be committed to
        // the repo and works on any machine (files outside the workspace fall
        // back to their absolute path).
        const relativePath = vscode.workspace.asRelativePath(editor.document.uri);

        // Always remember where the user pointed, so navigation can fall back to
        // this location if the symbol can no longer be resolved by name.
        const selectionStart = {
            line: selection.start.line,
            character: selection.start.character,
        };

        // Find the symbol (function/class) that intersects or contains the
        // user's selection so navigation survives code drift. Names alone are
        // ambiguous (new code above the pointer can introduce a symbol with the
        // same name), so also capture the symbol's container, position and
        // source signature to disambiguate when the pointer is later clicked.
        let symbolName = 'Unknown Block';
        let containerName: string | undefined;
        let symbolStart: SymbolPosition | undefined;
        let signature: string | undefined;
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                editor.document.uri
            );
            if (symbols) {
                const found = findSymbolWithContainerAtRange(symbols, selection);
                if (found) {
                    symbolName = found.symbol.name;
                    // The container name is the symbol that wraps this one
                    // (e.g. the class containing a method), letting resolution
                    // scope by context later.
                    containerName = found.containerName;
                    const range = found.symbol.selectionRange ?? found.symbol.range;
                    symbolStart = { line: range.start.line, character: range.start.character };
                    signature = getSymbolSignature(editor.document, found.symbol);
                }
            }
        } catch (error) {
            console.error('Failed to resolve symbol for pointer:', error);
        }

        // Fallback: if no symbol matched, use the highlighted text itself.
        if (symbolName === 'Unknown Block' && selectedText.trim()) {
            symbolName = selectedText.trim().split(/\s+/).slice(0, 8).join(' ');
        }

        // Build a short preview label for the pointer shape.
        const words = selectedText.trim().split(/\s+/);
        let preview: string;
        if (!selectedText.trim()) {
            preview = symbolName;
        } else if (words.length <= 6) {
            preview = words.join(" ");
        } else {
            preview = `${words.slice(0, 3).join(" ")} ... ${words.slice(-3).join(" ")}`;
        }

        const data = {
            relativePath,
            symbolName,
            containerName,
            symbolStart,
            signature,
            selectionStart,
            preview: preview
        };

        // Send it to the Webview instead of just showing a popup!
        if (currentPanel) {
            if (webviewReady) {
                currentPanel.webview.postMessage({ command: 'addPointer', data });
            } else {
                // The webview may still be loading its bundle; deliver once it's ready
                pendingPointers.push({ command: 'addPointer', data });
            }
            currentPanel.reveal(vscode.ViewColumn.Two);
        } else {
            vscode.window.showInformationMessage('Open the Webview first!');
        }
    });

    // 3. AUTO-SYNC POINTERS ON SAVE: when a file with code pointers is saved,
    // re-resolve each pointer against the fresh file contents and push the
    // updated metadata to the webview so the visible canvas labels refresh
    // without the user having to recreate anything.
    const saveSyncDisposable = vscode.workspace.onDidSaveTextDocument(async document => {
        try {
            if (!currentPanel || !webviewReady) {
                return;
            }
            const relativePath = vscode.workspace.asRelativePath(document.uri);
            if (relativePath.startsWith('..')) {
                return;
            }

            const snapshot = await readCanvasFile(getCanvasFileUri(context));
            const pointerShapes = extractPointerShapes(snapshot, relativePath);
            if (pointerShapes.length === 0) {
                return;
            }

            // Query the symbol provider once and reuse it for every pointer in
            // this file instead of re-parsing per shape.
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            const updatedPointers: Array<{ shapeId: string; meta: Record<string, unknown> }> = [];
            for (const pointer of pointerShapes) {
                const resolved = await resolvePointerTarget(document, pointer.meta, symbols);
                const newMeta = buildUpdatedPointerMeta(document, pointer.meta, resolved);
                if (newMeta && hasPointerMetaChanged(pointer.meta, newMeta)) {
                    updatedPointers.push({ shapeId: pointer.id, meta: newMeta });
                }
            }

            if (updatedPointers.length > 0) {
                await currentPanel.webview.postMessage({
                    command: 'updatePointers',
                    pointers: updatedPointers,
                });
            }
        } catch (error) {
            console.error('Failed to sync pointers after save:', error);
        }
    });

    // Push all of the extension's subscriptions to the context.
    context.subscriptions.push(webviewDisposable, pointerDisposable, saveSyncDisposable);
}

export function deactivate() {}

// Find the innermost symbol in a DocumentSymbol tree that contains (or
// intersects) the given range, plus the name of its immediate container (e.g.
// the class that wraps a method). The container name is derived from the tree
// rather than read from DocumentSymbol.containerName, because not every symbol
// provider populates that property reliably.
function findSymbolWithContainerAtRange(
    symbols: vscode.DocumentSymbol[],
    range: vscode.Range,
    containerName?: string
): { symbol: vscode.DocumentSymbol; containerName?: string } | undefined {
    for (const symbol of symbols) {
        const intersects = symbol.range.contains(range) || Boolean(symbol.range.intersection(range));
        if (intersects) {
            const nested = findSymbolWithContainerAtRange(symbol.children ?? [], range, symbol.name);
            if (nested) {
                return nested;
            }
            return { symbol, containerName };
        }
    }
    return undefined;
}

// A compact record of where a pointer was created in the source file.
interface SymbolPosition {
    line: number;
    character: number;
}

// Normalize the symbol's source text so it can be matched again later even if
// surrounding formatting changed. Used to disambiguate duplicate symbol names.
function getSymbolSignature(document: vscode.TextDocument, symbol: vscode.DocumentSymbol): string | undefined {
    const range = symbol.selectionRange ?? symbol.range;
    return collapseText(document.getText(range));
}

// Recursively collect every symbol whose name matches, not just the first one,
// together with each one's container name. DocumentSymbol trees are ordered by
// source position, so the first match in document order is NOT necessarily the
// symbol the user pointed at once new code has been added above it.
function collectSymbolCandidates(
    symbols: vscode.DocumentSymbol[],
    name: string,
    out: Array<{ symbol: vscode.DocumentSymbol; containerName?: string }>,
    containerName?: string
): void {
    for (const symbol of symbols) {
        if (symbol.name === name) {
            out.push({ symbol, containerName });
        }
        collectSymbolCandidates(symbol.children ?? [], name, out, symbol.name);
    }
}

// Collapse all whitespace/newlines and lowercase so two spellings of the same
// signature compare equal. Used for fuzzy matching below.
function normalizeForComparison(text: string | undefined): string {
    return (text ?? '').toLowerCase().replace(/\s+/g, '');
}

// Levenshtein edit distance between two strings, computed with a rolling
// two-row DP table so memory stays O(min(m, n)). Sequence-aware: reordering
// characters (e.g. "handlejson" vs "jsonhandle") is NOT rewarded.
function levenshteinDistance(a: string, b: string): number {
    if (a.length < b.length) {
        [a, b] = [b, a];
    }
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const curr = new Array<number>(b.length + 1);
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        prev = curr;
    }
    return prev[b.length];
}

// Sequence-based similarity between two strings, returned as a percentage
// (0 to 100). This is a normalized Levenshtein ratio, so it respects the exact
// ORDER of characters - never bag-of-words or unordered sets. Two strings made
// of the same characters in different orders (e.g. "handlejson" vs
// "jsonhandle") correctly score LOW because their edit distance is high.
// Whitespace/case are normalized first so formatting drift doesn't punish a
// real match.
function calculateSequenceSimilarity(str1: string | undefined, str2: string | undefined): number {
    const a = normalizeForComparison(str1);
    const b = normalizeForComparison(str2);
    if (!a && !b) {
        return 100;
    }
    if (!a || !b) {
        return 0;
    }
    if (a === b) {
        return 100;
    }
    const distance = levenshteinDistance(a, b);
    return Math.max(0, Math.round((1 - distance / Math.max(a.length, b.length)) * 100));
}

// The subset of pointer data the resolution pipeline needs.
interface PointerSearchData {
    symbolName?: string;
    containerName?: string;
    symbolStart?: SymbolPosition;
    signature?: string;
}

// Result of the 4-stage resolution pipeline. A target either resolves to a
// DocumentSymbol from the outline (stages 1-2) or to a raw line number
// (stages 3-4, which run when the outline can't help).
interface PointerResolution {
    symbol?: vscode.DocumentSymbol;
    containerName?: string;
    line?: number;
}

// Recursively flatten the full DocumentSymbol tree into a single list.
function collectAllSymbols(symbols: vscode.DocumentSymbol[], out: vscode.DocumentSymbol[]): void {
    for (const symbol of symbols) {
        out.push(symbol);
        collectAllSymbols(symbol.children ?? [], out);
    }
}

// Priority 1 - Exact Outline Match: name must match exactly and, when a
// container was recorded, the container must match too.
function findExactSymbol(
    symbols: vscode.DocumentSymbol[],
    name: string,
    containerName?: string
): { symbol: vscode.DocumentSymbol; containerName?: string } | undefined {
    const candidates: Array<{ symbol: vscode.DocumentSymbol; containerName?: string }> = [];
    collectSymbolCandidates(symbols, name, candidates);
    if (candidates.length === 0) {
        return undefined;
    }
    if (containerName) {
        const scoped = candidates.filter(c => c.containerName === containerName);
        return scoped.length > 0 ? scoped[0] : undefined;
    }
    return candidates[0];
}

// Priority 2 - 70% Outline Sequence Match: compare the stored name/signature
// against every outline symbol with sequence-based similarity and pick the best
// candidate that scores >= 70%.
function findFuzzySymbol(
    symbols: vscode.DocumentSymbol[],
    data: PointerSearchData,
    document: vscode.TextDocument
): { symbol: vscode.DocumentSymbol; containerName?: string } | undefined {
    const all: vscode.DocumentSymbol[] = [];
    collectAllSymbols(symbols, all);

    let best: { symbol: vscode.DocumentSymbol; containerName?: string } | undefined;
    let bestScore = 0;
    for (const candidate of all) {
        const nameScore = data.symbolName ? calculateSequenceSimilarity(data.symbolName, candidate.name) : 0;
        const signature = getSymbolSignature(document, candidate);
        const signatureScore = data.signature && signature
            ? calculateSequenceSimilarity(data.signature, signature)
            : 0;
        const score = Math.max(nameScore, signatureScore);
        if (score >= 70 && score > bestScore) {
            bestScore = score;
            best = {
                symbol: candidate,
                containerName: findContainerName(symbols, candidate),
            };
        }
    }
    return best;
}

// Find the name of the symbol that directly contains `target` in the tree.
function findContainerName(
    symbols: vscode.DocumentSymbol[],
    target: vscode.DocumentSymbol
): string | undefined {
    for (const symbol of symbols) {
        if (symbol.children?.includes(target)) {
            return symbol.name;
        }
        const nested = findContainerName(symbol.children ?? [], target);
        if (nested !== undefined) {
            return nested;
        }
    }
    return undefined;
}

// Priority 3 - Regex Declaration Search: the outline is unusable (e.g. a syntax
// error broke the AST parser), so scan the raw text for a DECLARATION of the
// symbol - restricted to declaration keywords so function CALLS are not
// matched. All source text is regex-escaped before being embedded.
function findSymbolLineByDeclarationRegex(document: vscode.TextDocument, symbolName: string): number | undefined {
    const pattern =
        '(?:function|const|let|var|class|interface|type)\\s+(?:\\w+\\s*)*?' +
        escapeRegExp(symbolName);
    let regex: RegExp;
    try {
        regex = new RegExp(pattern, 'i');
    } catch {
        return undefined;
    }
    const text = document.getText();
    const match = regex.exec(text);
    if (match?.index !== undefined) {
        return countNewlines(text.slice(0, match.index));
    }
    return undefined;
}

// Priority 4 - 70% Raw Text Proximity: scan a bounded chunk of raw lines around
// the originally stored anchor line, reusing the sequence-based similarity.
// Cheap on huge files because only the window is touched.
function findSymbolLineByRawProximity(
    document: vscode.TextDocument,
    data: PointerSearchData
): number | undefined {
    if (!data.signature || !data.symbolStart) {
        return undefined;
    }
    const RADIUS = 100;
    const windowStart = Math.max(0, data.symbolStart.line - RADIUS);
    const windowEnd = Math.min(document.lineCount - 1, data.symbolStart.line + RADIUS);
    let bestLine: number | undefined;
    let bestScore = 0;
    for (let line = windowStart; line <= windowEnd; line++) {
        const score = calculateSequenceSimilarity(data.signature, document.lineAt(line).text);
        if (score >= 70 && score > bestScore) {
            bestScore = score;
            bestLine = line;
        }
    }
    return bestLine;
}

// Resolve a pointer to its current target using the 4-stage pipeline:
//   1. Exact outline match (symbolName + containerName).
//   2. 70% outline sequence match (name or signature).
//   3. Regex declaration search over raw text (when the outline is empty,
//      e.g. because a syntax error broke the AST parser).
//   4. 70% raw-text proximity around the recorded anchor line.
// `symbols` can be passed in to avoid re-querying the symbol provider when
// resolving many pointers from the same document (see the save-time sync).
async function resolvePointerTarget(
    document: vscode.TextDocument,
    data: PointerSearchData,
    symbols?: vscode.DocumentSymbol[]
): Promise<PointerResolution | undefined> {
    if (!data.symbolName) {
        return undefined;
    }

    const outlineSymbols = symbols
        ?? await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );

    if (outlineSymbols && outlineSymbols.length > 0) {
        // Priority 1: exact outline match.
        const exact = findExactSymbol(outlineSymbols, data.symbolName, data.containerName);
        if (exact) {
            return { symbol: exact.symbol, containerName: exact.containerName };
        }

        // Priority 2: 70% outline sequence match.
        const fuzzy = findFuzzySymbol(outlineSymbols, data, document);
        if (fuzzy) {
            return { symbol: fuzzy.symbol, containerName: fuzzy.containerName };
        }
    }

    // Priority 3: regex declaration search (only meaningful when the outline
    // returned nothing, i.e. the AST parser is failing).
    if (!outlineSymbols || outlineSymbols.length === 0) {
        const line = findSymbolLineByDeclarationRegex(document, data.symbolName);
        if (line !== undefined) {
            return { line };
        }
    }

    // Priority 4: raw-text proximity around the anchor line.
    const line = findSymbolLineByRawProximity(document, data);
    if (line !== undefined) {
        return { line };
    }

    return undefined;
}

// Open the referenced file, switch to it, and flash-highlight the target symbol
// so the user lands directly on the pointer's code. The cursor is placed on
// only the first character of the symbol (nothing is selected, so an accidental
// backspace can't delete the code), and a temporary yellow decoration fades out
// after a moment.
async function navigateToCode(data: {
    relativePath?: string;
    symbolName?: string;
    containerName?: string;
    symbolStart?: SymbolPosition;
    signature?: string;
    selectionStart?: SymbolPosition;
}) {
    if (!data?.relativePath || !data.symbolName) {
        return;
    }
    try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder is open, so the pointer cannot be resolved.');
            return;
        }

        // Reconstruct the absolute path from the workspace root.
        const uri = vscode.Uri.file(path.join(workspaceRoot, data.relativePath));

        // Verify the file still exists before opening it.
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            vscode.window.showErrorMessage(`The file for this pointer no longer exists: ${data.relativePath}`);
            return;
        }

        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
        });

        // Resolve the target block with the 4-stage pipeline: exact outline
        // match, 70% outline sequence match, regex declaration search, then
        // 70% raw-text proximity. It gracefully handles code drift and syntax
        // errors that break the AST parser.
        const resolved = await resolvePointerTarget(document, data);

        if (resolved?.symbol) {
            const symbol = resolved.symbol;
            const range = symbol.selectionRange ?? symbol.range;

            // Put the cursor on the first character of the symbol only.
            editor.selection = new vscode.Selection(range.start, range.start);

            // Center the target symbol in the editor.
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

            // Temporary visual flash so the symbol is easy to spot without selecting it.
            const flashDecoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: 'rgba(255, 215, 0, 0.3)',
                isWholeLine: true,
            });
            editor.setDecorations(flashDecoration, [range]);
            setTimeout(() => flashDecoration.dispose(), 1200);
        } else if (resolved?.line !== undefined) {
            jumpToLine(editor, resolved.line);
        } else {
            vscode.window.showWarningMessage(
                `The code for "${data.symbolName}" in ${data.relativePath} could not be located. It may have been renamed or deleted.`
            );
        }
    } catch (error) {
        console.error('Failed to navigate to code:', error);
        vscode.window.showErrorMessage(`Could not open ${data.relativePath}`);
    }
}

// Move the cursor to the start of a line and flash-highlight it so the user
// lands directly on the target without selecting anything.
function jumpToLine(editor: vscode.TextEditor, line: number) {
    const range = new vscode.Range(line, 0, line, 0);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    const flashDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 215, 0, 0.3)',
        isWholeLine: true,
    });
    editor.setDecorations(flashDecoration, [range]);
    setTimeout(() => flashDecoration.dispose(), 1200);
}

// Escape regex metacharacters so source text can be safely embedded in a
// RegExp constructor (the "sanitized" part of the regex searches).
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Count newlines in a prefix of the raw (unstripped) file text, yielding a
// 0-based line number for an offset in ORIGINAL text coordinates.
function countNewlines(text: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            count++;
        }
    }
    return count;
}

// Collapse a source snippet into a compact, whitespace-normalized signature
// (single spaces, trimmed, capped at 200 chars) for storing on pointers.
function collapseText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// A code-pointer shape extracted from the saved canvas snapshot.
interface PointerShapeRecord {
    id: string;
    meta: Record<string, unknown>;
}

// Pull every pointer shape whose meta points at `relativePath` out of a saved
// tldraw snapshot. The snapshot layout is:
//   { document: { store: Record<id, record>, schema }, session }
// where each record has `typeName` and pointer shapes carry
// `meta: { relativePath, symbolName, ... }`. Missing/malformed parts are
// treated as "no pointers" instead of throwing.
function extractPointerShapes(snapshot: unknown, relativePath: string): PointerShapeRecord[] {
    const pointers: PointerShapeRecord[] = [];
    if (!snapshot || typeof snapshot !== 'object') {
        return pointers;
    }
    const store = (snapshot as { document?: { store?: unknown } }).document?.store;
    if (!store || typeof store !== 'object') {
        return pointers;
    }
    for (const record of Object.values(store as Record<string, unknown>)) {
        if (!record || typeof record !== 'object') {
            continue;
        }
        const rec = record as { typeName?: string; id?: string; meta?: unknown };
        if (rec.typeName !== 'shape') {
            continue;
        }
        if (!rec.meta || typeof rec.meta !== 'object') {
            continue;
        }
        const meta = rec.meta as Record<string, unknown>;
        if (meta.relativePath === relativePath && typeof rec.id === 'string') {
            pointers.push({ id: rec.id, meta });
        }
    }
    return pointers;
}

// Build the sanitized meta a pointer should have after a successful 4-stage
// resolution. Only keys that actually exist are set so tldraw's meta validator
// (which rejects `undefined` values) is never tripped. Returns undefined when
// the pointer could not be re-resolved at all.
function buildUpdatedPointerMeta(
    document: vscode.TextDocument,
    oldMeta: Record<string, unknown>,
    resolved: PointerResolution | undefined
): Record<string, unknown> | undefined {
    if (!resolved) {
        return undefined;
    }

    const next: Record<string, unknown> = { ...oldMeta };

    if (resolved.symbol) {
        next.symbolName = resolved.symbol.name;
        if (resolved.containerName !== undefined) {
            next.containerName = resolved.containerName;
        }
        const range = resolved.symbol.selectionRange ?? resolved.symbol.range;
        next.symbolStart = { line: range.start.line, character: range.start.character };
        const signature = getSymbolSignature(document, resolved.symbol);
        if (signature) {
            next.signature = signature;
        }
    } else if (resolved.line !== undefined) {
        // Resolved to a raw line (regex or proximity stage): anchor to the
        // start of that line and refresh the signature from its text.
        const lineText = collapseText(document.lineAt(resolved.line).text);
        next.symbolStart = { line: resolved.line, character: 0 };
        if (lineText) {
            next.signature = lineText;
        }
    }

    // Drop undefined entries so the meta stays JSON-serializable for tldraw.
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
        if (value !== undefined) {
            cleaned[key] = value;
        }
    }
    return cleaned;
}

// Deep-equality check for two pointer meta objects (used to skip no-op
// updates after a save).
function hasPointerMetaChanged(
    oldMeta: Record<string, unknown>,
    newMeta: Record<string, unknown>
): boolean {
    if (Object.keys(oldMeta).length !== Object.keys(newMeta).length) {
        return true;
    }
    for (const key of Object.keys(oldMeta)) {
        if (JSON.stringify(oldMeta[key]) !== JSON.stringify(newMeta[key])) {
            return true;
        }
    }
    return false;
}

// The canvas is persisted to `.archify/canvas.json` inside the workspace so it
// travels with the project. Falls back to the extension's per-workspace storage
// when no folder is open.
function getCanvasFileUri(context: vscode.ExtensionContext): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folder) {
        return vscode.Uri.joinPath(folder, '.archify', 'canvas.json');
    }
    return context.storageUri ? vscode.Uri.joinPath(context.storageUri, 'canvas.json') : undefined;
}

async function saveCanvasFile(uri: vscode.Uri | undefined, snapshot: unknown) {
    if (!uri) return;
    try {
        await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch (error) {
        console.error('Failed to save canvas file:', error);
    }
}

async function readCanvasFile(uri: vscode.Uri | undefined): Promise<unknown | undefined> {
    if (!uri || !existsSync(uri.fsPath)) return undefined;
    try {
        const raw = await fsp.readFile(uri.fsPath, 'utf8');
        return JSON.parse(raw) as unknown;
    } catch (error) {
        console.error('Failed to read canvas file:', error);
        return undefined;
    }
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const buildUri = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'build');
    const distUri = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist');

    let assetRoot = buildUri;
    let scriptFile = 'index.js';
    let styleFile = 'index.css';

    if (!existsSync(buildUri.fsPath) && existsSync(distUri.fsPath)) {
        assetRoot = distUri;
        const distAssetsPath = vscode.Uri.joinPath(distUri, 'assets').fsPath;
        if (existsSync(distAssetsPath)) {
            const files = readdirSync(distAssetsPath);
            const jsFile = files.find(file => /^index.*\.js$/.test(file));
            const cssFile = files.find(file => /^index.*\.css$/.test(file));
            if (jsFile) scriptFile = jsFile;
            if (cssFile) styleFile = cssFile;
        }
    }

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'assets', scriptFile));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'assets', styleFile));
    
    // Create the base URI so local assets don't 404
    const baseUri = webview.asWebviewUri(assetRoot).toString() + '/';

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        
        <!-- FIX 1: Base URL so relative assets don't 404 -->
        <base href="${baseUri}">
        
        <!-- FIX 2: Security Pass to allow tldraw to load its fonts and icons -->
        <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' vscode-webview-resource: data: blob:;">
        
        <link rel="stylesheet" type="text/css" href="${styleUri}">
        <title>Architecture Canvas</title>
        <style>
            html, body { 
                padding: 0; 
                margin: 0; 
                width: 100vw; 
                height: 100vh; 
                overflow: hidden; 
                overscroll-behavior: none;
                background-color: #1e1e1e;
            }
            #root {
                width: 100%;
                height: 100%;
            }
        </style>
    </head>
    <body>
        <div id="root"></div>
        <script type="module" src="${scriptUri}"></script>
    </body>
    </html>`;
}