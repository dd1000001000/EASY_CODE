"use strict";

const { clipboardHasImage } = require("./lib/clipboard");
const {
  isEasyCodeCommand,
  isEasyCodePackageScript,
  packageScriptName,
} = require("./lib/command-detection");
const {
  chooseTerminalForClient,
  createMenuNavigationServer,
  DISCLOSURE_TOGGLE_CAPABILITY,
} = require("./lib/menu-navigation-bridge");
const { createTerminalPasteQueue } = require("./lib/paste-command-queue");

const CONTEXT_KEY = "easyCode.imagePasteEnabled";
const MENU_NAVIGATION_CONTEXT_KEY = "easyCode.menuNavigationEnabled";
const BRIDGE_ENDPOINT_ENV = "EASY_CODE_VSCODE_BRIDGE_ENDPOINT";
const BRIDGE_TOKEN_ENV = "EASY_CODE_VSCODE_BRIDGE_TOKEN";
const PASTE_IMAGE_SEQUENCE = "\x1b]6973;easy-code;paste-image\x07";
const TOGGLE_THINKING_SEQUENCE_PREFIX = "\x1b]6973;easy-code;toggle-thinking;";
const TOGGLE_ADJUSTMENT_SEQUENCE_PREFIX = "\x1b]6973;easy-code;toggle-adjustment;";
// Deprecated compatibility export. New callers should use the toggle name;
// the old symbol deliberately emits the new action as well.
const SHOW_THINKING_SEQUENCE_PREFIX = TOGGLE_THINKING_SEQUENCE_PREFIX;
const THINKING_LINK_PREFIX = "Thinking #";
const ADJUSTMENT_LINK_PREFIX = "Queued adjustment #";
const THINKING_ID_PATTERN = /^[1-9][0-9]{0,15}$/;
let activeBridgeRuntime;

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
  // These RegExps are deliberately local: VS Code may invoke terminal link
  // providers concurrently, so no mutable global RegExp state is shared.
  const markerPatterns = [
    /▶ Thinking #([1-9][0-9]{0,15}) · [^\r\n]*? · \/thinking ([1-9][0-9]{0,15})(?=$|[ \t])/g,
    /↕ Thinking #([1-9][0-9]{0,15}) · \/thinking ([1-9][0-9]{0,15})(?=$|[ \t])/g,
    /↕ Thinking #([1-9][0-9]{0,15}) · (?:Ctrl\/Cmd\+click|Click again) to close · \/thinking ([1-9][0-9]{0,15})(?=$|[ \t])/g,
  ];
  for (const markerPattern of markerPatterns) {
    for (const match of line.matchAll(markerPattern)) {
      const id = match[1];
      const pairedId = match[2];
      if (!id || id !== pairedId || !Number.isSafeInteger(Number(id))) continue;
      matches.push({
        startIndex: match.index + match[0].indexOf(THINKING_LINK_PREFIX),
        length: THINKING_LINK_PREFIX.length + id.length,
        id,
      });
    }
  }
  return matches.sort((left, right) => left.startIndex - right.startIndex);
}

/**
 * Parse only paired EASY CODE queued-adjustment controls. The numeric ID is
 * repeated after `/adjustment`, so arbitrary terminal output cannot forge a
 * clickable control by mentioning the visible label alone.
 *
 * @param {string} line
 * @returns {Array<{ startIndex: number, length: number, id: string, kind: "adjustment" }>}
 */
function findAdjustmentMarkers(line) {
  if (typeof line !== "string") return [];
  const matches = [];
  const markerPatterns = [
    /▶ Queued adjustment #([1-9][0-9]{0,15}) · [^\r\n]*? · \/adjustment ([1-9][0-9]{0,15})(?=$|[ \t])/g,
    /↕ Queued adjustment #([1-9][0-9]{0,15}) · [^\r\n]*?\/adjustment ([1-9][0-9]{0,15})(?=$|[ \t])/g,
  ];
  for (const markerPattern of markerPatterns) {
    for (const match of line.matchAll(markerPattern)) {
      const id = match[1];
      const pairedId = match[2];
      if (!id || id !== pairedId || !Number.isSafeInteger(Number(id))) continue;
      matches.push({
        startIndex: match.index + match[0].indexOf(ADJUSTMENT_LINK_PREFIX),
        length: ADJUSTMENT_LINK_PREFIX.length + id.length,
        id,
        kind: "adjustment",
      });
    }
  }
  return matches.sort((left, right) => left.startIndex - right.startIndex);
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

/** @param {string | number} id */
function toggleAdjustmentSequence(id) {
  const value = String(id);
  if (
    !THINKING_ID_PATTERN.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new TypeError("EASY CODE adjustment IDs must be positive decimal integers.");
  }
  return `${TOGGLE_ADJUSTMENT_SEQUENCE_PREFIX}${value}\x07`;
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
 * @param {(terminal: import('vscode').Terminal) => boolean} [tryRecover]
 * @param {(terminal: import('vscode').Terminal, kind: "thinking" | "adjustment", id: number) => boolean} [dispatchToggle]
 * @returns {import('vscode').TerminalLinkProvider}
 */
function createThinkingLinkProvider(
  isEnabled,
  tryRecover = () => false,
  dispatchToggle = () => false,
) {
  // Metadata never comes from a command string and is retained only for link
  // objects created by this provider. A forged object passed to the handler is
  // therefore inert even if it copies visible link properties.
  const linkMetadata = new WeakMap();

  return {
    provideTerminalLinks(context, token) {
      const terminal = context?.terminal;
      if (token?.isCancellationRequested || !terminal) return [];
      const markers = [
        ...findThinkingMarkers(context.line).map((marker) => ({
          ...marker,
          kind: "thinking",
        })),
        ...findAdjustmentMarkers(context.line),
      ].sort((left, right) => left.startIndex - right.startIndex);
      if (!markers.length) return [];
      if (!isEnabled(terminal) && !tryRecover(terminal)) return [];
      return markers.map((marker) => {
        const link = {
          startIndex: marker.startIndex,
          length: marker.length,
          tooltip: marker.kind === "adjustment"
            ? `Ctrl/Cmd+click to toggle EASY CODE queued adjustment #${marker.id}`
            : `Ctrl/Cmd+click to toggle EASY CODE Thinking #${marker.id}`,
        };
        linkMetadata.set(link, {
          id: marker.id,
          kind: marker.kind,
          terminal: context.terminal,
        });
        return link;
      });
    },

    handleTerminalLink(link) {
      const metadata = linkMetadata.get(link);
      if (!metadata || !isEnabled(metadata.terminal)) return;
      try {
        if (dispatchToggle(
          metadata.terminal,
          metadata.kind,
          Number(metadata.id),
        )) {
          return;
        }
      } catch {
        // Mixed installations and a transient bridge failure retain the
        // legacy PTY path. It can move scrollback, but never loses the toggle.
      }
      metadata.terminal.sendText(
        metadata.kind === "adjustment"
          ? toggleAdjustmentSequence(metadata.id)
          : toggleThinkingSequence(metadata.id),
        false,
      );
    },
  };
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
async function activate(context) {
  const vscode = vscodeApi();
  // A development-host reload can invoke activate again without waiting for
  // the prior async teardown. Remove its endpoint before publishing a new one
  // so the old runtime cannot delete the replacement environment variables.
  activeBridgeRuntime?.dispose();
  activeBridgeRuntime = undefined;
  /** @type {Map<import('vscode').Terminal, Set<import('vscode').TerminalShellExecution>>} */
  const automaticExecutions = new Map();
  /** @type {Map<import('vscode').Terminal, boolean>} */
  const manualOverrides = new Map();
  /** @type {WeakSet<import('vscode').TerminalShellExecution>} */
  const endedExecutions = new WeakSet();
  // Only terminals that predate this extension-host activation can recover a
  // missed EASY CODE start event. New terminals must pass normal execution
  // tracking, which prevents arbitrary marker text from enabling the channel.
  /** @type {Set<import('vscode').Terminal>} */
  const recoveryCandidates = new Set(vscode.window.terminals);
  /** @type {Set<import('vscode').Terminal>} */
  const recoveredTerminals = new Set();
  /** @type {Map<import('vscode').Terminal, Set<object>>} */
  const clientsByTerminal = new Map();
  let navigationBridge;
  let reconcileQueue = Promise.resolve();
  let contextUpdateQueue = Promise.resolve();
  const pasteQueue = createTerminalPasteQueue();

  const isEnabled = (terminal) => {
    if (!terminal) return false;
    if (manualOverrides.has(terminal)) return manualOverrides.get(terminal) === true;
    return (automaticExecutions.get(terminal)?.size ?? 0) > 0 ||
      recoveredTerminals.has(terminal);
  };

  // The manual override is explicitly an image-paste preference. Disabling
  // image paste must not reintroduce VS Code's approval-menu scroll jump while
  // an EASY CODE execution is still tracked.
  const isBridgeEligible = (terminal) => {
    if (!terminal) return false;
    return (automaticExecutions.get(terminal)?.size ?? 0) > 0 ||
      recoveredTerminals.has(terminal) ||
      manualOverrides.get(terminal) === true;
  };

  const hasActiveMenu = (terminal) => {
    if (!terminal) return false;
    return [...(clientsByTerminal.get(terminal) ?? [])].some((client) =>
      client.authenticated && client.menuActive && !client.socket.destroyed
    );
  };

  const updateContext = () => {
    const imagePasteEnabled = isEnabled(vscode.window.activeTerminal);
    const menuNavigationEnabled = hasActiveMenu(vscode.window.activeTerminal);
    // Preserve state-transition order. An older async setContext completion
    // must never re-enable key interception after a menu has already closed.
    contextUpdateQueue = contextUpdateQueue
      .catch(() => {})
      .then(() => Promise.all([
        vscode.commands.executeCommand(
          "setContext",
          CONTEXT_KEY,
          imagePasteEnabled,
        ),
        vscode.commands.executeCommand(
          "setContext",
          MENU_NAVIGATION_CONTEXT_KEY,
          menuNavigationEnabled,
        ),
      ]))
      .then(() => undefined);
    return contextUpdateQueue;
  };

  const detachClient = (client) => {
    const terminal = client.terminal;
    if (!terminal) return;
    const clients = clientsByTerminal.get(terminal);
    clients?.delete(client);
    if (clients?.size === 0) clientsByTerminal.delete(terminal);
    client.terminal = undefined;
  };

  const attachClient = (client, terminal) => {
    if (client.terminal === terminal) return;
    detachClient(client);
    if (!terminal) return;
    let clients = clientsByTerminal.get(terminal);
    if (!clients) {
      clients = new Set();
      clientsByTerminal.set(terminal, clients);
    }
    clients.add(client);
    client.terminal = terminal;
  };

  const reconcileClients = () => {
    reconcileQueue = reconcileQueue
      .catch(() => {})
      .then(async () => {
        if (!navigationBridge) return;
        for (const client of navigationBridge.clients) {
          if (!client.authenticated) continue;
          const terminal = await chooseTerminalForClient(
            client,
            vscode.window.terminals,
            isBridgeEligible,
            vscode.window.activeTerminal,
          );
          attachClient(client, terminal);
        }
        await updateContext();
      });
    return reconcileQueue;
  };

  const acknowledgeMenuState = async (client, active, requestId) => {
    if (!active) {
      await updateContext();
      return;
    }
    if (!client.terminal) await reconcileClients();
    else await updateContext();

    const bridge = navigationBridge;
    if (
      !bridge ||
      !Number.isSafeInteger(requestId) ||
      requestId <= 0 ||
      !client.authenticated ||
      !client.menuActive ||
      client.menuRequestId !== requestId ||
      client.socket.destroyed
    ) {
      return;
    }
    // `setContext` above has completed before this acknowledgement is sent.
    // Therefore a true response guarantees that VS Code owns Up/Down before
    // the CLI makes the menu visible. A false response tells the CLI to use
    // its already-active Raw TTY input path.
    const ready = Boolean(
      client.terminal &&
      client.terminal === vscode.window.activeTerminal &&
      hasActiveMenu(client.terminal),
    );
    bridge.send(client, { type: "menu-ready", requestId, ready });
  };

  const closeTerminalClients = (terminal) => {
    if (!navigationBridge) return;
    for (const client of [...(clientsByTerminal.get(terminal) ?? [])]) {
      navigationBridge.closeClient(client);
    }
    clientsByTerminal.delete(terminal);
  };

  const navigateActiveMenu = (direction) => {
    const terminal = vscode.window.activeTerminal;
    if (!terminal || !navigationBridge) return;
    const clients = [...(clientsByTerminal.get(terminal) ?? [])]
      .filter((client) => client.authenticated && client.menuActive)
      .sort((left, right) => right.lastActivity - left.lastActivity);
    const client = clients[0];
    if (!client || !navigationBridge.send(client, { type: "navigate", direction })) {
      updateContext();
    }
  };

  const dispatchDisclosureToggle = (terminal, kind, id) => {
    const bridge = navigationBridge;
    if (!bridge || !terminal || !Number.isSafeInteger(id) || id <= 0) {
      return false;
    }
    const clients = [...(clientsByTerminal.get(terminal) ?? [])]
      .filter((client) =>
        client.authenticated &&
        client.capabilities?.has(DISCLOSURE_TOGGLE_CAPABILITY) &&
        !client.socket.destroyed &&
        client.socket.writable
      )
      .sort((left, right) => right.lastActivity - left.lastActivity);
    const client = clients[0];
    if (!client) return false;
    return bridge.send(client, {
      type: "toggle-disclosure",
      kind,
      id,
    });
  };

  const tryRecover = (terminal) => {
    if (
      !recoveryCandidates.has(terminal) ||
      manualOverrides.get(terminal) === false
    ) {
      return false;
    }
    recoveredTerminals.add(terminal);
    updateContext();
    return true;
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
    void reconcileClients();
  };

  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider(
      createThinkingLinkProvider(
        isEnabled,
        tryRecover,
        dispatchDisclosureToggle,
      ),
    ),
    vscode.window.onDidStartTerminalShellExecution((event) => {
      recoveryCandidates.delete(event.terminal);
      recoveredTerminals.delete(event.terminal);
      updateContext();
      void trackExecution(event);
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      endedExecutions.add(event.execution);
      recoveryCandidates.delete(event.terminal);
      recoveredTerminals.delete(event.terminal);
      const executions = automaticExecutions.get(event.terminal);
      if (executions?.delete(event.execution) && executions.size === 0) {
        automaticExecutions.delete(event.terminal);
      }
      updateContext();
      void reconcileClients();
    }),
    vscode.window.onDidChangeActiveTerminal(() => {
      updateContext();
      void reconcileClients();
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      closeTerminalClients(terminal);
      automaticExecutions.delete(terminal);
      manualOverrides.delete(terminal);
      recoveryCandidates.delete(terminal);
      recoveredTerminals.delete(terminal);
      updateContext();
    }),
    vscode.commands.registerCommand("easyCode.navigateMenuUp", () => {
      navigateActiveMenu("up");
    }),
    vscode.commands.registerCommand("easyCode.navigateMenuDown", () => {
      navigateActiveMenu("down");
    }),
    vscode.commands.registerCommand("easyCode.pasteImage", async () => {
      const terminal = vscode.window.activeTerminal;
      if (!terminal || !isEnabled(terminal)) {
        await pasteNormally();
        return;
      }

      await pasteQueue.enqueue(terminal, async () => {
        // A queued command remains bound to the terminal that owned the key
        // press. If focus changed while an earlier paste was running, discard
        // this invocation instead of redirecting it into the new terminal.
        if (vscode.window.activeTerminal !== terminal || !isEnabled(terminal)) {
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
      });
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

  navigationBridge = createMenuNavigationServer({
    onHello: () => {
      void reconcileClients();
    },
    onMenuState: (client, active, requestId) => {
      void acknowledgeMenuState(client, active, requestId).catch(() => {
        // The CLI has a bounded Raw TTY fallback when VS Code cannot install
        // the keybinding context, so never turn a host API failure into an
        // unhandled extension-host rejection.
      });
    },
    onDisconnect: (client) => {
      detachClient(client);
      updateContext();
    },
    onServerError: () => {
      // Fail closed: tear down the channel, revoke inherited credentials, and
      // let VS Code handle arrows normally.
      const failedBridge = navigationBridge;
      navigationBridge = undefined;
      failedBridge?.dispose();
      clientsByTerminal.clear();
      context.environmentVariableCollection.delete(BRIDGE_ENDPOINT_ENV);
      context.environmentVariableCollection.delete(BRIDGE_TOKEN_ENV);
      void vscode.commands.executeCommand(
        "setContext",
        MENU_NAVIGATION_CONTEXT_KEY,
        false,
      );
    },
  });
  try {
    const endpoint = await navigationBridge.listen();
    context.environmentVariableCollection.description =
      "Authenticated local menu navigation bridge for EASY CODE terminals.";
    context.environmentVariableCollection.replace(BRIDGE_ENDPOINT_ENV, endpoint);
    context.environmentVariableCollection.replace(BRIDGE_TOKEN_ENV, navigationBridge.token);
  } catch {
    navigationBridge?.dispose();
    navigationBridge = undefined;
    context.environmentVariableCollection.delete(BRIDGE_ENDPOINT_ENV);
    context.environmentVariableCollection.delete(BRIDGE_TOKEN_ENV);
  }

  const bridgeRuntime = {
    dispose() {
      if (activeBridgeRuntime === bridgeRuntime) activeBridgeRuntime = undefined;
      navigationBridge?.dispose();
      navigationBridge = undefined;
      clientsByTerminal.clear();
      context.environmentVariableCollection.delete(BRIDGE_ENDPOINT_ENV);
      context.environmentVariableCollection.delete(BRIDGE_TOKEN_ENV);
      void vscode.commands.executeCommand(
        "setContext",
        MENU_NAVIGATION_CONTEXT_KEY,
        false,
      );
    },
  };
  activeBridgeRuntime = bridgeRuntime;
  context.subscriptions.push(bridgeRuntime);
  updateContext();
}

async function deactivate() {
  const vscode = vscodeApi();
  activeBridgeRuntime?.dispose();
  activeBridgeRuntime = undefined;
  await Promise.all([
    vscode.commands.executeCommand("setContext", CONTEXT_KEY, false),
    vscode.commands.executeCommand("setContext", MENU_NAVIGATION_CONTEXT_KEY, false),
  ]);
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
  findAdjustmentMarkers,
  PASTE_IMAGE_SEQUENCE,
  showThinkingSequence,
  SHOW_THINKING_SEQUENCE_PREFIX,
  toggleThinkingSequence,
  toggleAdjustmentSequence,
  TOGGLE_THINKING_SEQUENCE_PREFIX,
  TOGGLE_ADJUSTMENT_SEQUENCE_PREFIX,
  BRIDGE_ENDPOINT_ENV,
  BRIDGE_TOKEN_ENV,
  MENU_NAVIGATION_CONTEXT_KEY,
};
