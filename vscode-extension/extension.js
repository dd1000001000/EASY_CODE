"use strict";

const vscode = require("vscode");

const { clipboardHasImage } = require("./lib/clipboard");
const {
  isEasyCodeCommand,
  isEasyCodePackageScript,
  packageScriptName,
} = require("./lib/command-detection");

const CONTEXT_KEY = "easyCode.imagePasteEnabled";
const PASTE_IMAGE_SEQUENCE = "\x1b]6973;easy-code;paste-image\x07";

/**
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
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
  return vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
}

module.exports = {
  activate,
  deactivate,
  PASTE_IMAGE_SEQUENCE,
};
