# Archify

Archify turns your codebase into an interactive architecture map. Select code in any file, drop it onto a canvas as a pointer, and build a living diagram that stays in sync with your work — then jump back to the source with a single click.

## Features

- **Canvas-based architecture mapping**: An interactive whiteboard (powered by tldraw) rendered in a VS Code webview.
- **One-click code pointers**: Highlight any selection in the editor and run **Archify: Make Pointer** to pin it to the canvas, along with its file path and line range.
- **Navigate back to code**: Click any pointer shape on the canvas to open the referenced file and reveal the exact selection in the editor.
- **Project-persistent canvas**: Your diagram is automatically saved to `.archify/canvas.json` in the workspace, so it travels with the project and is restored every time the webview opens.
- **Queued pointer delivery**: Selections made before the canvas finishes loading are delivered as soon as the webview is ready.

## Usage

1. Open the architecture canvas with **Archify: Open Webview** (or from the editor context menu).
2. Select code in any file, right-click, and choose **Archify: Make Pointer**.
3. Position the pointer shapes on the canvas to document your architecture.
4. Click a pointer to jump straight to the referenced code.

## Requirements

No special requirements. Archify works with any language — the pointer references are plain text selections tied to file paths and line numbers.

## Extension Settings

This extension does not currently contribute any settings.

## Known Issues

None at this time.

## Release Notes

### 0.0.1

Initial release: canvas-based architecture mapping, code pointers, source navigation, and project-persistent canvas storage.

---

## For more information

- Report issues and request features at the [GitHub repository](https://github.com/Shade2511/archify).
