"use strict";

const { clipboardHasImage } = require("./lib/clipboard");
const {
  isEasyCodeCommand,
  isEasyCodePackageScript,
  packageScriptName,
} = require("./lib/command-detection");

const CONTEXT_KEY = "easyCode.imagePasteEnabled";
const PASTE_IMAGE_SEQUENCE = "\x1b]6973;easy-code;paste-image\x07";
const TOGGLE_THINKING_SEQUENCE_PREFIX = "\x1b]6973;easy-code;toggle-thinking;";
// Deprecated compatibility export. New callers should use the toggle name;
// the old symbol deliberately emits the new action as well.
const SHOW_THINKING_SEQUENCE_PREFIX = TOGGLE_THINKING_SEQUENCE_PREFIX;
const THINKING_LINK_PREFIX = "Thinking #";
const THINKING_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

function vscodeApi() {
  // Keep the VS Code host dependency lazy so the protocol parser and link
  // provider can be unit-tested with plain Node.js.
  return require("vscode");
}

/**
 * Parse only EASY CODE's paired collapsed marker or expanded-panel control.
 * Requiring the same decimal ID at both ends prevents an unrelated "Thinking"
 * message from becoming a terminal link.
 *
 * @param {string} line
 * @returns {Array<{ startIndex: number, length: number, id: string }>}
 */
function findThinkingMarkers(line) {
  if (typeof line !== "string") return [];

  const matches = [];
  // This RegExp is deliberately local: VS Code may invoke terminal link
  // providers concurrently, so no mutable global RegExp state is shared.
  const markerPattern = /(?:▶ Thinking #([1-9][0-9]{0,15}) · [^\r\n]*? · \/thinking ([1-9][0-9]{0,15})|↕ Thinking #([1-9][0-9]{0,15}) · Click again to close · \/thinking ([1-9][0-9]{0,15}))(?=$|[ \t])/g;
  for (const match of line.matchAll(markerPattern)) {
    const id = match[1] ?? match[3];
    const pairedId = match[2] ?? match[4];
    if (!id || id !== pairedId || !Number.isSafeInteger(Number(id))) continue;
    matches.push({
      startIndex: match.index + match[0].indexOf(THINKING_LINK_PREFIX),
      length: THINKING_LINK_PREFIX.length + id.length,
      id,
    });
  }
  return matches;
}

/**
 * @param {string | number} id
 */
function toggleThinkingSequence(id) {
  const value = String(id);
  if (
    !THINKING_ID_PATTERN.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new TypeError("EASY CODE thinking IDs must be positive decimal integers.");
  }
  return `${TOGGLE_THINKING_SEQUENCE_PREFIX}${value}\x07`;
}

/**
 * @deprecated Use toggleThinkingSequence. Kept so older extension consumers
 * receive the new toggle action instead of retaining one-way show behavior.
 * @param {string | number} id
 */
function showThinkingSequence(id) {
  return toggleThinkingSequence(id);
}

/**
 * @param {(terminal: import('vscode').Terminal | undefined) => boolean} isEnabled
 * @returns {import('vscode').TerminalLinkProvider}
 */
function createThinkingLinkProvider(isEnabled) {
  // Metadata never comes from a command string and is retained only for link
  // objects created by this provider. A forged object passed to the handler is
  // therefore inert even if it copies visible link properties.
  const linkMetadata = new WeakMap();

  return {
    provideTerminalLinks(context, token) {
      if (token?.isCancellationRequested || !isEnabled(context?.terminal)) return [];
      return findThinkingMarkers(context.line).map((marker) => {
        const link = {
          startIndex: marker.startIndex,
          length: marker.length,
          tooltip: `Toggle EASY CODE Thinking #${marker.id}`,
        };
        linkMetadata.set(link, { id: marker.id, terminal: context.terminal });
        return link;
      });
    },

    handleTerminalLink(link) {
      const metadata = linkMetadata.get(link);
      if (!metadata || !isEnabled(metadata.terminal)) return;
      metadata.terminal.sendText(toggleThinkingSequence(metadata.id), false);
    },
  };
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
  const vscode = vscodeApi();
  /** @type {Map<import('vscode').Terminal, Set<import('vscode').TerminalShellExecution>>} */
  const automaticExecutions = new Map();
  /** @type {Map<import('vscode').Terminal, boolean>} */
  const manualOverrides = new Map();
  /** @type {WeakSet<import('vscode').TerminalShellExecution>} */
  const endedExecutions = new WeakSet();

  const isEnabled = (terminal) => {
    if (!terminal) return false;
    if (manualOverrides.has(terminal)) return manualOverrides.get(terminal) === true;
    return (automaticExecutions.get(terminal)?.size ?? 0) > 0;
  };

  const updateContext = () => {
    void vscode.commands.executeCommand(
      "setContext",
      CONTEXT_KEY,
      isEnabled(vscode.window.activeTerminal),
    );
  };

  const pasteNormally = async () => {
    await vscode.commands.executeCommand("workbench.action.terminal.paste");
  };

  const matchesPackageScript = async (execution) => {
    if (!packageScriptName(execution.commandLine.value) || !execution.cwd) return false;
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(execution.cwd, "package.json"),
      );
      if (bytes.byteLength > 256 * 1024) return false;
      const manifest = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return isEasyCodePackageScript(execution.commandLine.value, manifest);
    } catch {
      return false;
    }
  };

  const trackExecution = async (event) => {
    const execution = event.execution;
    const matches = isEasyCodeCommand(execution.commandLine.value) ||
      await matchesPackageScript(execution);
    if (!matches || endedExecutions.has(execution)) return;
    let executions = automaticExecutions.get(event.terminal);
    if (!executions) {
      executions = new Set();
      automaticExecutions.set(event.terminal, executions);
    }
    executions.add(execution);
    updateContext();
  };

  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider(createThinkingLinkProvider(isEnabled)),
    vscode.window.onDidStartTerminalShellExecution((event) => {
      void trackExecution(event);
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      endedExecutions.add(event.execution);
      const executions = automaticExecutions.get(event.terminal);
      if (!executions?.delete(event.execution)) return;
      if (executions.size === 0) automaticExecutions.delete(event.terminal);
      updateContext();
    }),
    vscode.window.onDidChangeActiveTerminal(updateContext),
    vscode.window.onDidCloseTerminal((terminal) => {
      automaticExecutions.delete(terminal);
      manualOverrides.delete(terminal);
      updateContext();
    }),
    vscode.commands.registerCommand("easyCode.pasteImage", async () => {
      const terminal = vscode.window.activeTerminal;
      if (!terminal || !isEnabled(terminal)) {
        await pasteNormally();
        return;
      }

      // Text wins when the clipboard advertises both rich text and an image
      // representation. This avoids turning an ordinary copied selection into
      // an EASY CODE image marker on Windows and in browsers/editors.
      let clipboardText = "";
      try {
        clipboardText = await vscode.env.clipboard.readText();
      } catch {
        // Continue with the image probe when the clipboard API is unavailable.
      }
      if (vscode.window.activeTerminal !== terminal || !isEnabled(terminal)) {
        return;
      }
      if (clipboardContainsText(clipboardText)) {
        await pasteNormally();
        return;
      }

      let hasImage = false;
      try {
        hasImage = await clipboardHasImage({
          rejectedRoots: (vscode.workspace.workspaceFolders ?? [])
            .filter((folder) => folder.uri.scheme === "file")
            .map((folder) => folder.uri.fsPath),
        });
      } catch {
        // An unavailable clipboard helper must never break ordinary text paste.
      }

      // Never redirect a paste to a different terminal while the asynchronous
      // clipboard probe is running. The user can press paste again in the new
      // terminal instead.
      if (vscode.window.activeTerminal !== terminal || !isEnabled(terminal)) {
        return;
      }

      if (!hasImage) {
        await pasteNormally();
        return;
      }

      terminal.sendText(PASTE_IMAGE_SEQUENCE, false);
    }),
    vscode.commands.registerCommand("easyCode.enableTerminalImagePaste", () => {
      const terminal = vscode.window.activeTerminal;
      if (!terminal) {
        void vscode.window.showWarningMessage("Open an integrated terminal first.");
        return;
      }
      manualOverrides.set(terminal, true);
      updateContext();
      void vscode.window.showInformationMessage(
        "EASY CODE image paste is enabled for the current terminal.",
      );
    }),
    vscode.commands.registerCommand("easyCode.disableTerminalImagePaste", () => {
      const terminal = vscode.window.activeTerminal;
      if (!terminal) {
        void vscode.window.showWarningMessage("Open an integrated terminal first.");
        return;
      }
      manualOverrides.set(terminal, false);
      updateContext();
      void vscode.window.showInformationMessage(
        "EASY CODE image paste is disabled for the current terminal.",
      );
    }),
  );

  updateContext();
}

function deactivate() {
  const vscode = vscodeApi();
  return vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
}

function clipboardContainsText(value) {
  return typeof value === "string" && value.length > 0;
}

module.exports = {
  activate,
  clipboardContainsText,
  createThinkingLinkProvider,
  deactivate,
  findThinkingMarkers,
  PASTE_IMAGE_SEQUENCE,
  showThinkingSequence,
  SHOW_THINKING_SEQUENCE_PREFIX,
  toggleThinkingSequence,
  TOGGLE_THINKING_SEQUENCE_PREFIX,
};
