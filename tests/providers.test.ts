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
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_GLM_BASE_URL,
  DEFAULT_GLM_CODING_PLAN_BASE_URL,
  DEFAULT_GLM_CODING_PLAN_MODEL,
  DEFAULT_GLM_MODEL,
  DEFAULT_KIMI_BASE_URL,
  DEFAULT_KIMI_MODEL,
  DEFAULT_QWEN_BASE_URL,
  DEFAULT_QWEN_MODEL,
  createDefaultEasyCodeConfig,
  loadEasyCodeConfig,
} from "../src/config/index.js";
import {
  DEFAULT_BASE_CONTEXT_CHAR_LIMIT,
  DEFAULT_BASE_STEP_LIMIT,
} from "../src/models/thinking.js";
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
subagent_isolation = "shared"
worktree_base_mode = "head"
worktree_root = "${path.join(temporary, "user-worktrees").replace(/\\/gu, "\\\\")}"

[limits]
max_context_chars = 410000
max_managed_worktrees = 11
[limits.steps]
none = 12

[providers.qwen]
model = "user-qwen"
base_url = "https://user-qwen.example/v1/"
timeout_ms = 31000

[providers.deepseek]
model = "user-deepseek"

[providers.kimi]
model = "user-kimi"
base_url = "https://user-kimi.example/coding/v1/"

[providers.glm]
model = "user-glm"
base_url = "https://user-glm.example/v4/"

[providers.glm-coding-plan]
model = "user-glm-coding-plan"
base_url = "https://user-glm-coding-plan.example/v4/"
`,
        "utf8",
      );
      await writeFile(
        path.join(workspace, ".easycode", "config.toml"),
        `mode = "code"
subagent_isolation = "auto"
worktree_base_mode = "current-snapshot"
[limits]
max_context_chars = 420000
max_managed_worktrees = 17
thread_resource_max_bytes = 73400320
[limits.steps]
none = 18

[providers.qwen]
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
          EASY_CODE_LIMITS_JSON: JSON.stringify({ steps: { none: 24 }, maxContextChars: 430000, maxContextTokens: 64000, maxManagedWorktrees: 23 }),
          EASY_CODE_SUBAGENT_ISOLATION: "worktree",
          EASY_CODE_WORKTREE_BASE_MODE: "fresh",
          EASY_CODE_WORKTREE_ROOT: path.join(temporary, "environment-worktrees"),
          EASY_CODE_QWEN_TIMEOUT_MS: "51000",
          QWEN_API_KEY: "qwen-env-key",
          DASHSCOPE_API_KEY: "fallback-key",
          DEEPSEEK_API_KEY: "deepseek-env-key",
          KIMI_API_KEY: "kimi-env-key",
          ZAI_API_KEY: "glm-env-key",
          GLM_CODING_PLAN_API_KEY: "glm-coding-plan-env-key",
        },
        credentialStore: false,
      });

      assert.equal(config.provider, "qwen");
      assert.equal(config.limits.maxContextTokens, 64000);
      assert.equal(config.mode, "code");
      assert.equal(config.thinkingEffort, "high");
      assert.equal(config.limits.steps.none, 24);
      assert.equal(config.limits.maxContextChars, 430_000);
      assert.equal(config.subagentIsolation, "worktree");
      assert.equal(config.worktreeBaseMode, "fresh");
      assert.equal(config.worktreeRoot, path.join(temporary, "environment-worktrees"));
      assert.equal(config.limits.maxManagedWorktrees, 23);
      assert.equal(config.limits.threadResourceMaxBytes, 73_400_320);
      assert.equal(config.providers.qwen!.apiKey, undefined);
      assert.equal(config.providers.qwen!.model, "workspace-qwen");
      assert.equal(config.providers.qwen!.baseUrl, "https://user-qwen.example/v1");
      assert.equal(config.providers.qwen!.timeoutMs, 51_000);
      assert.equal(config.providers.deepseek!.model, "user-deepseek");
      assert.equal(config.providers.deepseek!.apiKey, undefined);
      assert.equal(config.providers.kimi!.model, "user-kimi");
      assert.equal(config.providers.kimi!.baseUrl, "https://user-kimi.example/coding/v1");
      assert.equal(config.providers.kimi!.apiKey, undefined);
      assert.equal(config.providers.glm!.model, "user-glm");
      assert.equal(config.providers.glm!.baseUrl, "https://user-glm.example/v4");
      assert.equal(config.providers.glm!.apiKey, undefined);
      assert.equal(config.providers["glm-coding-plan"]!.model, "user-glm-coding-plan");
      assert.equal(
        config.providers["glm-coding-plan"]!.baseUrl,
        "https://user-glm-coding-plan.example/v4",
      );
      assert.equal(
        config.providers["glm-coding-plan"]!.apiKey,
        undefined,
      );
      assert.equal(config.workspaceRoot, path.resolve(workspace));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("provides all provider defaults while keeping GLM credentials separate", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-defaults-"));
    try {
      const config = await loadEasyCodeConfig({
        workspaceRoot: temporary,
        configDir: path.join(temporary, "config"),
        dataDir: path.join(temporary, "data"),
        cacheDir: path.join(temporary, "cache"),
        env: {
          DASHSCOPE_API_KEY: "dashscope-key",
          KIMI_API_KEY: "kimi-key",
          GLM_API_KEY: "glm-alias-key",
          GLM_CODING_PLAN_API_KEY: "glm-coding-plan-key",
        },
        credentialStore: false,
      });
      assert.equal(config.providers.qwen!.baseUrl, DEFAULT_QWEN_BASE_URL);
      assert.equal(config.thinkingEffort, "medium");
      assert.equal(config.limits.steps.none, DEFAULT_BASE_STEP_LIMIT);
      assert.equal(config.limits.maxContextChars, DEFAULT_BASE_CONTEXT_CHAR_LIMIT);
      assert.equal(config.subagentIsolation, "auto");
      assert.equal(config.worktreeBaseMode, "current-snapshot");
      assert.equal(config.worktreeRoot, path.join(temporary, "data", "worktrees"));
      assert.equal(config.limits.maxManagedWorktrees, 15);
      assert.equal(config.providers.qwen!.model, DEFAULT_QWEN_MODEL);
      assert.equal(config.providers.qwen!.timeoutMs, undefined);
      assert.equal(config.providers.qwen!.apiKey, undefined);
      assert.equal(config.providers.deepseek!.baseUrl, DEFAULT_DEEPSEEK_BASE_URL);
      assert.equal(config.providers.deepseek!.model, DEFAULT_DEEPSEEK_MODEL);
      assert.equal(config.providers.kimi!.baseUrl, DEFAULT_KIMI_BASE_URL);
      assert.equal(config.providers.kimi!.model, DEFAULT_KIMI_MODEL);
      assert.equal(config.providers.kimi!.apiKey, undefined);
      assert.equal(config.providers.glm!.baseUrl, DEFAULT_GLM_BASE_URL);
      assert.equal(config.providers.glm!.model, DEFAULT_GLM_MODEL);
      assert.equal(config.providers.glm!.apiKey, undefined);
      assert.equal(
        config.providers["glm-coding-plan"]!.baseUrl,
        DEFAULT_GLM_CODING_PLAN_BASE_URL,
      );
      assert.equal(config.providers["glm-coding-plan"]!.model, DEFAULT_GLM_CODING_PLAN_MODEL);
      assert.equal(
        config.providers["glm-coding-plan"]!.apiKey,
        undefined,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("never loads either GLM key from environment variables", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-glm-key-isolation-"));
    try {
      const standardOnly = await loadEasyCodeConfig({
        workspaceRoot: temporary,
        configDir: path.join(temporary, "config-standard"),
        dataDir: path.join(temporary, "data-standard"),
        cacheDir: path.join(temporary, "cache-standard"),
        env: { ZAI_API_KEY: "standard-only-key" },
        credentialStore: false,
      });
      assert.equal(standardOnly.providers.glm!.apiKey, undefined);
      assert.equal(standardOnly.providers["glm-coding-plan"]!.apiKey, undefined);

      const codingPlanOnly = await loadEasyCodeConfig({
        workspaceRoot: temporary,
        configDir: path.join(temporary, "config-plan"),
        dataDir: path.join(temporary, "data-plan"),
        cacheDir: path.join(temporary, "cache-plan"),
        env: { GLM_CODING_PLAN_API_KEY: "coding-plan-only-key" },
        credentialStore: false,
      });
      assert.equal(codingPlanOnly.providers.glm!.apiKey, undefined);
      assert.equal(
        codingPlanOnly.providers["glm-coding-plan"]!.apiKey,
        undefined,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("never inherits standard GLM model, endpoint, timeout, or retries into Coding Plan", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-glm-env-isolation-"));
    try {
      const config = await loadEasyCodeConfig({
        workspaceRoot: temporary,
        configDir: path.join(temporary, "config"),
        dataDir: path.join(temporary, "data"),
        cacheDir: path.join(temporary, "cache"),
        env: {
          EASY_CODE_GLM_BASE_URL: "https://standard.example/v4",
          EASY_CODE_GLM_MODEL: "glm-5.2",
          EASY_CODE_GLM_TIMEOUT_MS: "11111",
          EASY_CODE_GLM_MAX_RETRIES: "9",
          GLM_CODING_PLAN_API_KEY: "plan-key",
        },
        credentialStore: false,
      });
      assert.equal(config.providers.glm!.baseUrl, "https://standard.example/v4");
      assert.equal(config.providers.glm!.model, "glm-5.2");
      assert.equal(config.providers.glm!.timeoutMs, 11_111);
      assert.equal(config.providers.glm!.maxRetries, 9);
      assert.equal(config.providers["glm-coding-plan"]!.baseUrl, DEFAULT_GLM_CODING_PLAN_BASE_URL);
      assert.equal(config.providers["glm-coding-plan"]!.model, DEFAULT_GLM_CODING_PLAN_MODEL);
      assert.equal(config.providers["glm-coding-plan"]!.timeoutMs, undefined);
      assert.equal(config.providers["glm-coding-plan"]!.maxRetries, config.limits.maxProviderRetries);
      assert.equal(config.limits.maxProviderRetries, 5);
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
        `[providers.glm]\nbase_url = "https://attacker.invalid/v1"`,
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

  it("rejects workspace trust-root overrides for GLM Coding Plan", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-plan-trust-root-"));
    const workspaceConfigDir = path.join(temporary, ".easycode");
    try {
      await mkdir(workspaceConfigDir, { recursive: true });
      await writeFile(
        path.join(workspaceConfigDir, "config.toml"),
        `[providers.glm-coding-plan]\nbase_url = "https://attacker.invalid/coding"`,
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
          assert.match(error.message, /trust-root fields/u);
          assert.doesNotMatch(
            error.message,
            /workspace-plan-secret|attacker\.invalid/u,
          );
          return true;
        },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("OpenAI-compatible providers", () => {
  it("scales buffered request deadlines with the selected thinking effort", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.deepseek!.apiKey = "deepseek-key";
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

  it("uses the configured renewable idle deadline for streamed requests at every effort", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.deepseek!.apiKey = "deepseek-key";
    config.providers.deepseek!.timeoutMs = 42_000;
    const captured: Array<{ timeoutMs: number; timeoutMode: string; bufferedTimeoutMs?: number; stream: boolean }> = [];
    const provider = createProvider(config, "deepseek", undefined, {
      transport: async (request) => {
        captured.push({ timeoutMs: request.timeoutMs, timeoutMode: request.timeoutMode,
          bufferedTimeoutMs: request.bufferedTimeoutMs,
          stream: Boolean((JSON.parse(request.body) as { stream?: boolean }).stream) });
        return { statusCode: 200, headers: {}, body: JSON.stringify({ choices: [{
          finish_reason: "stop", message: { role: "assistant", content: "done" },
        }] }) };
      },
    });
    for (const thinkingEffort of ["none", "low", "medium", "high"] as const) {
      await provider.complete({ messages: [{ role: "user", content: "hello" }],
        thinkingEffort, responseMode: "stream" });
    }
    assert.deepEqual(captured, ["none", "low", "medium", "high"].map(() => ({
      timeoutMs: 60_000, timeoutMode: "stream_semantic_idle", bufferedTimeoutMs: 42_000, stream: true,
    })));
  });

  it("preserves an explicit timeout as an exact override", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.deepseek!.apiKey = "deepseek-key";
    config.providers.deepseek!.timeoutMs = 42_000;
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
    config.providers.deepseek!.apiKey = "deepseek-key";
    config.providers.deepseek!.maxRetries = 0;
    const provider = createProvider(config, "deepseek", undefined, {
      transport: async () => {
        throw new HttpTransportError("buffered_total_timeout", "test timeout");
      },
    });

    await assert.rejects(
      provider.complete({
        messages: [{ role: "user", content: "hello" }],
        thinkingEffort: "high",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.code, "buffered_total_timeout");
        assert.match(error.message, /600000ms/u);
        return true;
      },
    );
  });

  it("sends and parses native Chat Completions tool_calls", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.qwen!.apiKey = "test-qwen-key";
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
                      name: "start_command",
                      arguments: '{"program":"node","args":["build.cjs"],"intent":"build"}',
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
        name: "start_command",
        description: "Start a command",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            program: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            intent: { type: "string", enum: ["build"] },
          },
          required: ["program", "intent"],
        },
      },
    };
    const provider = createProvider(config, "qwen", undefined, { transport });
    const response = await provider.complete({
      messages: [{ role: "user", content: "Inspect the entry point" }],
      responseMode: "stream",
      tools: [tool],
      outputReserveTokens: 512,
      thinkingEffort: "medium",
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.url.href, `${DEFAULT_QWEN_BASE_URL}/chat/completions`);
    assert.equal(captured[0]?.headers.authorization, "Bearer test-qwen-key");
    const requestBody = JSON.parse(captured[0]?.body ?? "{}") as {
      model?: string;
      tools?: Array<{ function?: ToolDefinition["function"] }>;
      tool_stream?: boolean;
      max_tokens?: number;
      enable_thinking?: boolean;
      thinking_budget?: number;
    };
    assert.equal(requestBody.model, DEFAULT_QWEN_MODEL);
    assert.equal(requestBody.tools?.length, 1);
    assert.equal(requestBody.tool_stream, true);
    assert.deepEqual(requestBody.tools?.[0]?.function?.parameters, tool.function.parameters);
    assert.equal(
      "oneOf" in (requestBody.tools?.[0]?.function?.parameters ?? {}),
      false,
    );
    assert.equal(requestBody.max_tokens, undefined);
    assert.equal("max_completion_tokens" in requestBody, false);
    assert.equal("max_output_tokens" in requestBody, false);
    assert.equal("outputReserveTokens" in requestBody, false);
    assert.equal(requestBody.enable_thinking, undefined);
    assert.equal(requestBody.thinking_budget, undefined);
    assert.equal(response.message.tool_calls?.[0]?.id, "call_1");
    assert.equal(response.message.tool_calls?.[0]?.function.name, "start_command");
    assert.deepEqual(
      JSON.parse(response.message.tool_calls?.[0]?.function.arguments ?? "{}"),
      { program: "node", args: ["build.cjs"], intent: "build" },
    );
    assert.equal(response.message.reasoning_content, "inspect first");
    assert.equal(response.finishReason, "tool_calls");
    assert.equal(response.usage?.totalTokens, 18);
    assert.equal(response.usage?.cachedInputTokens, 5);
    assert.equal(response.usage?.reasoningTokens, 3);
  });

  it("round-trips all reasoning unchanged before provider serialization", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.deepseek!.apiKey = "test-deepseek-key";
    let captured: JsonPostRequest | undefined;
    const provider = createProvider(config, "deepseek", undefined, {
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
    });
    const messages = [
      { role: "user" as const, content: "inspect" },
      {
        role: "assistant" as const,
        content: "old answer",
        reasoning_content: "consumed reasoning",
      },
      { role: "user" as const, content: "run tests" },
      {
        role: "assistant" as const,
        content: null,
        reasoning_content: "active tool reasoning",
        tool_calls: [{
          id: "call_test",
          type: "function" as const,
          function: { name: "run_command", arguments: "{}" },
        }],
      },
      {
        role: "tool" as const,
        tool_call_id: "call_test",
        name: "run_command",
        content: "tests passed",
      },
    ];
    const durableSnapshot = structuredClone(messages);

    await provider.complete({ messages });

    const body = JSON.parse(captured?.body ?? "{}") as {
      messages?: Array<Record<string, unknown>>;
    };
    const assistants = body.messages?.filter((message) => message.role === "assistant") ?? [];
    assert.equal(assistants[0]?.reasoning_content, "consumed reasoning");
    assert.equal(assistants[1]?.reasoning_content, "active tool reasoning");
    assert.deepEqual(messages, durableSnapshot);
  });

  it("rejects malformed negative provider token usage", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.qwen!.apiKey = "test-qwen-key";
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
    providerConfig.providers.deepseek!.apiKey = "test-deepseek-key";
    providerConfig.providers.deepseek!.model = "deepseek-flash";
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
    providerConfig.providers.glm!.apiKey = "test-glm-key";
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

  it("leaves Chat Completions reasoning parameters to the provider default", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.deepseek!.apiKey = "deepseek-key";
    let captured: JsonPostRequest | undefined;
    const provider = createProvider(
      config,
      "deepseek",
      "deepseek-flash",
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
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal("enable_thinking" in body, false);
    assert.equal("thinking_budget" in body, false);
  });

  it("retries only up to maxRetries and honors model overrides", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.deepseek!.apiKey = "deepseek-key";
    config.providers.deepseek!.maxRetries = 2;
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

  it("lets an isolated Runtime request suppress hidden Provider retries", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.deepseek!.apiKey = "deepseek-key";
    config.providers.deepseek!.maxRetries = 3;
    let attempts = 0;
    const provider = createProvider(config, "deepseek", "deepseek-test-model", {
      transport: async () => {
        attempts += 1;
        return {
          statusCode: 503,
          headers: {},
          body: JSON.stringify({ error: { message: "temporarily unavailable" } }),
        };
      },
      sleep: async () => {
        throw new Error("retry delay must not run");
      },
    });

    await assert.rejects(
      provider.complete({
        messages: [{ role: "user", content: "hello" }],
        maxRetries: 0,
      }),
      /temporarily unavailable/u,
    );
    assert.equal(attempts, 1);
  });

  it("routes Kimi K3 through its registered endpoint without unsupported optional fields", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.kimi!.apiKey = "kimi-test-key";
    let captured: JsonPostRequest | undefined;
    const provider = createProvider(config, "kimi", "k3", {
      transport: async (request) => {
        captured = request;
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            choices: [{
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "done",
                reasoning_content: "checked the implementation",
              },
            }],
          }),
        };
      },
    });

    const response = await provider.complete({
      messages: [{ role: "user", content: "inspect" }],
      thinkingEffort: "high",
      temperature: 0,
    });

    assert.equal(provider.name, "kimi");
    assert.equal(captured?.url.href, `${DEFAULT_KIMI_BASE_URL}/chat/completions`);
    assert.equal(captured?.headers.authorization, "Bearer kimi-test-key");
    const body = JSON.parse(captured?.body ?? "{}") as {
      model?: string;
      temperature?: number;
      thinking?: { type?: string; keep?: string; effort?: string };
    };
    assert.equal(body.model, "k3");
    assert.equal(body.temperature, undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(response.message.reasoning_content, "checked the implementation");
  });

  it("routes GLM through the official OpenAI-compatible endpoint", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.glm!.apiKey = "glm-test-key";
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
      responseMode: "stream",
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
      tool_stream?: boolean;
      thinking?: { type?: string };
      reasoning_effort?: string;
    };
    assert.equal(body.model, "glm-5.3-flash");
    assert.equal(body.tools?.length, 1);
    assert.equal(body.tool_stream, true);
    assert.equal(body.tools?.[0]?.function?.strict, undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(response.message.tool_calls?.[0]?.function.name, "read_file");
    assert.equal(response.message.reasoning_content, "I will inspect the file.");
  });

  it("routes GLM Coding Plan through its dedicated endpoint and credential", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.providers.glm!.apiKey = "standard-glm-key";
    config.providers["glm-coding-plan"]!.apiKey = "coding-plan-key";
    let captured: JsonPostRequest | undefined;
    const provider = createProvider(
      config,
      "glm-coding-plan",
      "glm-5.3-flash",
      {
        transport: async (request) => {
          captured = request;
          return {
            statusCode: 200,
            headers: {},
            body: JSON.stringify({
              choices: [{
                finish_reason: "stop",
                message: { role: "assistant", content: "ok" },
              }],
            }),
          };
        },
      },
    );

    await provider.complete({
      messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(provider.name, "glm-coding-plan");
    assert.equal(
      captured?.url.href,
      `${DEFAULT_GLM_CODING_PLAN_BASE_URL}/chat/completions`,
    );
    assert.equal(captured?.headers.authorization, "Bearer coding-plan-key");
    assert.notEqual(captured?.headers.authorization, "Bearer standard-glm-key");
  });

  it("redacts credentials from API and transport errors", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    const secret = "sk-super-secret-value";
    config.providers.qwen!.apiKey = secret;
    config.providers.qwen!.maxRetries = 0;
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
  it("reports response headers and bounded body chunks in arrival order", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: one\n\n");
        response.end("data: two\n\n");
      },
      async (url) => {
        const starts: number[] = [];
        const chunks: Buffer[] = [];
        const result = await postJsonWithNode({
          url,
          headers: { "content-type": "application/json" },
          body: "{}",
          timeoutMs: 1_000,
          timeoutMode: "stream_semantic_idle",
          bufferedTimeoutMs: 2_000,
          maxResponseBytes: 1_024,
          onResponseStart: (response) => { starts.push(response.statusCode); return "stream"; },
          onResponseChunk: (chunk) => { chunks.push(Buffer.from(chunk)); return true; },
        });
        assert.deepEqual(starts, [200]);
        assert.equal(Buffer.concat(chunks).toString("utf8"), result.body);
        assert.equal(result.headers["content-type"], "text/event-stream");
      },
    );
  });

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
            timeoutMode: "buffered_total",
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
        timeoutMode: "buffered_total",
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
            timeoutMode: "buffered_total",
            maxResponseBytes: 1_024,
          }),
          (error: unknown) => {
            assert.ok(error instanceof HttpTransportError);
            assert.equal(error.kind, "buffered_total_timeout");
            return true;
          },
        );
      },
    );
  });

  it("renews a stream idle timeout only when the parser reports semantic progress", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        setTimeout(() => response.write("data: one\n\n"), 40);
        setTimeout(() => response.write("data: two\n\n"), 80);
        setTimeout(() => response.end("data: done\n\n"), 120);
      },
      async (url) => {
        const result = await postJsonWithNode({ url,
          headers: { "content-type": "application/json" }, body: "{}",
          timeoutMs: 70, timeoutMode: "stream_semantic_idle", bufferedTimeoutMs: 500,
          maxResponseBytes: 1_024,
          onResponseStart: () => "stream",
          onResponseChunk: (chunk) => chunk.toString("utf8").includes("data:") });
        assert.match(result.body, /done/u);
      },
    );
  });

  it("ignores SSE heartbeats when enforcing semantic stream idleness", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        const heartbeat = setInterval(() => {
          if (!response.destroyed) response.write(": keepalive\n\n");
        }, 10);
        response.once("close", () => clearInterval(heartbeat));
        setTimeout(() => { if (!response.destroyed) response.end("data: late\n\n"); }, 120);
      },
      async (url) => {
        await assert.rejects(postJsonWithNode({ url,
          headers: { "content-type": "application/json" }, body: "{}",
          timeoutMs: 40, timeoutMode: "stream_semantic_idle", bufferedTimeoutMs: 500,
          maxResponseBytes: 1_024,
          onResponseStart: () => "stream",
          onResponseChunk: () => false }),
        (error: unknown) => error instanceof HttpTransportError && error.kind === "stream_semantic_idle_timeout");
      },
    );
  });

  it("uses the fixed total deadline when a requested stream returns buffered JSON", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        setTimeout(() => {
          response.end('{"ok":true}');
        }, 80);
      },
      async (url) => {
        const result = await postJsonWithNode({ url,
          headers: { "content-type": "application/json" }, body: "{}",
          timeoutMs: 40, timeoutMode: "stream_semantic_idle", bufferedTimeoutMs: 150,
          maxResponseBytes: 1_024,
          onResponseStart: () => "buffered",
          onResponseChunk: () => false });
        assert.equal(result.body, '{"ok":true}');
      },
    );
  });

  it("reports a distinct timeout while waiting for stream response headers", async () => {
    await withServer(
      (_request, response) => {
        setTimeout(() => { if (!response.destroyed) response.end("late"); }, 120);
      },
      async (url) => {
        await assert.rejects(postJsonWithNode({ url,
          headers: { "content-type": "application/json" }, body: "{}",
          timeoutMs: 40, timeoutMode: "stream_semantic_idle", bufferedTimeoutMs: 500,
          maxResponseBytes: 1_024,
          onResponseStart: () => "stream",
          onResponseChunk: () => false }),
        (error: unknown) => error instanceof HttpTransportError && error.kind === "stream_header_timeout");
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
