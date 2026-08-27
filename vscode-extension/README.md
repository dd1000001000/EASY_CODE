# EASY CODE Image Paste

This UI extension lets the VS Code integrated terminal notify EASY CODE when the system clipboard contains an image. It never sends image bytes through the terminal.

## Behavior

- Windows: `Ctrl+V`
- Linux: `Ctrl+Shift+V`
- macOS: `Command+V`

The extension only overrides these keys while the active integrated terminal is running `easy-code`. It uses VS Code shell integration execution start/end events to track that state. If the clipboard contains ordinary text, the extension immediately delegates to VS Code's native terminal paste command.

If shell integration is unavailable or EASY CODE was already running when the extension activated, use one of these Command Palette commands:

- `EASY CODE: Enable Image Paste for Current Terminal`
- `EASY CODE: Disable Image Paste for Current Terminal`

Image detection runs locally because this extension has `extensionKind: ["ui"]`. It invokes an operating-system clipboard helper without a shell:

- Windows PowerShell and `Clipboard.ContainsImage()`
- macOS `/usr/bin/osascript` and `clipboard info`
- Linux `wl-paste --list-types`, with `xclip` as a fallback

When an image is present, the extension sends only this fixed control sequence to EASY CODE:

```text
ESC ] 6973 ; easy-code ; paste-image BEL
```

## Development

```sh
npm install
npm test
npm run package
```

The packaging command produces `easy-code-vscode.vsix` in this directory. Install it with the VS Code command `Extensions: Install from VSIX...`.
