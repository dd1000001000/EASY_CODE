import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { publicDownloadAddress } from "../downloads/broker.js";

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) return publicDownloadAddress(address);
  if (isIP(address) !== 6) return false;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [first = 0, second = 0] = normalized
    .split(":")
    .slice(0, 2)
    .map((part) => Number.parseInt(part || "0", 16));
  // Allow global unicast IPv6, excluding special-use, documentation and 6to4
  // destinations. Mapped IPv4, local, link-local and multicast cannot enter.
  return (first & 0xe000) === 0x2000 && first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

async function resolvePublic(url: URL, signal?: AbortSignal): Promise<LookupAddress> {
  signal?.throwIfAborted();
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP and HTTPS URLs are supported.");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not supported.");
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const family = isIP(hostname);
  let abort: (() => void) | undefined;
  const resolution = family
    ? Promise.resolve([{ address: hostname, family }])
    : lookup(hostname, { all: true, verbatim: true });
  const addresses = await Promise.race([
    resolution,
    new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }),
  ]).finally(() => {
    if (abort) signal?.removeEventListener("abort", abort);
  });
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address)))
    throw new Error("Private or local network destinations are not allowed.");
  // Prefer IPv4 when both families are available on hosts without IPv6 routing.
  return addresses.find((item) => item.family === 4) ?? addresses[0]!;
}

async function readBody(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`Web response exceeds the ${maxBytes}-byte limit.`);
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
  const decoder =
    !encoding || encoding === "identity"
      ? undefined
      : encoding === "gzip" || encoding === "x-gzip"
        ? createGunzip()
        : encoding === "br"
          ? createBrotliDecompress()
          : encoding === "deflate"
            ? createInflate()
            : undefined;
  if (encoding && encoding !== "identity" && !decoder)
    throw new Error(`Unsupported Web response encoding: ${encoding}.`);
  const body = decoder ?? response;
  // pipeline propagates source errors to the decoder; iteration observes them.
  const transferred = decoder ? pipeline(response, decoder).catch(() => undefined) : Promise.resolve();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += data.length;
      if (total > maxBytes) throw new Error(`Web response exceeds the ${maxBytes}-byte limit.`);
      chunks.push(data);
    }
    return Buffer.concat(chunks);
  } finally {
    response.destroy();
    body.destroy();
    await transferred;
  }
}

export async function requestPublic(
  url: URL,
  options: { signal?: AbortSignal; accept?: string; maxBytes: number },
): Promise<{ redirect: string } | { mediaType: string; data: Buffer }> {
  const address = await resolvePublic(url, options.signal);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        agent: false,
        family: address.family,
        signal: options.signal,
        // Keep the original hostname for Host and TLS verification while pinning
        // the connection to the address that passed the public-network check.
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        headers: {
          Accept: options.accept ?? "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "User-Agent": "EASY-CODE/0.1 (+local coding agent)",
        },
      },
      (response) => {
        void (async () => {
          try {
            const status = response.statusCode ?? 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
              resolve({ redirect: response.headers.location ?? "" });
              return;
            }
            if (status < 200 || status >= 300) throw new Error(`Web request failed with HTTP ${status}.`);
            const data = await readBody(response, options.maxBytes);
            resolve({
              data,
              mediaType:
                response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream",
            });
          } catch (error) {
            reject(error);
          } finally {
            response.destroy();
          }
        })();
      },
    );
    request.once("error", reject);
    request.end();
  });
}
