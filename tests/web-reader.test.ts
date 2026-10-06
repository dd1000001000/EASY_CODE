import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEasyCodeConfig } from "../src/config/loader.js";
import type { ToolContext } from "../src/core/types.js";
import { isChallengePage, WebChallengeError } from "../src/resources/anti-bot.js";
import { DocumentConverter, ThreadDocumentService, ThreadResourceStore } from "../src/resources/index.js";
import { WebHttpError } from "../src/resources/public-http.js";
import type { fetchPublic } from "../src/resources/web-content.js";
import { WebpageReader } from "../src/resources/web-reader.js";
import { FetchWebpageTool } from "../src/tools/fetch-webpage.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

type FetchOptions = Parameters<typeof fetchPublic>[1];
type FetchResult = Awaited<ReturnType<typeof fetchPublic>>;

const PAGE = "https://example.com/docs/page";
const DIRECT_HTML = "<html><head><title>Docs</title></head><body>Direct body</body></html>";
const CLOUDFLARE_CHALLENGE =
  "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>" +
  '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';

function jina(data: Record<string, unknown>): FetchResult {
  return {
    url: `https://r.jina.ai/${PAGE}`,
    mediaType: "application/json",
    data: Buffer.from(JSON.stringify({ code: 200, status: 20000, data })),
  };
}

function direct(body = DIRECT_HTML, mediaType = "text/html"): FetchResult {
  return { url: PAGE, mediaType, data: Buffer.from(body) };
}

/** A scripted public transport: Jina requests and direct requests answer separately. */
function transport(answers: { jina?: () => FetchResult | Promise<FetchResult>; direct?: () => FetchResult }) {
  const calls: Array<{ url: string; options: FetchOptions }> = [];
  const fetch = (async (url: string, options?: FetchOptions) => {
    calls.push({ url, options });
    if (url.startsWith("https://r.jina.ai/")) {
      if (!answers.jina) throw new Error("unexpected Jina request");
      return answers.jina();
    }
    return (answers.direct ?? (() => direct()))();
  }) as typeof fetchPublic;
  return { fetch, calls, jinaCalls: () => calls.filter((call) => call.url.startsWith("https://r.jina.ai/")).length };
}

const allowPublic = async () => {};

function context(root: string): ToolContext {
  return {
    workspaceRoot: root,
    mode: "code",
    threadId: "thread_web_reader_test",
    turnId: "turn_web_reader_test",
    approvalPolicy: "safe",
    requestApproval: async () => false,
    commandTimeoutMs: 2_000,
    maxOutputChars: 16_000,
  };
}

describe("bot-protection challenge pages", () => {
  it("recognizes challenge pages from HTML and reader Markdown", () => {
    assert.equal(isChallengePage(CLOUDFLARE_CHALLENGE), true);
    assert.equal(
      isChallengePage("Title: Just a moment...\n\n## Performing security verification\n\nVerify you are human."),
      true,
    );
    assert.equal(
      isChallengePage("<html><head><title>Attention Required! | Cloudflare</title></head><body>Ray ID</body></html>"),
      true,
    );
    assert.equal(
      isChallengePage(
        '<html><body><iframe src="https://geo.captcha-delivery.com/captcha/?cid=1"></iframe></body></html>',
      ),
      true,
    );
    assert.equal(isChallengePage('<html><body><div id="px-captcha"></div></body></html>'), true);
  });

  it("leaves ordinary pages served behind a bot-protection service alone", () => {
    // Cloudflare injects this script into normal pages too.
    assert.equal(
      isChallengePage(
        '<html><head><title>Release notes</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head></html>',
      ),
      false,
    );
    assert.equal(
      isChallengePage("<html><head><title>Just a moment...</title></head><body>A poem.</body></html>"),
      false,
    );
    assert.equal(isChallengePage("# Using CAPTCHAs\n\nThis guide explains requiring CAPTCHA on sign-up forms."), false);
  });
});

describe("Web page reader", () => {
  it("reads directly by default and reports a challenge instead of saving it", async () => {
    const plain = transport({});
    const page = await new WebpageReader("direct", { fetch: plain.fetch }).read(PAGE, { maxBytes: 1024 });
    assert.equal(page.reader, "direct");
    assert.equal(page.fallbackReason, undefined);
    assert.equal(page.data.toString(), DIRECT_HTML);
    assert.equal(plain.jinaCalls(), 0);

    const challenged = transport({ direct: () => direct(CLOUDFLARE_CHALLENGE) });
    await assert.rejects(
      new WebpageReader("direct", { fetch: challenged.fetch }).read(PAGE, { maxBytes: 1024 }),
      (error: unknown) => error instanceof WebChallengeError && /example\.com .*bot-protection/u.test(error.message),
    );
    const binary = transport({ direct: () => direct("%PDF", "application/pdf") });
    await assert.rejects(
      new WebpageReader("direct", { fetch: binary.fetch }).read(PAGE, { maxBytes: 1024 }),
      /Unsupported Web content type: application\/pdf/u,
    );
  });

  it("reads through Jina Reader when selected", async () => {
    const remote = transport({
      jina: () =>
        jina({ title: " Example Docs ", url: "https://example.com/docs/final", content: "\n## Guide\n\nText\n" }),
    });
    const page = await new WebpageReader("jina", { fetch: remote.fetch, assertPublic: allowPublic }).read(PAGE, {
      maxBytes: 4096,
    });
    assert.equal(page.reader, "jina");
    assert.equal(page.url, "https://example.com/docs/final");
    assert.equal(page.title, "Example Docs");
    assert.equal(page.mediaType, "text/markdown");
    assert.equal(page.data.toString(), "## Guide\n\nText");
    assert.equal(remote.calls.length, 1);
    assert.equal(remote.calls[0]!.url, `https://r.jina.ai/${PAGE}`);
    assert.equal(remote.calls[0]!.options?.accept, "application/json");
    assert.equal(remote.calls[0]!.options?.maxBytes, 4096);
    assert.ok(remote.calls[0]!.options?.signal);
  });

  it("falls back to a direct request when Jina Reader cannot read the page", async () => {
    const cases: Array<[string, () => FetchResult, RegExp]> = [
      [
        "service error",
        () => {
          throw new WebHttpError(503);
        },
        /^Jina Reader failed: Web request failed with HTTP 503$/u,
      ],
      ["page error", () => jina({ content: "Not here", httpStatus: 404 }), /the page returned HTTP 404/u],
      ["empty page", () => jina({ content: "  \n" }), /no readable content/u],
      [
        "not JSON",
        () => ({ url: "https://r.jina.ai/x", mediaType: "text/plain", data: Buffer.from("Title: x") }),
        /answered with text\/plain/u,
      ],
      ["malformed", () => ({ ...jina({}), data: Buffer.from("{") }), /invalid JSON/u],
      ["no content", () => jina({ title: "x" }), /without page content/u],
      [
        "challenge",
        () => jina({ title: "Just a moment...", content: "## Performing security verification" }),
        /bot-protection challenge/u,
      ],
      [
        "captcha warning",
        () =>
          jina({
            content: "Sign in",
            warning: "This page maybe requiring CAPTCHA, please make sure you are authorized.",
          }),
        /bot-protection challenge/u,
      ],
    ];
    for (const [name, answer, reason] of cases) {
      const remote = transport({ jina: answer });
      const page = await new WebpageReader("jina", { fetch: remote.fetch, assertPublic: allowPublic }).read(PAGE, {
        maxBytes: 1024,
      });
      assert.equal(page.reader, "direct", name);
      assert.equal(page.data.toString(), DIRECT_HTML, name);
      assert.match(page.fallbackReason ?? "", reason, name);
      assert.equal(remote.calls.length, 2, name);
    }
  });

  it("pauses Jina Reader for a minute after it rate-limits a request", async () => {
    let now = 1_000_000;
    let limited = true;
    const remote = transport({
      jina: () => {
        if (limited) throw new WebHttpError(429);
        return jina({ content: "Fresh" });
      },
    });
    const reader = new WebpageReader("jina", { fetch: remote.fetch, assertPublic: allowPublic, now: () => now });
    const first = await reader.read(PAGE, { maxBytes: 1024 });
    assert.equal(first.reader, "direct");
    assert.equal(first.fallbackReason, "Jina Reader is rate limited");
    limited = false;
    now += 59_000;
    const paused = await reader.read(PAGE, { maxBytes: 1024 });
    assert.equal(paused.fallbackReason, "Jina Reader is rate limited");
    assert.equal(remote.jinaCalls(), 1);
    now += 1_000;
    assert.equal((await reader.read(PAGE, { maxBytes: 1024 })).reader, "jina");
    assert.equal(remote.jinaCalls(), 2);
  });

  it("keeps private destinations away from Jina Reader and stops on cancellation", async () => {
    const remote = transport({ jina: () => jina({ content: "never" }) });
    const refuse = async () => {
      throw new Error("Private or local network destinations are not allowed.");
    };
    await assert.rejects(
      new WebpageReader("jina", { fetch: remote.fetch, assertPublic: refuse }).read("http://intranet.corp/", {
        maxBytes: 1024,
      }),
      /Private or local/u,
    );
    assert.equal(remote.calls.length, 0);

    const controller = new AbortController();
    const cancelled = transport({
      jina: () => {
        controller.abort(new Error("cancelled by user"));
        throw new Error("aborted");
      },
    });
    await assert.rejects(
      new WebpageReader("jina", { fetch: cancelled.fetch, assertPublic: allowPublic }).read(PAGE, {
        maxBytes: 1024,
        signal: controller.signal,
      }),
      /cancelled by user/u,
    );
    assert.equal(cancelled.calls.length, 1);
  });

  it("saves a Jina Reader page under its title and says how the page was read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-web-reader-workspace-"));
    const data = await mkdtemp(path.join(os.tmpdir(), "easy-code-web-reader-data-"));
    try {
      const workspace = await WorkspaceManager.create(root);
      const store = new ThreadResourceStore(data);
      const documents = new ThreadDocumentService(new DocumentConverter(data), store);
      const remote = transport({ jina: () => jina({ title: "Example Docs", url: PAGE, content: "## Guide" }) });
      const tool = new FetchWebpageTool(
        workspace,
        documents,
        new WebpageReader("jina", { fetch: remote.fetch, assertPublic: allowPublic }),
      );
      const saved = await tool.execute({ url: PAGE }, context(root));
      assert.equal(saved.ok, true, saved.error);
      assert.match(saved.summary, /^Saved https:\/\/example\.com\/docs\/page through Jina Reader as read-only/u);
      const attachment = saved.data as { uri: string; filename: string };
      assert.equal(attachment.filename, "Example Docs.md");
      const content = (await store.readLines("thread_web_reader_test", attachment.uri, 1, 10)).lines.join("\n");
      assert.match(content, /^# Example Docs\n\nSource: https:\/\/example\.com\/docs\/page\n\n## Guide/u);

      const fallback = new FetchWebpageTool(
        workspace,
        documents,
        new WebpageReader("jina", {
          fetch: transport({
            jina: () => {
              throw new WebHttpError(429);
            },
            direct: () => direct("Plain text page", "text/plain"),
          }).fetch,
          assertPublic: allowPublic,
        }),
      );
      const direct429 = await fallback.execute({ url: PAGE }, context(root));
      assert.equal(direct429.ok, true, direct429.error);
      assert.match(direct429.summary, /with a direct request \(Jina Reader is rate limited\) as read-only/u);

      const blocked = new FetchWebpageTool(
        workspace,
        documents,
        new WebpageReader("direct", { fetch: transport({ direct: () => direct(CLOUDFLARE_CHALLENGE) }).fetch }),
      );
      const challenge = await blocked.execute({ url: PAGE }, context(root));
      assert.equal(challenge.ok, false);
      assert.match(challenge.error ?? "", /bot-protection challenge .*Do not retry this URL/u);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });
});

describe("web_reader configuration", () => {
  it("defaults to direct reads and accepts Jina Reader only from the user or the environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-web-reader-config-"));
    try {
      const configDir = path.join(root, "config");
      await mkdir(configDir);
      const load = (env: NodeJS.ProcessEnv = {}) =>
        loadEasyCodeConfig({ workspaceRoot: root, configDir, env, credentialStore: false });
      assert.equal((await load()).webReader, "direct");
      assert.equal((await load({ EASY_CODE_WEB_READER: "jina" })).webReader, "jina");
      await writeFile(path.join(configDir, "config.toml"), 'web_reader = "jina"\n');
      assert.equal((await load()).webReader, "jina");
      assert.equal((await load({ EASY_CODE_WEB_READER: "direct" })).webReader, "direct");
      await assert.rejects(load({ EASY_CODE_WEB_READER: "exa" }), /webReader/u);
      await writeFile(path.join(configDir, "config.toml"), "web_reader = true\n");
      await assert.rejects(load(), /webReader/u);
      await writeFile(path.join(configDir, "config.toml"), "");
      await mkdir(path.join(root, ".easycode"));
      await writeFile(path.join(root, ".easycode", "config.toml"), 'web_reader = "jina"\n');
      await assert.rejects(load(), /cannot set trust-root fields: web_reader/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
