import { createConnection, type Socket } from "node:net";

import type {
  MenuNavigationDirection,
  MenuSelectorNavigation,
} from "./menu-selector.js";

export const VSCODE_BRIDGE_ENDPOINT_ENV =
  "EASY_CODE_VSCODE_BRIDGE_ENDPOINT";
export const VSCODE_BRIDGE_TOKEN_ENV = "EASY_CODE_VSCODE_BRIDGE_TOKEN";

const MAX_FRAME_CHARS = 16 * 1024;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const ENDPOINT_PATTERN = /^127\.0\.0\.1:([1-9]\d{0,4})$/u;

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
}

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
  private socket?: BridgeSocket;
  private inputBuffer = "";
  private connected = false;
  private active = false;
  private closed = false;

  constructor(
    private readonly endpointPort: number,
    private readonly token: string,
    private readonly identity: Readonly<BridgeIdentity>,
    connect: (port: number) => BridgeSocket = defaultConnect,
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
  ): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(onNavigate);
    if (!this.active) {
      this.active = true;
      this.send({ type: "menu", active: true });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.listeners.delete(onNavigate);
      if (this.listeners.size === 0 && this.active) {
        this.active = false;
        this.send({ type: "menu", active: false });
      }
    };
  }

  close(): void {
    if (this.closed) return;
    if (this.active) this.send({ type: "menu", active: false });
    this.closed = true;
    this.active = false;
    this.listeners.clear();
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
    this.send({
      type: "hello",
      token: this.token,
      pid: this.identity.pid,
      ppid: this.identity.ppid,
      cwd: this.identity.cwd,
    });
    if (this.active) this.send({ type: "menu", active: true });
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
  };

  private readonly onClose = (): void => {
    this.connected = false;
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
