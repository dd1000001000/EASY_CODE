import { isIP } from "node:net";
import { publicDownloadAddress } from "../downloads/broker.js";

/** SRT's parent proxy always bypasses loopback, even with noProxy="".
 * Reject those names before SRT can choose a direct connection. DNS validation
 * for ordinary hostnames still happens only in the parent gate after approval. */
export function allowBrokeredNetworkHost(raw: string): boolean {
  if (!raw || raw.length > 253 || /[\s\u0000-\u001f\u007f/@\\?#]/u.test(raw)) return false;
  try {
    const host = new URL(`http://${raw}`).hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
    return isIP(host) ? publicDownloadAddress(host) : !host.includes(":");
  } catch { return false; }
}
