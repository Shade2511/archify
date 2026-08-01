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
                        // Migrate any legacy absolute pointer paths to workspace-relative
                        // paths so the committed canvas stays portable across machines.
                        if (migrateSnapshotPaths(snapshot)) {
                            await saveCanvasFile(getCanvasFileUri(context), snapshot);
                        }
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
    let pointerDisposable = vscode.commands.registerCommand('archify.MakePointer', () => {
        const editor = vscode.window.activeTextEditor;

        if (editor) {
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            if (selectedText) {
                // Your custom preview logic
                const words = selectedText.trim().split(/\s+/);
                let preview: string;
                if (words.length <= 6) {
                    preview = words.join(" ");
                } else {
                    preview = `${words.slice(0, 3).join(" ")} ... ${words.slice(-3).join(" ")}`;
                }

                // Pack the data. Store a workspace-relative path so the canvas
                // file can be committed to the repo and works on any machine.
                // Files outside the workspace fall back to their absolute path.
                const data = {
                    filePath: vscode.workspace.asRelativePath(editor.document.uri),
                    startLine: selection.start.line + 1,
                    endLine: selection.end.line + 1,
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
                
            } else {
                vscode.window.showWarningMessage('Please highlight some code first!');
            }
        }
    });

    // Push both of your commands to the subscriptions list
    context.subscriptions.push(webviewDisposable, pointerDisposable);
}

export function deactivate() {}

// Resolve a stored pointer path to a file URI. New pointers are stored
// workspace-relative (e.g. "src/foo.ts") so the canvas is portable; legacy
// pointers store absolute paths. Both are handled here.
function resolvePointerUri(storedPath: string): vscode.Uri | undefined {
    if (path.isAbsolute(storedPath)) {
        return vscode.Uri.file(storedPath);
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
        return undefined;
    }
    return vscode.Uri.joinPath(folder, storedPath);
}

// Open the referenced file, switch to it, and highlight/reveal the selected line
// range so the user lands directly on the pointer's code.
async function navigateToCode(data: { filePath?: string; startLine?: number; endLine?: number }) {
    if (!data?.filePath || typeof data.startLine !== 'number') {
        return;
    }
    try {
        const uri = resolvePointerUri(data.filePath);
        if (!uri) {
            vscode.window.showErrorMessage(`Could not locate the file for this pointer: ${data.filePath}`);
            return;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
        });
        const start = new vscode.Position(Math.max(0, data.startLine - 1), 0);
        const end = new vscode.Position(Math.max(0, (data.endLine ?? data.startLine) - 1), 0);
        const range = new vscode.Range(start, end);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch (error) {
        console.error('Failed to navigate to code:', error);
        vscode.window.showErrorMessage(`Could not open ${data.filePath}`);
    }
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

// Rewrite any pointer shapes whose meta.filePath is an absolute path that lives
// inside the current workspace so it is stored workspace-relative. Returns true
// if anything changed (so the migrated canvas can be written back to disk).
function migrateSnapshotPaths(snapshot: unknown): boolean {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
        return false;
    }
    const root = folder.fsPath;
    const record = snapshot as {
        document?: { shapes?: Array<{ meta?: { filePath?: unknown } }> };
    };
    const shapes = record?.document?.shapes;
    if (!Array.isArray(shapes)) {
        return false;
    }
    let changed = false;
    for (const shape of shapes) {
        const meta = shape?.meta;
        const filePath = meta?.filePath;
        if (!meta || typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
            continue;
        }
        const relative = path.relative(root, filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            continue;
        }
        meta.filePath = relative.split(path.sep).join('/');
        changed = true;
    }
    return changed;
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