"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024;
const DEFAULT_MAX_CLIENTS = 32;
const TOKEN_BYTES = 32;
const BRIDGE_PROTOCOL_VERSION = 2;
const DISCLOSURE_TOGGLE_CAPABILITY = "disclosure-toggle-v1";
const MAX_CAPABILITIES = 16;
const MAX_CAPABILITY_CHARS = 64;

function isPositiveProcessId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isHelloFrame(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.type === "hello" &&
    typeof value.token === "string" &&
    isPositiveProcessId(value.pid) &&
    isPositiveProcessId(value.ppid) &&
    typeof value.cwd === "string" &&
    Buffer.byteLength(value.cwd, "utf8") <= 4096 &&
    (value.protocol === undefined ||
      (Number.isSafeInteger(value.protocol) && value.protocol >= 1)) &&
    isCapabilitiesValue(value.capabilities),
  );
}

function isCapabilitiesValue(value) {
  return value === undefined || Boolean(
    Array.isArray(value) &&
    value.length <= MAX_CAPABILITIES &&
    value.every((capability) =>
      typeof capability === "string" &&
      capability.length > 0 &&
      capability.length <= MAX_CAPABILITY_CHARS
    ),
  );
}

function isMenuFrame(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.type === "menu" &&
    typeof value.active === "boolean" &&
    (value.requestId === undefined ||
      (Number.isSafeInteger(value.requestId) && value.requestId > 0)),
  );
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function encodeBridgeFrame(value) {
  return `${JSON.stringify(value)}\n`;
}

/**
 * A byte-oriented newline-delimited JSON decoder. Keeping bytes until a full
 * frame arrives makes the limit apply to the wire representation rather than
 * JavaScript UTF-16 code units.
 */
class NdjsonFrameDecoder {
  constructor(maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.buffer.length + bytes.length > this.maxFrameBytes * 2) {
      throw new RangeError("EASY CODE bridge input buffer exceeded its limit.");
    }
    this.buffer = Buffer.concat([this.buffer, bytes]);
    const frames = [];
    let newline;
    while ((newline = this.buffer.indexOf(0x0a)) !== -1) {
      let line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      if (line.length === 0 || line.length > this.maxFrameBytes) {
        throw new RangeError("EASY CODE bridge frame has an invalid size.");
      }
      let value;
      try {
        value = JSON.parse(line.toString("utf8"));
      } catch {
        throw new SyntaxError("EASY CODE bridge frame is not valid JSON.");
      }
      frames.push(value);
    }
    if (this.buffer.length > this.maxFrameBytes) {
      throw new RangeError("EASY CODE bridge frame exceeded its limit.");
    }
    return frames;
  }
}

/**
 * Start a loopback-only authenticated bridge. The first frame on every socket
 * must be a valid hello carrying the launch-scoped token; subsequent frames
 * may only update menu state. Invalid clients are closed without a response.
 */
function createMenuNavigationServer(options = {}) {
  const token = options.token ?? crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
  const clients = new Set();
  let disposed = false;

  const server = (options.netModule ?? net).createServer((socket) => {
    if (disposed || clients.size >= maxClients) {
      socket.destroy();
      return;
    }

    const decoder = new NdjsonFrameDecoder(maxFrameBytes);
    const client = {
      socket,
      authenticated: false,
      pid: undefined,
      ppid: undefined,
      cwd: undefined,
      protocol: 1,
      capabilities: new Set(),
      menuActive: false,
      menuRequestId: undefined,
      terminal: undefined,
      lastActivity: 0,
    };
    clients.add(client);

    const closeInvalid = () => socket.destroy();
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        closeInvalid();
        return;
      }

      for (const frame of frames) {
        if (!client.authenticated) {
          if (!isHelloFrame(frame) || !tokenMatches(frame.token, token)) {
            closeInvalid();
            return;
          }
          client.authenticated = true;
          client.pid = frame.pid;
          client.ppid = frame.ppid;
          client.cwd = frame.cwd;
          client.protocol = frame.protocol ?? 1;
          client.capabilities = new Set(
            (frame.capabilities ?? []).filter((capability) =>
              capability === DISCLOSURE_TOGGLE_CAPABILITY
            ),
          );
          client.lastActivity = Date.now();
          if (client.protocol >= BRIDGE_PROTOCOL_VERSION) {
            socket.write(encodeBridgeFrame({
              type: "bridge-ready",
              protocol: BRIDGE_PROTOCOL_VERSION,
            }));
          }
          options.onHello?.(client);
          continue;
        }
        if (!isMenuFrame(frame)) {
          closeInvalid();
          return;
        }
        client.menuActive = frame.active;
        client.menuRequestId = frame.requestId;
        client.lastActivity = Date.now();
        options.onMenuState?.(client, frame.active, frame.requestId);
      }
    });
    socket.on("error", () => {
      // A client failure is isolated from the extension host.
    });
    socket.on("close", () => {
      clients.delete(client);
      options.onDisconnect?.(client);
    });
  });

  server.on("error", (error) => {
    options.onServerError?.(error);
  });

  return {
    token,
    clients,
    async listen() {
      if (disposed) throw new Error("EASY CODE bridge has been disposed.");
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("EASY CODE bridge did not receive a TCP address.");
      }
      return `127.0.0.1:${address.port}`;
    },
    send(client, value) {
      if (
        disposed ||
        !clients.has(client) ||
        !client.authenticated ||
        client.socket.destroyed ||
        !client.socket.writable
      ) {
        return false;
      }
      const frame = encodeBridgeFrame(value);
      if (Buffer.byteLength(frame, "utf8") > maxFrameBytes) return false;
      client.socket.write(frame);
      return true;
    },
    closeClient(client) {
      if (!clients.has(client)) return;
      client.socket.destroy();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const client of clients) client.socket.destroy();
      clients.clear();
      if (server.listening) server.close();
    },
  };
}

async function chooseTerminalForClient(client, terminals, isTracked, activeTerminal) {
  const tracked = terminals.filter((terminal) => isTracked(terminal));
  if (tracked.length === 0) return undefined;

  const processIds = await Promise.all(tracked.map(async (terminal) => {
    try {
      return await terminal.processId;
    } catch {
      return undefined;
    }
  }));
  const exact = tracked.filter((_, index) => processIds[index] === client.ppid);
  if (exact.length === 1) return exact[0];
  if (tracked.length === 1) return tracked[0];
  return tracked.includes(activeTerminal) ? activeTerminal : undefined;
}

module.exports = {
  BRIDGE_PROTOCOL_VERSION,
  DISCLOSURE_TOGGLE_CAPABILITY,
  chooseTerminalForClient,
  createMenuNavigationServer,
  DEFAULT_MAX_CLIENTS,
  DEFAULT_MAX_FRAME_BYTES,
  encodeBridgeFrame,
  isHelloFrame,
  isMenuFrame,
  NdjsonFrameDecoder,
  tokenMatches,
};
