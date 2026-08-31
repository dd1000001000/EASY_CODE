import { createConnection, type Socket } from "node:net";

import type {
  MenuNavigationDirection,
  MenuSelectorNavigationActivation,
  MenuSelectorNavigation,
} from "./menu-selector.js";

export const VSCODE_BRIDGE_ENDPOINT_ENV =
  "EASY_CODE_VSCODE_BRIDGE_ENDPOINT";
export const VSCODE_BRIDGE_TOKEN_ENV = "EASY_CODE_VSCODE_BRIDGE_TOKEN";

const MAX_FRAME_CHARS = 16 * 1024;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const ENDPOINT_PATTERN = /^127\.0\.0\.1:([1-9]\d{0,4})$/u;
const BRIDGE_PROTOCOL_VERSION = 2;
export const VSCODE_DISCLOSURE_TOGGLE_CAPABILITY = "disclosure-toggle-v1";
const DEFAULT_LEGACY_FALLBACK_MS = 300;
const DEFAULT_READY_ACK_TIMEOUT_MS = 2_000;

interface BridgeIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly cwd: string;
}

interface BridgeSocket extends Socket {}

export interface VsCodeMenuBridgeOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly identity?: Readonly<BridgeIdentity>;
  readonly connect?: (port: number) => BridgeSocket;
  /** Test/compatibility override for extensions that predate ready ACKs. */
  readonly legacyFallbackMs?: number;
  /** Upper bound for a negotiated extension to install its key binding. */
  readonly readyAckTimeoutMs?: number;
}

interface PendingActivation {
  readonly id: number;
  readonly ready: Promise<boolean>;
  readonly resolve: (ready: boolean) => void;
  settled: boolean;
  fallbackTimer?: ReturnType<typeof setTimeout>;
}

export type VsCodeDisclosureKind = "thinking" | "adjustment";

/**
 * A local, authenticated side channel for menu navigation in VS Code.
 *
 * VS Code/xterm scrolls its viewport before a real Up/Down key reaches the
 * PTY. The bundled extension consumes those two keys and sends navigation on
 * this channel instead. Only selection movement is accepted here; approval
 * confirmation deliberately remains on the terminal input path.
 */
export class VsCodeMenuBridge implements MenuSelectorNavigation {
  private readonly listeners = new Set<
    (direction: MenuNavigationDirection) => void
  >();
  private readonly disclosureListeners = new Set<
    (kind: VsCodeDisclosureKind, id: number) => void
  >();
  private socket?: BridgeSocket;
  private inputBuffer = "";
  private connected = false;
  private active = false;
  private closed = false;
  private protocolReady = false;
  private nextActivationId = 1;
  private activation?: PendingActivation;

  constructor(
    private readonly endpointPort: number,
    private readonly token: string,
    private readonly identity: Readonly<BridgeIdentity>,
    connect: (port: number) => BridgeSocket = defaultConnect,
    private readonly legacyFallbackMs = DEFAULT_LEGACY_FALLBACK_MS,
    private readonly readyAckTimeoutMs = DEFAULT_READY_ACK_TIMEOUT_MS,
  ) {
    try {
      const socket = connect(endpointPort);
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.setNoDelay?.(true);
      socket.unref?.();
      socket.on("connect", this.onConnect);
      socket.on("data", this.onData);
      socket.on("error", this.onError);
      socket.on("close", this.onClose);
    } catch {
      this.socket = undefined;
    }
  }

  activate(
    onNavigate: (direction: MenuNavigationDirection) => void,
  ): MenuSelectorNavigationActivation {
    if (this.closed) {
      return { ready: Promise.resolve(false), release: () => undefined };
    }
    this.listeners.add(onNavigate);
    if (!this.active) {
      this.active = true;
      this.activation = this.createActivation();
      this.sendMenuState(true);
      this.armActivationFallback();
    }
    const activation = this.activation;
    let released = false;
    return {
      ready: activation?.ready ?? Promise.resolve(false),
      release: () => {
        if (released) return;
        released = true;
        this.listeners.delete(onNavigate);
        if (this.listeners.size === 0 && this.active) {
          this.active = false;
          this.sendMenuState(false);
          this.settleActivation(false);
          this.activation = undefined;
        }
      },
    };
  }

  /**
   * Receive a terminal-link toggle without injecting bytes into the PTY.
   * Unlike menu navigation this channel stays active outside modal selectors.
   */
  onDisclosureToggle(
    listener: (kind: VsCodeDisclosureKind, id: number) => void,
  ): () => void {
    if (this.closed) return () => undefined;
    this.disclosureListeners.add(listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.disclosureListeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    if (this.active) this.sendMenuState(false);
    this.closed = true;
    this.active = false;
    this.settleActivation(false);
    this.activation = undefined;
    this.listeners.clear();
    this.disclosureListeners.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.removeListener("connect", this.onConnect);
    socket.removeListener("data", this.onData);
    socket.removeListener("error", this.onError);
    socket.removeListener("close", this.onClose);
    socket.destroy();
  }

  private readonly onConnect = (): void => {
    if (this.closed) return;
    this.connected = true;
    this.protocolReady = false;
    this.send({
      type: "hello",
      token: this.token,
      pid: this.identity.pid,
      ppid: this.identity.ppid,
      cwd: this.identity.cwd,
      protocol: BRIDGE_PROTOCOL_VERSION,
      capabilities: [VSCODE_DISCLOSURE_TOGGLE_CAPABILITY],
    });
    if (this.active) {
      this.sendMenuState(true);
      this.clearActivationFallback();
      this.armActivationFallback();
    }
  };

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    this.inputBuffer += chunk.toString();
    if (this.inputBuffer.length > MAX_FRAME_CHARS && !this.inputBuffer.includes("\n")) {
      this.close();
      return;
    }
    while (true) {
      const newline = this.inputBuffer.indexOf("\n");
      if (newline < 0) break;
      const frame = this.inputBuffer.slice(0, newline);
      this.inputBuffer = this.inputBuffer.slice(newline + 1);
      if (!frame || frame.length > MAX_FRAME_CHARS) continue;
      this.handleFrame(frame);
      if (this.closed) return;
    }
  };

  private readonly onError = (): void => {
    // The ordinary TTY selector remains active when the optional bridge fails.
    this.settleActivation(false);
  };

  private readonly onClose = (): void => {
    this.connected = false;
    this.protocolReady = false;
    this.settleActivation(false);
    this.socket = undefined;
    this.inputBuffer = "";
  };

  private handleFrame(frame: string): void {
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      return;
    }
    if (isBridgeReadyMessage(message)) {
      this.protocolReady = true;
      this.clearActivationFallback();
      this.armActivationFallback();
      return;
    }
    if (isMenuReadyMessage(message)) {
      if (message.requestId === this.activation?.id) {
        this.settleActivation(message.ready);
      }
      return;
    }
    if (isDisclosureToggleMessage(message) && this.protocolReady) {
      for (const listener of [...this.disclosureListeners]) {
        try {
          listener(message.kind, message.id);
        } catch {
          // One UI listener must not make the authenticated channel fail.
        }
      }
      return;
    }
    if (!isNavigationMessage(message) || !this.active) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(message.direction);
      } catch {
        // One UI listener must not make the authenticated channel fail.
      }
    }
  }

  private send(message: Readonly<Record<string, unknown>>): void {
    if (!this.connected || this.closed || !this.socket?.writable) return;
    try {
      this.socket.write(`${JSON.stringify(message)}\n`);
    } catch {
      // Fall back to the normal terminal input path.
    }
  }

  private createActivation(): PendingActivation {
    const id = this.nextActivationId;
    this.nextActivationId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;
    let resolveReady: (ready: boolean) => void = () => undefined;
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    return {
      id,
      ready,
      resolve: resolveReady,
      settled: false,
    };
  }

  private sendMenuState(active: boolean): void {
    const requestId = this.activation?.id;
    this.send({
      type: "menu",
      active,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  private armActivationFallback(): void {
    const activation = this.activation;
    if (!activation || activation.settled || activation.fallbackTimer) return;
    const timeoutMs = !this.connected || this.protocolReady
      ? this.readyAckTimeoutMs
      : this.legacyFallbackMs;
    activation.fallbackTimer = setTimeout(() => {
      activation.fallbackTimer = undefined;
      // A legacy extension never sends the immediate bridge-ready frame, so
      // this short deadline falls back to Raw TTY input. A negotiated extension
      // gets the longer ready-ACK deadline selected above.
      this.settleActivation(false);
    }, timeoutMs);
  }

  private settleActivation(ready: boolean): void {
    const activation = this.activation;
    if (!activation || activation.settled) return;
    activation.settled = true;
    if (activation.fallbackTimer) clearTimeout(activation.fallbackTimer);
    activation.fallbackTimer = undefined;
    activation.resolve(ready);
  }

  private clearActivationFallback(): void {
    const activation = this.activation;
    if (!activation?.fallbackTimer) return;
    clearTimeout(activation.fallbackTimer);
    activation.fallbackTimer = undefined;
  }
}

export function createVsCodeMenuBridge(
  options: Readonly<VsCodeMenuBridgeOptions> = {},
): VsCodeMenuBridge | undefined {
  const environment = options.environment ?? process.env;
  const endpoint = environment[VSCODE_BRIDGE_ENDPOINT_ENV]?.trim();
  const token = environment[VSCODE_BRIDGE_TOKEN_ENV]?.trim().toLowerCase();
  const endpointMatch = endpoint ? ENDPOINT_PATTERN.exec(endpoint) : null;
  if (!endpointMatch || !token || !TOKEN_PATTERN.test(token)) return undefined;
  const port = Number(endpointMatch[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;

  const identity = options.identity ?? {
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
  };
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    !Number.isSafeInteger(identity.ppid) ||
    identity.ppid < 0 ||
    typeof identity.cwd !== "string" ||
    Buffer.byteLength(identity.cwd, "utf8") > 4096
  ) {
    return undefined;
  }

  return new VsCodeMenuBridge(
    port,
    token,
    identity,
    options.connect ?? defaultConnect,
    normalizeTimeout(options.legacyFallbackMs, DEFAULT_LEGACY_FALLBACK_MS),
    normalizeTimeout(options.readyAckTimeoutMs, DEFAULT_READY_ACK_TIMEOUT_MS),
  );
}

function defaultConnect(port: number): Socket {
  return createConnection({ host: "127.0.0.1", port });
}

function isNavigationMessage(
  value: unknown,
): value is { readonly type: "navigate"; readonly direction: MenuNavigationDirection } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "navigate" &&
    (record.direction === "up" || record.direction === "down") &&
    Object.keys(record).every((key) => key === "type" || key === "direction");
}

function isBridgeReadyMessage(
  value: unknown,
): value is { readonly type: "bridge-ready"; readonly protocol: number } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "bridge-ready" &&
    record.protocol === BRIDGE_PROTOCOL_VERSION &&
    Object.keys(record).every((key) => key === "type" || key === "protocol");
}

function isMenuReadyMessage(
  value: unknown,
): value is {
  readonly type: "menu-ready";
  readonly requestId: number;
  readonly ready: boolean;
} {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "menu-ready" &&
    Number.isSafeInteger(record.requestId) &&
    Number(record.requestId) > 0 &&
    typeof record.ready === "boolean" &&
    Object.keys(record).every((key) =>
      key === "type" || key === "requestId" || key === "ready"
    );
}

function isDisclosureToggleMessage(
  value: unknown,
): value is {
  readonly type: "toggle-disclosure";
  readonly kind: VsCodeDisclosureKind;
  readonly id: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "toggle-disclosure" &&
    (record.kind === "thinking" || record.kind === "adjustment") &&
    Number.isSafeInteger(record.id) &&
    Number(record.id) > 0 &&
    Object.keys(record).length === 3 &&
    Object.keys(record).every((key) =>
      key === "type" || key === "kind" || key === "id"
    );
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 1
    ? Number(value)
    : fallback;
}
