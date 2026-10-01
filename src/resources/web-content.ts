import { requestPublic } from "./public-http.js";

const MAX_REDIRECTS = 5;
export const MAX_WEBPAGE_BYTES = 10 * 1024 * 1024;

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (_all, entity: string) => {
    if (entity[0] === "#") {
      const code = Number.parseInt(
        entity[1]?.toLowerCase() === "x" ? entity.slice(2) : entity.slice(1),
        entity[1]?.toLowerCase() === "x" ? 16 : 10,
      );
      return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "\uFFFD";
    }
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/gu, ""));
}

export async function fetchPublic(
  urlValue: string,
  options: { signal?: AbortSignal; accept?: string; maxBytes?: number } = {},
): Promise<{ url: string; mediaType: string; data: Buffer }> {
  const maxBytes = options.maxBytes ?? MAX_WEBPAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("maxBytes must be a positive safe integer.");
  let url = new URL(urlValue);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await requestPublic(url, { ...options, maxBytes });
    if ("redirect" in response) {
      const location = response.redirect;
      if (!location || redirect === MAX_REDIRECTS) throw new Error("Web page redirected too many times.");
      url = new URL(location, url);
      continue;
    }
    return {
      url: url.href,
      mediaType: response.mediaType,
      data: response.data,
    };
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
  } catch {
    return undefined;
  }
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
    const snippetMatch =
      /<(?:a|div)\b[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/iu.exec(
        following,
      );
    const snippet = stripTags(snippetMatch?.[1] ?? "")
      .replace(/\s+/gu, " ")
      .trim();
    results.push({ title, url, snippet });
    seen.add(url);
    if (results.length >= limit) break;
  }
  return results;
}
