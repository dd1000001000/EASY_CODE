import { z } from "zod";
import { DEFAULT_WEB_READER, type WebReader } from "../core/types.js";
import { isChallengePage, WebChallengeError } from "./anti-bot.js";
import { assertPublicDestination, WebHttpError } from "./public-http.js";
import { fetchPublic } from "./web-content.js";

export const WEBPAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
]);

const JINA_READER_ENDPOINT = "https://r.jina.ai/";
/** Jina renders the page in a browser; past this, reading directly is faster. */
const JINA_TIMEOUT_MS = 45_000;
/** Anonymous Jina Reader use is limited per minute; skip it for that long after a 429. */
const JINA_RATE_LIMIT_PAUSE_MS = 60_000;
/** The challenge markers appear near the top of a page. */
const CHALLENGE_SCAN_BYTES = 64 * 1024;

const jinaResponseSchema = z.object({
  data: z.object({
    title: z.string().optional(),
    url: z.string().optional(),
    content: z.string(),
    warning: z.string().optional(),
    httpStatus: z.number().optional(),
  }),
});

export interface FetchedWebpage {
  readonly url: string;
  readonly mediaType: string;
  readonly data: Buffer;
  /** Reader-supplied title; HTML pages take theirs from conversion. */
  readonly title?: string;
  readonly reader: WebReader;
  /** Why the configured Jina Reader was not used for this page. */
  readonly fallbackReason?: string;
}

export interface WebpageReaderDependencies {
  readonly fetch?: typeof fetchPublic;
  readonly assertPublic?: (url: URL, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Reads one public page for fetch_webpage. With Jina Reader selected, a rate limit,
 * an error, a page error or a challenge falls back to the direct request; a
 * challenge on the direct request is reported as such. Share one instance per
 * process so a rate-limit pause covers every conversation.
 */
export class WebpageReader {
  private readonly fetch: typeof fetchPublic;
  private readonly assertPublic: (url: URL, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private jinaPausedUntil = 0;

  constructor(
    readonly reader: WebReader = DEFAULT_WEB_READER,
    dependencies: WebpageReaderDependencies = {},
  ) {
    this.fetch = dependencies.fetch ?? fetchPublic;
    this.assertPublic = dependencies.assertPublic ?? assertPublicDestination;
    this.now = dependencies.now ?? Date.now;
  }

  async read(urlValue: string, options: { signal?: AbortSignal; maxBytes: number }): Promise<FetchedWebpage> {
    let fallbackReason: string | undefined;
    if (this.reader === "jina") {
      const url = new URL(urlValue);
      // Private and local destinations are refused before their names leave this machine.
      await this.assertPublic(url, options.signal);
      if (this.now() < this.jinaPausedUntil) {
        fallbackReason = "Jina Reader is rate limited";
      } else {
        try {
          return await this.readWithJina(url, options);
        } catch (error) {
          options.signal?.throwIfAborted();
          if (error instanceof WebHttpError && error.status === 429) {
            this.jinaPausedUntil = this.now() + JINA_RATE_LIMIT_PAUSE_MS;
            fallbackReason = "Jina Reader is rate limited";
          } else if (error instanceof WebChallengeError) {
            fallbackReason = "Jina Reader received a bot-protection challenge";
          } else {
            fallbackReason = `Jina Reader failed: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/u, "")}`;
          }
        }
      }
    }
    const response = await this.fetch(urlValue, { signal: options.signal, maxBytes: options.maxBytes });
    if (!WEBPAGE_MEDIA_TYPES.has(response.mediaType)) {
      throw new Error(`Unsupported Web content type: ${response.mediaType}.`);
    }
    if (isChallengePage(response.data.subarray(0, CHALLENGE_SCAN_BYTES).toString("utf8"))) {
      throw new WebChallengeError(response.url);
    }
    return { ...response, reader: "direct", ...(fallbackReason ? { fallbackReason } : {}) };
  }

  private async readWithJina(url: URL, options: { signal?: AbortSignal; maxBytes: number }): Promise<FetchedWebpage> {
    const timeout = AbortSignal.timeout(JINA_TIMEOUT_MS);
    const response = await this.fetch(`${JINA_READER_ENDPOINT}${url.href}`, {
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      accept: "application/json",
      maxBytes: options.maxBytes,
    });
    if (response.mediaType !== "application/json") {
      throw new Error(`it answered with ${response.mediaType}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(response.data.toString("utf8"));
    } catch {
      throw new Error("it answered with invalid JSON");
    }
    const parsed = jinaResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error("it answered without page content");
    const { title, content, warning, httpStatus } = parsed.data.data;
    if (httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300)) {
      throw new Error(`the page returned HTTP ${httpStatus}`);
    }
    const markdown = content.trim();
    if (!markdown) throw new Error("it found no readable content");
    if (
      warning?.toLowerCase().includes("requiring captcha") ||
      isChallengePage(`Title: ${title ?? ""}\n${markdown.slice(0, CHALLENGE_SCAN_BYTES)}`)
    ) {
      throw new WebChallengeError(url.href);
    }
    return {
      url: readerUrl(parsed.data.data.url) ?? url.href,
      mediaType: "text/markdown",
      data: Buffer.from(markdown, "utf8"),
      ...(title?.trim() ? { title: title.trim() } : {}),
      reader: "jina",
    };
  }
}

/** The page's address after redirects, when Jina reports a usable one. */
function readerUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
