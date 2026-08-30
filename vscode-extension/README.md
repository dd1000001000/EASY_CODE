# EASY CODE Terminal Integration

This UI extension adds native image paste and click-to-toggle Thinking details to EASY CODE in the VS Code integrated terminal.

## Image paste

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

It never sends image bytes through the terminal.

## Thinking toggles

EASY CODE can print a collapsed marker such as:

```text
▶ Thinking #42 · completed in 1.2s · /thinking 42
```

An expanded panel includes its own control line, so it can be closed without scrolling back to the original marker:

```text
↕ Thinking #42 · Click again to close · /thinking 42
```

The extension makes the first `Thinking #42` span clickable in both forms. Every activation of a current marker, historical marker, or expanded-panel control sends its paired numeric ID back to the same terminal with no trailing newline:

```text
ESC ] 6973 ; easy-code ; toggle-thinking ; 42 BEL
```

Click the same link again to toggle the panel closed; there is no separate Esc shortcut. Terminal links are offered only while that terminal is identified as an EASY CODE terminal through shell execution tracking or the explicit enable command. A collapsed marker or expanded control must use its exact EASY CODE format and repeat the same positive decimal ID after `/thinking`. The link handler emits only the fixed private OSC sequence above; marker text can never become a shell command.

## Development

```sh
npm install
npm test
npm run package
```

The packaging command produces `easy-code-vscode.vsix` in this directory. Install it with the VS Code command `Extensions: Install from VSIX...`.
