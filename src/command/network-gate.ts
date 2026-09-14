import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { publicDownloadAddress } from "../downloads/broker.js";

export interface CommandNetworkGate {
  /** Capability URL used only by the trusted sandbox proxy, never target env. */
  proxyURL: string;
  /** Complete Windows WFP port set to present with this command. */
  proxyPorts?: readonly number[];
  close(): Promise<void>;
}

export interface CommandNetworkGateOptions {
  authorize(host: string, port: number): Promise<boolean>;
  record(host: string, port: number, outcome: string): void;
  signal?: AbortSignal;
  /** A stable, Runtime-owned loopback port keeps Windows WFP sandbox policy
   * durable. Port zero retains ephemeral binding on platforms that do not
   * encode the proxy port into operating-system policy. */
  listenPort?: number;
  /** Trusted test injection, never accepted in model arguments or project config. */
  resolveHost?: (host: string) => Promise<string>;
}

interface GateSession {
  readonly authorization: string;
  readonly options: CommandNetworkGateOptions;
  readonly sockets: Set<Duplex>;
  closed: boolean;
  requests: number;
  transferred: number;
  budgetExceeded: boolean;
}

interface GateServer {
  server: Server;
  readonly sessions: Map<string, GateSession>;
  port: number;
  readonly shared: boolean;
}

// Main, child and reviewer agents share one listener inside a CLI process.
// Authority remains in independent per-command sessions, never in the port.
const stableGateServers = new Map<number, Promise<GateServer>>();

export async function resolvePublicNetworkHost(host: string): Promise<string> {
  if (!host || /[\s\u0000-\u001f\u007f/@\\]/u.test(host)) throw new Error("Invalid network destination");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, family: 4 });
  if (!addresses.length || addresses.some(a => !publicDownloadAddress(a.address))) throw new Error("Private, local, reserved and IPv6 destinations are not enabled");
  return addresses[0]!.address;
}

function sessionFor(request: IncomingMessage, gate: GateServer): GateSession | undefined {
  const header = request.headers["proxy-authorization"];
  return typeof header === "string" ? gate.sessions.get(header) : undefined;
}

function track(session: GateSession, socket: Duplex): void {
  session.sockets.add(socket);
  socket.on("error", () => undefined);
  socket.once("close", () => session.sockets.delete(socket));
}

function meter(session: GateSession, stream: Duplex | IncomingMessage): void {
  stream.on("data", (chunk: Buffer) => {
    session.transferred += chunk.length;
    if (session.transferred <= 512 * 1024 * 1024) return;
    session.budgetExceeded = true;
    for (const entry of session.sockets) entry.destroy();
  });
}

async function permit(session: GateSession, host: string, port: number): Promise<string> {
  if (session.closed || session.budgetExceeded || session.options.signal?.aborted ||
      ++session.requests > 2048 || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !host || host.length > 253 || /[\s\u0000-\u001f\u007f/@\\]/u.test(host)) {
    throw new Error("Network capability rejected");
  }
  if (!await session.options.authorize(host, port)) {
    session.options.record(host, port, "approval_denied");
    throw new Error("Network approval denied");
  }
  if (session.closed || session.budgetExceeded || session.options.signal?.aborted) {
    throw new Error("Network capability expired");
  }
  // Address is checked and then pinned for the actual dial (no DNS rebinding).
  let timer: NodeJS.Timeout | undefined;
  const address = await Promise.race([
    (session.options.resolveHost ?? resolvePublicNetworkHost)(host),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DNS deadline exceeded")), 10000); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (session.closed || session.budgetExceeded || session.options.signal?.aborted) {
    throw new Error("Network capability expired");
  }
  session.options.record(host, port, "allowed");
  return address;
}

async function startGateServer(listenPort: number, shared: boolean): Promise<GateServer> {
  const gate: GateServer = {
    server: undefined as unknown as Server,
    sessions: new Map<string, GateSession>(),
    port: 0,
    shared,
  };
  const server = createServer({ maxHeaderSize: 16384 }, (req, res) => {
    void (async () => {
      const session = sessionFor(req, gate);
      if (!session || session.closed) throw new Error("Network capability rejected");
      track(session, req.socket);
      const url = new URL(req.url ?? "");
      if (url.protocol !== "http:" || url.username || url.password) throw new Error("Invalid forward request");
      const port = Number(url.port || 80);
      const address = await permit(session, url.hostname, port);
      if (req.destroyed || session.closed) return;
      const headers: OutgoingHttpHeaders = { ...req.headers, host: url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = httpRequest({ hostname: address, family: 4, port, path: url.pathname + url.search,
        method: req.method, headers, agent: false, timeout: 60000 }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
        meter(session, response);
      });
      upstream.on("socket", socket => track(session, socket));
      upstream.once("timeout", () => upstream.destroy());
      upstream.once("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Network request failed"); });
      res.once("close", () => upstream.destroy());
      req.pipe(upstream);
      meter(session, req);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(403, { connection: "close" });
      res.end("EASY CODE network capability denied");
    });
  });
  gate.server = server;
  server.on("connection", socket => {
    socket.on("error", () => undefined);
    socket.setTimeout(120000, () => socket.destroy());
  });
  server.on("connect", (req, client, head) => {
    client.pause();
    void (async () => {
      const session = sessionFor(req, gate);
      if (!session || session.closed) throw new Error("Network capability rejected");
      track(session, client);
      const url = new URL(`http://${req.url}`);
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid CONNECT authority");
      const port = Number(url.port || 80);
      const address = await permit(session, url.hostname, port);
      if (client.destroyed || session.closed) return;
      const upstream: Socket = connect({ host: address, family: 4, port });
      track(session, upstream);
      upstream.setTimeout(60000, () => upstream.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
      upstream.once("connect", () => {
        if (client.destroyed || session.closed) { upstream.destroy(); return; }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        session.transferred += head.length;
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
        meter(session, client);
        meter(session, upstream);
        client.resume();
      });
    })().catch(() => client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (listenPort > 0 && error.code === "EADDRINUSE") {
        reject(new Error(`Native sandbox network broker port ${listenPort} is already in use; the per-process proxy lease must select another slot`));
      } else reject(error);
    };
    server.once("error", onError);
    server.listen({ port: listenPort, host: "127.0.0.1", exclusive: true }, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("Network gate did not bind")); return; }
      gate.port = address.port;
      if (shared) server.unref();
      resolve();
    });
  });
  return gate;
}

function stableGateServer(port: number): Promise<GateServer> {
  const current = stableGateServers.get(port);
  if (current) return current;
  const created = startGateServer(port, true).catch(error => {
    if (stableGateServers.get(port) === created) stableGateServers.delete(port);
    throw error;
  });
  stableGateServers.set(port, created);
  return created;
}

/** Bind the process-wide listener during CLI startup, before Windows setup is
 * requested. Later command sessions reuse it without changing WFP policy. */
export async function ensureSharedCommandNetworkGateServer(port: number): Promise<void> {
  await stableGateServer(port);
}

/** Per-command egress capability on an ephemeral POSIX listener or a shared,
 * process-scoped Windows listener. Approval precedes DNS and outbound
 * connections. TLS is tunneled, not decrypted. */
export async function createCommandNetworkGate(options: CommandNetworkGateOptions): Promise<CommandNetworkGate> {
  const listenPort = options.listenPort ?? 0;
  const gate = listenPort > 0 ? await stableGateServer(listenPort) : await startGateServer(0, false);
  const secret = randomBytes(32).toString("hex");
  const authorization = `Basic ${Buffer.from(`easy-code:${secret}`).toString("base64")}`;
  const session: GateSession = {
    authorization,
    options,
    sockets: new Set<Duplex>(),
    closed: false,
    requests: 0,
    transferred: 0,
    budgetExceeded: false,
  };
  gate.sessions.set(authorization, session);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    session.closed = true;
    options.signal?.removeEventListener("abort", abort);
    gate.sessions.delete(authorization);
    for (const socket of session.sockets) socket.destroy();
    closing = gate.shared
      ? Promise.resolve()
      : new Promise<void>(resolve => {
          gate.server.closeAllConnections();
          gate.server.close(() => resolve());
        });
    return closing;
  };
  const abort = () => { void close(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) await close();
  return { proxyURL: `http://easy-code:${secret}@127.0.0.1:${gate.port}`, close };
}
