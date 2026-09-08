import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { publicDownloadAddress } from "../downloads/broker.js";

export interface CommandNetworkGate {
  /** Capability URL used only by the trusted sandbox proxy, never target env. */
  proxyURL: string;
  close(): Promise<void>;
}

export async function resolvePublicNetworkHost(host: string): Promise<string> {
  if (!host || /[\s\u0000-\u001f\u007f/@\\]/u.test(host)) throw new Error("Invalid network destination");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, family: 4 });
  if (!addresses.length || addresses.some(a => !publicDownloadAddress(a.address))) throw new Error("Private, local, reserved and IPv6 destinations are not enabled");
  return addresses[0]!.address;
}

/** Per-command egress broker. Approval precedes DNS and outbound connections.
 * TLS is tunneled, not decrypted: unknown programs always require full network
 * approval rather than pretending their individual HTTPS requests are reads. */
export async function createCommandNetworkGate(options: {
  authorize(host: string, port: number): Promise<boolean>;
  record(host: string, port: number, outcome: string): void;
  signal?: AbortSignal;
  /** Trusted test injection, never accepted in model arguments or project config. */
  resolveHost?: (host: string) => Promise<string>;
}): Promise<CommandNetworkGate> {
  const secret = randomBytes(32).toString("hex");
  const authorization = `Basic ${Buffer.from(`easy-code:${secret}`).toString("base64")}`;
  const sockets = new Set<Duplex>();
  let closed = false;
  let requests = 0;
  let transferred = 0;
  let budgetExceeded = false;
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
  };
  const meter = (stream: Duplex | IncomingMessage) => {
    stream.on("data", (chunk: Buffer) => {
      transferred += chunk.length;
      if (transferred > 512 * 1024 * 1024) {
        budgetExceeded = true;
        for (const entry of sockets) entry.destroy();
      }
    });
  };
  const permit = async (req: IncomingMessage, host: string, port: number): Promise<string> => {
    if (closed || budgetExceeded || options.signal?.aborted || req.headers["proxy-authorization"] !== authorization ||
        ++requests > 2048 || !Number.isInteger(port) || port < 1 || port > 65535 ||
        !host || host.length > 253 || /[\s\u0000-\u001f\u007f/@\\]/u.test(host)) throw new Error("Network capability rejected");
    if (!await options.authorize(host, port)) { options.record(host, port, "approval_denied"); throw new Error("Network approval denied"); }
    if (closed || budgetExceeded || options.signal?.aborted) throw new Error("Network capability expired");
    // Address is checked and then pinned for the actual dial (no DNS rebinding).
    let timer: NodeJS.Timeout | undefined;
    const address = await Promise.race([
      (options.resolveHost ?? resolvePublicNetworkHost)(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DNS deadline exceeded")), 10000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (closed || budgetExceeded || options.signal?.aborted) throw new Error("Network capability expired");
    options.record(host, port, "allowed");
    return address;
  };
  const server = createServer({ maxHeaderSize: 16384 }, (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "");
      if (url.protocol !== "http:" || url.username || url.password) throw new Error("Invalid forward request");
      const port = Number(url.port || 80);
      const address = await permit(req, url.hostname, port);
      if (req.destroyed || closed) return;
      const headers: OutgoingHttpHeaders = { ...req.headers, host: url.host };
      delete headers["proxy-authorization"]; delete headers["proxy-connection"];
      const upstream = httpRequest({ hostname: address, family: 4, port, path: url.pathname + url.search,
        method: req.method, headers, agent: false, timeout: 60000 }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); meter(response);
      });
      upstream.on("socket", track); upstream.once("timeout", () => upstream.destroy());
      upstream.once("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Network request failed"); });
      res.once("close", () => upstream.destroy());
      req.pipe(upstream); meter(req);
    })().catch(() => { if (!res.headersSent) res.writeHead(403); res.end("EASY CODE network capability denied"); });
  });
  server.on("connection", socket => { track(socket); socket.setTimeout(120000, () => socket.destroy()); });
  server.on("connect", (req, client, head) => {
    client.pause();
    void (async () => {
      const url = new URL(`http://${req.url}`);
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid CONNECT authority");
      const port = Number(url.port || 80);
      const address = await permit(req, url.hostname, port);
      if (client.destroyed || closed) return;
      const upstream: Socket = connect({ host: address, family: 4, port });
      track(upstream); upstream.setTimeout(60000, () => upstream.destroy());
      client.once("close", () => upstream.destroy()); upstream.once("close", () => client.destroy());
      upstream.once("connect", () => {
        if (client.destroyed || closed) { upstream.destroy(); return; }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        transferred += head.length;
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client); meter(client); meter(upstream); client.resume();
      });
    })().catch(() => client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true; options.signal?.removeEventListener("abort", abort);
    for (const socket of sockets) socket.destroy();
    closing = new Promise<void>(resolve => server.close(() => resolve()));
    return closing;
  };
  const abort = () => { void close(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const address = server.address();
  if (!address || typeof address === "string") { await close(); throw new Error("Network gate did not bind"); }
  if (options.signal?.aborted) await close();
  return { proxyURL: `http://easy-code:${secret}@127.0.0.1:${address.port}`, close };
}
