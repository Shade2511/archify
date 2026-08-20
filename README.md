# Archify

Archify turns your codebase into an interactive architecture map. Select code in any file, drop it onto a canvas as a pointer, and build a living diagram that stays in sync with your work — then jump back to the source with a single click.

## Tech Stack

- **VS Code Extension API** (`^1.125.0`) — core host-side logic, symbol provider, webview panel, file I/O
- **React 19** (`^19.2.7`) — webview UI rendering
- **tldraw 5** (`@tldraw/tldraw ^5.2.5`) — interactive canvas (pointer shapes are tldraw `geo` shapes with metadata stored in shape `meta`)
- **Vite 8** + `@vitejs/plugin-react` — webview build tooling
- **TypeScript 6** — both host and webview code
- **esbuild** — extension host bundling (`dist/extension.js`)

## Features

- **Canvas-based architecture mapping**: An interactive whiteboard (powered by tldraw) rendered in a VS Code webview.
- **One-click code pointers**: Highlight any selection in the editor and run **Archify: Make Pointer** to pin it to the canvas. Each pointer is a tldraw `geo` shape (ellipse) that stores the workspace-relative file path, symbol name, container name (e.g. the class wrapping a method), symbol start position, and a compact whitespace-normalized source signature.
- **Symbol-aware resolution**: Pointers resolve the selected code through VS Code's `DocumentSymbolProvider`, walking the symbol tree to find the innermost symbol intersecting the selection. Falls back to the highlighted text (first 8 words) when no symbol matches.
- **Navigate back to code**: Click any pointer shape on the canvas to open the referenced file, center on the symbol, and flash-highlight it with a temporary gold background decoration.
- **Code-drift resilience**: When code moves or is renamed, pointers still find their target via a 4-stage resolution pipeline (all Levenshtein-based comparisons are normalized to lowercase, whitespace-collapsed strings):
  1. **Exact outline match** — symbol name + container name
  2. **70% fuzzy sequence match** against the document outline (Levenshtein edit-distance ratio)
  3. **Regex declaration search** over the raw text (restricted to declaration keywords so calls aren't matched; runs only when the outline is empty)
  4. **70% raw-text proximity** around the originally recorded line (±100 line window)
- **Auto-sync on save**: Saving a file re-resolves every pointer that references it against the fresh document and pushes the updated metadata to the webview, so visible canvas labels refresh in place.
- **Project-persistent canvas**: The full tldraw snapshot is saved to `.archify/canvas.json` in the workspace root (falls back to extension storageUri when no folder is open).
- **Queued pointer delivery**: Selections made before the canvas finishes loading are queued and flushed as soon as the webview signals readiness.
- **Self-healing webview**: A React error boundary catches render crashes; webview errors surface a one-click reload action; the panel retains its state when hidden (`retainContextWhenHidden: true`).

## Usage

1. Open the architecture canvas with **Archify: Open Webview** (or from the editor context menu).
2. Select code in any file, right-click, and choose **Archify: Make Pointer**.
3. Position the pointer shapes on the canvas to document your architecture.
4. Click a pointer to jump straight to the referenced code.

## Requirements

No special requirements. Archify works with any language — the pointer references are resolved via VS Code's built-in symbol provider and fall back to plain text matching when unavailable.

## Extension Settings

This extension does not currently contribute any settings.

## Known Issues

None at this time.

## Release Notes

### 0.0.1

Initial release: canvas-based architecture mapping with tldraw 5, symbol-aware code pointers, source navigation with flash-highlight decoration, 4-stage Levenshtein-based code-drift resolution, save-time pointer sync, and project-persistent canvas storage.

---

## For more information

- Report issues and request features at the [GitHub repository](https://github.com/Shade2511/archify).
