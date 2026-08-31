# EASY CODE Terminal Integration

This UI extension adds native image paste, click-to-toggle Thinking details, and scroll-safe menu navigation to EASY CODE in the VS Code integrated terminal.

## Scroll-safe menus

When EASY CODE opens a model, plan, or command-approval menu, the extension intercepts unmodified Up and Down only for that active EASY CODE terminal. It sends the navigation action over an authenticated loopback bridge instead of inserting an arrow sequence into the terminal. This keeps VS Code's scrollback viewport in place while the selected option changes.

The bridge is available only to terminals created after extension activation. The extension injects a random launch-scoped token and a loopback endpoint into those terminals, requires a validated hello frame from the EASY CODE process, and enables the arrow keybindings only while that process reports an active menu. Invalid, oversized, unauthenticated, stale, or unrelated connections fail closed. The bridge is removed when the extension deactivates or its terminal closes.

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
▶ Thinking #42 · 315 chars · /thinking 42 · VS Code Ctrl/Cmd+click to toggle
```

An expanded panel includes its own control line, so it can be closed without scrolling back to the original marker:

```text
↕ Thinking #42 · /thinking 42
  VS Code Ctrl/Cmd+click the Thinking label to close
```

The extension makes the first `Thinking #42` span a VS Code terminal link in both forms. Hold the platform modifier while clicking it: by default that is `Ctrl+click` on Windows and Linux, or `Cmd+click` on macOS. Every activation of a current marker, historical marker, or expanded-panel control sends its paired numeric ID back to the same terminal with no trailing newline:

```text
ESC ] 6973 ; easy-code ; toggle-thinking ; 42 BEL
```

Use the same modifier+click action again to toggle the panel closed; there is no separate Esc shortcut. Links are offered while the terminal is tracked as running EASY CODE or after the explicit enable command. If the extension host reloads during an already-running session, only a terminal that existed before activation can recover from a strict paired marker; its next shell start/end event revokes that recovered state. For compatibility, the extension also recognizes the older expanded hints. A collapsed marker or expanded control must use its exact EASY CODE format and repeat the same positive decimal ID after `/thinking`. The link handler is bound to the terminal that supplied the marker and emits only the fixed private OSC sequence above; marker text can never become a shell command.

## Development

```sh
npm install
npm test
npm run package
```

The packaging command produces `easy-code-vscode.vsix` in this directory. Install it with the VS Code command `Extensions: Install from VSIX...`.
