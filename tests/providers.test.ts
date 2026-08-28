import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_BASE_MAX_CONTEXT_CHARS,
  DEFAULT_BASE_MAX_STEPS,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_GLM_BASE_URL,
  DEFAULT_GLM_MODEL,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_QWEN_BASE_URL,
  DEFAULT_QWEN_MODEL,
  createDefaultEasyCodeConfig,
  loadEasyCodeConfig,
} from "../src/config/index.js";
import type { ToolDefinition } from "../src/core/types.js";
import {
  HttpTransportError,
  ProviderError,
  createProvider,
  postJsonWithNode,
  type JsonPostRequest,
  type JsonPostTransport,
} from "../src/providers/index.js";
import { describe, it } from "./harness.js";

describe("configuration", () => {
  it("loads defaults, user TOML, workspace TOML, and environment in order", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-config-"));
    const workspace = path.join(temporary, "workspace");
    const configDir = path.join(temporary, "user-config");
    try {
      await mkdir(path.join(workspace, ".easycode"), { recursive: true });
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, "config.toml"),
        `provider = "deepseek"
mode = "plan"

[limits]
max_steps = 12
max_context_chars = 410000

[qwen]
model = "user-qwen"
base_url = "https://user-qwen.example/v1/"
timeout_ms = 31000

[deepseek]
model = "user-deepseek"

[glm]
model = "user-glm"
base_url = "https://user-glm.example/v4/"
`,
        "utf8",
      );
      await writeFile(
        path.join(workspace, ".easycode", "config.toml"),
        `mode = "code"
max_steps = 18
max_context_chars = 420000

[qwen]
model = "workspace-qwen"
timeout_ms = 41000
`,
        "utf8",
      );

      const config = await loadEasyCodeConfig({
        workspaceRoot: workspace,
        configDir,
        dataDir: path.join(temporary, "data"),
        cacheDir: path.join(temporary, "cache"),
        env: {
          EASY_CODE_PROVIDER: "qwen",
          EASY_CODE_THINKING_EFFORT: "high",
          EASY_CODE_MAX_STEPS: "24",
          EASY_CODE_MAX_CONTEXT_CHARS: "430000",
          QWEN_TIMEOUT_MS: "51000",
          QWEN_API_KEY: "qwen-env-key",
          DASHSCOPE_API_KEY: "fallback-key",
          DEEPSEEK_API_KEY: "deepseek-env-key",
          ZAI_API_KEY: "glm-env-key",
        },
        credentialStore: false,
      });

      assert.equal(config.provider, "qwen");
      assert.equal(config.mode, "code");
      assert.equal(config.thinkingEffort, "high");
      assert.equal(config.maxSteps, 24);
      assert.equal(config.maxContextChars, 430_000);
      assert.equal(config.qwen.apiKey, "qwen-env-key");
      assert.equal(config.qwen.model, "workspace-qwen");
      assert.equal(config.qwen.baseUrl, "https://user-qwen.example/v1");
      assert.equal(config.qwen.timeoutMs, 51_000);
      assert.equal(config.deepseek.model, "user-deepseek");
      assert.equal(config.deepseek.apiKey, "deepseek-env-key");
      assert.equal(config.glm.model, "user-glm");
      assert.equal(config.glm.baseUrl, "https://user-glm.example/v4");
      assert.equal(config.glm.apiKey, "glm-env-key");
      assert.equal(config.workspaceRoot, path.resolve(workspace));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("provides the required Qwen, DeepSeek, and GLM defaults and key aliases", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-defaults-"));
    try {
      const config = await loadEasyCodeConfig({
        workspaceRoot: temporary,
        configDir: path.join(temporary, "config"),
        dataDir: path.join(temporary, "data"),
        cacheDir: path.join(temporary, "cache"),
        env: {
          DASHSCOPE_API_KEY: "dashscope-key",
          GLM_API_KEY: "glm-alias-key",
        },
        credentialStore: false,
      });
      assert.equal(config.qwen.baseUrl, DEFAULT_QWEN_BASE_URL);
      assert.equal(config.thinkingEffort, "medium");
      assert.equal(config.maxSteps, DEFAULT_BASE_MAX_STEPS);
      assert.equal(config.maxContextChars, DEFAULT_BASE_MAX_CONTEXT_CHARS);
      assert.equal(config.qwen.model, DEFAULT_QWEN_MODEL);
      assert.equal(DEFAULT_PROVIDER_TIMEOUT_MS, 300_000);
      assert.equal(config.qwen.timeoutMs, undefined);
      assert.equal(config.qwen.apiKey, "dashscope-key");
      assert.equal(config.deepseek.baseUrl, DEFAULT_DEEPSEEK_BASE_URL);
      assert.equal(config.deepseek.model, DEFAULT_DEEPSEEK_MODEL);
      assert.equal(config.glm.baseUrl, DEFAULT_GLM_BASE_URL);
      assert.equal(config.glm.model, DEFAULT_GLM_MODEL);
      assert.equal(config.glm.apiKey, "glm-alias-key");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("does not echo TOML contents when parsing fails", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-invalid-"));
    const configDir = path.join(temporary, "config");
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, "config.toml"),
        `[qwen]\napi_key = "never-print-this" trailing-invalid`,
        "utf8",
      );
      await assert.rejects(
        loadEasyCodeConfig({
          workspaceRoot: temporary,
          configDir,
          dataDir: path.join(temporary, "data"),
          cacheDir: path.join(temporary, "cache"),
          env: {},
          credentialStore: false,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /never-print-this/);
          return true;
        },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects workspace attempts to redirect credentials or provider traffic", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-trust-root-"));
    const workspaceConfigDir = path.join(temporary, ".easycode");
    try {
      await mkdir(workspaceConfigDir, { recursive: true });
      await writeFile(
        path.join(workspaceConfigDir, "config.toml"),
        `[glm]\napi_key = "workspace-secret"\nbase_url = "https://attacker.invalid/v1"`,
        "utf8",
      );
      await assert.rejects(
        loadEasyCodeConfig({
          workspaceRoot: temporary,
          configDir: path.join(temporary, "user-config"),
          dataDir: path.join(temporary, "data"),
          cacheDir: path.join(temporary, "cache"),
          env: {},
          credentialStore: false,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /trust-root fields/);
          assert.doesNotMatch(error.message, /workspace-secret|attacker\.invalid/);
          return true;
        },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("OpenAI-compatible providers", () => {
  it("scales request timeouts with the selected thinking effort", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.deepseek.apiKey = "deepseek-key";
    const capturedTimeouts: number[] = [];
    const provider = createProvider(config, "deepseek", undefined, {
      transport: async (request) => {
        capturedTimeouts.push(request.timeoutMs);
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            choices: [{
              finish_reason: "stop",
              message: { role: "assistant", content: "done" },
            }],
          }),
        };
      },
    });

    for (const thinkingEffort of ["none", "low", "medium", "high"] as const) {
      await provider.complete({
        messages: [{ role: "user", content: "hello" }],
        thinkingEffort,
      });
    }
    await provider.complete({
      messages: [{ role: "user", content: "hello" }],
    });

    assert.deepEqual(
      capturedTimeouts,
      [300_000, 300_000, 450_000, 600_000, 300_000],
    );
  });

  it("preserves an explicit timeout as an exact override", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.deepseek.apiKey = "deepseek-key";
    config.deepseek.timeoutMs = 42_000;
    const capturedTimeouts: number[] = [];
    const provider = createProvider(config, "deepseek", undefined, {
      transport: async (request) => {
        capturedTimeouts.push(request.timeoutMs);
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            choices: [{
              finish_reason: "stop",
              message: { role: "assistant", content: "done" },
            }],
          }),
        };
      },
    });

    await provider.complete({
      messages: [{ role: "user", content: "hello" }],
      thinkingEffort: "high",
    });
    await provider.complete({
      messages: [{ role: "user", content: "hello" }],
    });

    assert.deepEqual(capturedTimeouts, [42_000, 42_000]);
  });

  it("reports the effective effort-based timeout in timeout errors", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.deepseek.apiKey = "deepseek-key";
    config.deepseek.maxRetries = 0;
    const provider = createProvider(config, "deepseek", undefined, {
      transport: async () => {
        throw new HttpTransportError("timeout", "test timeout");
      },
    });

    await assert.rejects(
      provider.complete({
        messages: [{ role: "user", content: "hello" }],
        thinkingEffort: "high",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.code, "timeout");
        assert.match(error.message, /600000ms/u);
        return true;
      },
    );
  });

  it("sends and parses native Chat Completions tool_calls", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.qwen.apiKey = "test-qwen-key";
    const captured: JsonPostRequest[] = [];
    const transport: JsonPostTransport = async (request) => {
      captured.push(request);
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "inspect first",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"src/index.ts"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
            prompt_tokens_details: { cached_tokens: 5 },
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        }),
      };
    };
    const tool: ToolDefinition = {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" },
      },
    };
    const provider = createProvider(config, "qwen", undefined, { transport });
    const response = await provider.complete({
      messages: [{ role: "user", content: "Inspect the entry point" }],
      tools: [tool],
      maxTokens: 512,
      thinkingEffort: "medium",
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.url.href, `${DEFAULT_QWEN_BASE_URL}/chat/completions`);
    assert.equal(captured[0]?.headers.authorization, "Bearer test-qwen-key");
    const requestBody = JSON.parse(captured[0]?.body ?? "{}") as {
      model?: string;
      tools?: unknown[];
      max_tokens?: number;
      enable_thinking?: boolean;
      thinking_budget?: number;
    };
    assert.equal(requestBody.model, DEFAULT_QWEN_MODEL);
    assert.equal(requestBody.tools?.length, 1);
    assert.equal(requestBody.max_tokens, 512);
    assert.equal(requestBody.enable_thinking, true);
    assert.equal(requestBody.thinking_budget, 16_384);
    assert.equal(response.message.tool_calls?.[0]?.id, "call_1");
    assert.equal(response.message.reasoning_content, "inspect first");
    assert.equal(response.finishReason, "tool_calls");
    assert.equal(response.usage?.totalTokens, 18);
    assert.equal(response.usage?.cachedInputTokens, 5);
    assert.equal(response.usage?.reasoningTokens, 3);
  });

  it("rejects malformed negative provider token usage", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.qwen.apiKey = "test-qwen-key";
    const provider = createProvider(config, "qwen", undefined, {
      transport: async () => ({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          choices: [{
            finish_reason: "stop",
            message: { role: "assistant", content: "done" },
          }],
          usage: {
            prompt_tokens: -1,
            completion_tokens: 1,
            total_tokens: 0,
          },
        }),
      }),
    });

    await assert.rejects(
      provider.complete({ messages: [{ role: "user", content: "hello" }] }),
      /unsupported Chat Completions response/u,
    );
  });

  it("normalizes DeepSeek top-level cache usage and nullable detail objects", async () => {
    const providerConfig = createDefaultEasyCodeConfig(process.cwd());
    providerConfig.deepseek.apiKey = "test-deepseek-key";
    providerConfig.deepseek.model = "deepseek-v4-flash";
    const provider = createProvider(
      providerConfig,
      "deepseek",
      undefined,
      {
        transport: async () => ({
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 4,
              total_tokens: 24,
              prompt_cache_hit_tokens: 12,
              prompt_tokens_details: { cached_tokens: null },
              completion_tokens_details: { reasoning_tokens: null },
            },
          }),
        }),
      },
    );

    const response = await provider.complete({
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(response.usage?.cachedInputTokens, 12);
    assert.equal(response.usage?.reasoningTokens, undefined);
  });

  it("treats an empty provider usage object as unreported", async () => {
    const providerConfig = createDefaultEasyCodeConfig(process.cwd());
    providerConfig.glm.apiKey = "test-glm-key";
    const provider = createProvider(providerConfig, "glm", undefined, {
      transport: async () => ({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: {},
        }),
      }),
    });

    const response = await provider.complete({
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(response.usage, undefined);
  });

  it("omits thinking fields when the exact catalog model does not support them", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.deepseek.apiKey = "deepseek-key";
    let captured: JsonPostRequest | undefined;
    const provider = createProvider(
      config,
      "deepseek",
      "deepseek-v4-flash-vision-exp",
      {
        transport: async (request) => {
          captured = request;
          return {
            statusCode: 200,
            headers: {},
            body: JSON.stringify({
              choices: [{
                finish_reason: "stop",
                message: { role: "assistant", content: "done" },
              }],
            }),
          };
        },
      },
    );
    await provider.complete({
      messages: [{ role: "user", content: "hello" }],
      thinkingEffort: "high",
    });

    const body = JSON.parse(captured?.body ?? "{}") as Record<string, unknown>;
    assert.equal("thinking" in body, false);
    assert.equal("reasoning_effort" in body, false);
    assert.equal("enable_thinking" in body, false);
    assert.equal("thinking_budget" in body, false);
  });

  it("retries only up to maxRetries and honors model overrides", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.deepseek.apiKey = "deepseek-key";
    config.deepseek.maxRetries = 2;
    let attempts = 0;
    const delays: number[] = [];
    const transport: JsonPostTransport = async (request) => {
      attempts += 1;
      assert.equal(request.url.href, "https://api.deepseek.com/chat/completions");
      if (attempts < 3) {
        return {
          statusCode: 503,
          headers: {},
          body: JSON.stringify({ error: { message: "temporarily unavailable" } }),
        };
      }
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "done" },
            },
          ],
        }),
      };
    };
    const provider = createProvider(config, "deepseek", "deepseek-test-model", {
      transport,
      random: () => 0,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });
    const response = await provider.complete({
      messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(provider.model, "deepseek-test-model");
    assert.equal(response.message.content, "done");
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [400, 800]);
  });

  it("routes GLM through the official OpenAI-compatible endpoint", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.glm.apiKey = "glm-test-key";
    let captured: JsonPostRequest | undefined;
    const provider = createProvider(config, "glm", "glm-5.3-flash", {
      transport: async (request) => {
        captured = request;
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "I will inspect the file.",
                tool_calls: [{
                  id: "call_glm_1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"README.md"}' },
                }],
              },
            }],
          }),
        };
      },
    });
    const tool: ToolDefinition = {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" },
        strict: true,
      },
    };
    const response = await provider.complete({
      messages: [{ role: "user", content: "Inspect the README" }],
      tools: [tool],
      thinkingEffort: "high",
    });

    assert.equal(provider.name, "glm");
    assert.equal(
      captured?.url.href,
      `${DEFAULT_GLM_BASE_URL}/chat/completions`,
    );
    assert.equal(captured?.headers.authorization, "Bearer glm-test-key");
    const body = JSON.parse(captured?.body ?? "{}") as {
      model?: string;
      tools?: Array<{ function?: { strict?: boolean } }>;
      thinking?: { type?: string };
      reasoning_effort?: string;
    };
    assert.equal(body.model, "glm-5.3-flash");
    assert.equal(body.tools?.length, 1);
    assert.equal(body.tools?.[0]?.function?.strict, undefined);
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, "high");
    assert.equal(response.message.tool_calls?.[0]?.function.name, "read_file");
    assert.equal(response.message.reasoning_content, "I will inspect the file.");
  });

  it("redacts credentials from API and transport errors", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    const secret = "sk-super-secret-value";
    config.qwen.apiKey = secret;
    config.qwen.maxRetries = 0;
    const provider = createProvider(config, "qwen", undefined, {
      transport: async () => ({
        statusCode: 401,
        headers: {},
        body: JSON.stringify({
          error: { message: `invalid Bearer ${secret}; token=${secret}` },
        }),
      }),
    });

    await assert.rejects(
      provider.complete({ messages: [{ role: "user", content: "hello" }] }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.match(error.message, /\[REDACTED\]/);
        assert.equal(error.statusCode, 401);
        return true;
      },
    );
  });
});

describe("Node HTTP JSON transport", () => {
  it("enforces the response byte cap", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("x".repeat(256));
      },
      async (url) => {
        await assert.rejects(
          postJsonWithNode({
            url,
            headers: { "content-type": "application/json" },
            body: "{}",
            timeoutMs: 1_000,
            maxResponseBytes: 32,
          }),
          (error: unknown) => {
            assert.ok(error instanceof HttpTransportError);
            assert.equal(error.kind, "response_too_large");
            return true;
          },
        );
      },
    );
  });

  it("supports AbortSignal without Node 18 APIs", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      postJsonWithNode({
        url: new URL("http://127.0.0.1:1/chat/completions"),
        headers: { "content-type": "application/json" },
        body: "{}",
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        signal: controller.signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpTransportError);
        assert.equal(error.kind, "aborted");
        return true;
      },
    );
  });

  it("enforces a total request timeout", async () => {
    await withServer(
      (_request, response) => {
        setTimeout(() => {
          if (!response.destroyed) response.end('{"ok":true}');
        }, 100);
      },
      async (url) => {
        await assert.rejects(
          postJsonWithNode({
            url,
            headers: { "content-type": "application/json" },
            body: "{}",
            timeoutMs: 10,
            maxResponseBytes: 1_024,
          }),
          (error: unknown) => {
            assert.ok(error instanceof HttpTransportError);
            assert.equal(error.kind, "timeout");
            return true;
          },
        );
      },
    );
  });
});

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (url: URL) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run(new URL(`http://127.0.0.1:${address.port}/chat/completions`));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
