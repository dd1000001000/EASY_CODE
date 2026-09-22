import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 5;
export const MAX_WEBPAGE_BYTES = 10 * 1024 * 1024;

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (_all, entity: string) => {
    if (entity[0] === "#") {
      const code = Number.parseInt(entity[1]?.toLowerCase() === "x" ? entity.slice(2) : entity.slice(1), entity[1]?.toLowerCase() === "x" ? 16 : 10);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : "";
    }
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

function stripTags(value: string): string { return decodeEntities(value.replace(/<[^>]*>/gu, "")); }

export function htmlToMarkdown(html: string, sourceUrl: string): { title: string; markdown: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const title = stripTags(titleMatch?.[1] ?? new URL(sourceUrl).hostname).replace(/\s+/gu, " ").trim();
  let body = /<body\b[^>]*>([\s\S]*?)<\/body>/iu.exec(html)?.[1] ?? html;
  body = body
    .replace(/<(script|style|noscript|svg|canvas|template|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<!--([\s\S]*?)-->/gu, "")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/giu, (_all, value: string) => `\n\n\`\`\`\n${stripTags(value).trim()}\n\`\`\`\n\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu, (_all, level: string, value: string) => `\n\n${"#".repeat(Number(level))} ${stripTags(value).trim()}\n\n`)
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu, (_all, href: string, value: string) => {
      const label = stripTags(value).replace(/\s+/gu, " ").trim();
      try { return label ? `[${label}](${new URL(decodeEntities(href), sourceUrl).href})` : ""; } catch { return label; }
    })
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/giu, (_all, value: string) => `\n- ${stripTags(value).replace(/\s+/gu, " ").trim()}`)
    .replace(/<(?:p|div|section|article|main|header|aside|blockquote|table|tr)\b[^>]*>/giu, "\n\n")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/[^>]+>/gu, "\n");
  const text = decodeEntities(body.replace(/<[^>]*>/gu, ""))
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { title: title || new URL(sourceUrl).hostname, markdown: `# ${title || new URL(sourceUrl).hostname}\n\nSource: ${sourceUrl}\n\n${text}\n` };
}

function privateAddress(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address)?.[1];
  const ipv4 = mapped ?? (isIP(address) === 4 ? address : undefined);
  if (!ipv4) return false;
  const [a = 0, b = 0] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function assertPublicUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP and HTTPS URLs are supported.");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not supported.");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error("Private or local network destinations are not allowed.");
  return url;
}

export async function fetchPublic(urlValue: string, options: { signal?: AbortSignal; accept?: string; maxBytes?: number } = {}): Promise<{ url: string; mediaType: string; data: Buffer }> {
  let url = await assertPublicUrl(urlValue);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(url, { redirect: "manual", signal: options.signal, headers: {
      Accept: options.accept ?? "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8",
      "User-Agent": "EASY-CODE/0.1 (+local coding agent)",
    } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) throw new Error("Web page redirected too many times.");
      url = await assertPublicUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error(`Web request failed with HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length"));
    const maxBytes = options.maxBytes ?? MAX_WEBPAGE_BYTES;
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Web response exceeds the ${maxBytes}-byte limit.`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Web response has no body.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error(`Web response exceeds the ${maxBytes}-byte limit.`); }
      chunks.push(part.value);
    }
    return { url: url.href, mediaType: response.headers.get("content-type")?.split(";")[0]?.toLowerCase() || "application/octet-stream", data: Buffer.concat(chunks) };
  }
  throw new Error("Web page redirected too many times.");
}

function htmlAttribute(tag: string, name: "class" | "href"): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu").exec(tag);
  return match?.[1] ?? match?.[2];
}

function searchResultUrl(href: string): string | undefined {
  try {
    const link = new URL(decodeEntities(href), "https://duckduckgo.com");
    if (link.hostname === "duckduckgo.com" || link.hostname === "www.duckduckgo.com") {
      if (link.pathname !== "/l/") return undefined;
      const target = link.searchParams.get("uddg");
      if (!target) return undefined;
      const destination = new URL(target);
      return ["http:", "https:"].includes(destination.protocol) ? destination.href : undefined;
    }
    return ["http:", "https:"].includes(link.protocol) ? link.href : undefined;
  } catch { return undefined; }
}

export function parseSearchHtml(html: string, limit: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const anchors = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/giu)].filter((match) => {
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    return htmlAttribute(tag, "class")?.split(/\s+/u).includes("result__a");
  });
  const seen = new Set<string>();
  for (const [index, anchor] of anchors.entries()) {
    const tag = anchor[0].slice(0, anchor[0].indexOf(">") + 1);
    const url = searchResultUrl(htmlAttribute(tag, "href") ?? "");
    const title = stripTags(anchor[0].slice(tag.length, -4)).replace(/\s+/gu, " ").trim();
    if (!url || !title || seen.has(url)) continue;
    const following = html.slice((anchor.index ?? 0) + anchor[0].length, anchors[index + 1]?.index ?? html.length);
    const snippetMatch = /<(?:a|div)\b[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/iu.exec(following);
    const snippet = stripTags(snippetMatch?.[1] ?? "").replace(/\s+/gu, " ").trim();
    results.push({ title, url, snippet });
    seen.add(url);
    if (results.length >= limit) break;
  }
  return results;
}
