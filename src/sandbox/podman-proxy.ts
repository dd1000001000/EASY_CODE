import { connect, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

/** Treat every byte from the workload as hostile. It can open streams ONLY to
 * this host-created gate, not ask the supervisor to dial an arbitrary address. */
export function attachPodmanProxy(input: Readable, output: Writable, proxyURL: string, limits: {
  maxConnections: number; maxBytes: number;
}): { ready: Promise<void>; close(): void } {
  const gate = new URL(proxyURL);
  if (gate.protocol !== "http:" || gate.hostname !== "127.0.0.1" || !gate.port) throw new Error("Invalid host network gate");
  const streams = new Map<number, Socket>();
  let pending = "", bytes = 0, frames = 0, closed = false, isReady = false;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Initialization failure may race the caller subscribing to readiness.
  void ready.catch(() => undefined);
  const send = (value: object) => {
    if (closed) return;
    const line = JSON.stringify(value) + "\n";
    if (output.writableLength + line.length > 1024 * 1024) return close();
    output.write(line);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const socket of streams.values()) socket.destroy();
    streams.clear();
    input.off("data", data);
    output.end();
    if (!isReady) rejectReady(new Error("Container network relay failed before becoming ready"));
  };
  const data = (chunk: Buffer) => {
    try {
      bytes += chunk.length;
      if (bytes > limits.maxBytes) throw new Error("Proxy byte budget exceeded");
      pending += chunk.toString("utf8");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        if (end > 65536 || ++frames > 2000000) throw new Error("Proxy frame limit");
        const frame = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        if (frame.type === "ready" && !isReady) { isReady = true; resolveReady(); continue; }
        if (!isReady || !Number.isSafeInteger(frame.id) || frame.id < 1) throw new Error("Invalid proxy stream");
        if (frame.type === "open") {
          if (streams.has(frame.id) || streams.size >= limits.maxConnections) throw new Error("Proxy connection limit");
          const socket = connect({ host: "127.0.0.1", port: Number(gate.port) });
          streams.set(frame.id, socket);
          socket.setTimeout(120000, () => socket.destroy());
          socket.on("data", value => {
            bytes += value.length;
            if (bytes > limits.maxBytes) return close();
            for (let i = 0; i < value.length; i += 16384)
              send({ type: "data", id: frame.id, data: value.subarray(i, i + 16384).toString("base64") });
          });
          socket.on("error", () => socket.destroy());
          socket.on("close", () => { streams.delete(frame.id); send({ type: "close", id: frame.id }); });
        } else if (frame.type === "data") {
          if (typeof frame.data !== "string" || frame.data.length > 32768 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data)) throw new Error("Invalid proxy payload");
          const socket = streams.get(frame.id);
          if (!socket) continue;
          if (socket.writableLength > 1024 * 1024) throw new Error("Proxy backpressure limit");
          socket.write(Buffer.from(frame.data, "base64"));
        } else if (frame.type === "close") streams.get(frame.id)?.end();
        else throw new Error("Unknown proxy frame");
      }
      if (pending.length > 65536) throw new Error("Proxy frame too long");
    } catch { close(); }
  };
  input.on("data", data); input.once("end", close); input.once("error", close); output.once("error", close);
  return { ready, close };
}
