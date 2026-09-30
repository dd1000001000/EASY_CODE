import assert from "node:assert/strict";

import { createDefaultEasyCodeConfig } from "../src/config/defaults.js";
import { PACKAGED_MODEL_REGISTRY_SOURCE, activateModelRegistry } from "../src/models/catalog.js";
import { createProvider } from "../src/providers/factory.js";
import { ProviderError } from "../src/providers/errors.js";
import { HttpTransportError, type JsonPostRequest } from "../src/providers/http-transport.js";
import { describe, it } from "./harness.js";

const RESPONSES_REGISTRY = `schema_version = 1
default_model = "coder"
[providers.openai-like]
name = "OpenAI-like"
base_url = "https://models.example/v1"
env_key = "OPENAI_LIKE_API_KEY"
wire_api = "responses"
max_retries = 0
[models.coder]
name = "Coder"
provider = "openai-like"
model = "coder-1"
context_window = 131072
input_modalities = ["text"]
tool_calling = true
reasoning = true
`;

describe("Responses provider", () => {
  it("serializes normalized tools and parses text, reasoning, calls and usage", async () => {
    activateModelRegistry(RESPONSES_REGISTRY, "responses test registry");
    try {
      const config = createDefaultEasyCodeConfig(process.cwd());
      config.providers["openai-like"]!.apiKey = "test-key";
      let request: JsonPostRequest | undefined;
      const provider = createProvider(config, "openai-like", undefined, {
        transport: async (input) => {
          request = input;
          return {
            statusCode: 200,
            headers: {},
            body: JSON.stringify({
              status: "completed",
              output: [
                { type: "reasoning", summary: [{ type: "summary_text", text: "checked" }] },
                { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
                { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' },
              ],
              usage: {
                input_tokens: 10,
                output_tokens: 4,
                total_tokens: 14,
                input_tokens_details: { cached_tokens: 6 },
              },
            }),
          };
        },
      });
      const response = await provider.complete({
        messages: [{ role: "user", content: "inspect" }],
        thinkingEffort: "high",
        outputReserveTokens: 512,
        tools: [
          {
            type: "function",
            function: { name: "read_file", description: "read", parameters: { type: "object" }, strict: true },
          },
        ],
      });
      assert.equal(request?.url.href, "https://models.example/v1/responses");
      const body = JSON.parse(request!.body) as Record<string, unknown>;
      assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
      assert.deepEqual(body.input, [{ role: "user", content: "inspect" }]);
      assert.deepEqual((body.tools as unknown[])[0], {
        type: "function",
        name: "read_file",
        description: "read",
        parameters: { type: "object" },
        strict: true,
      });
      assert.equal("max_output_tokens" in body, false);
      assert.equal(response.message.content, "done");
      assert.equal(response.message.reasoning_content, "checked");
      assert.equal(response.message.tool_calls?.[0]?.function.name, "read_file");
      assert.equal(response.usage?.cachedInputTokens, 6);
    } finally {
      activateModelRegistry(PACKAGED_MODEL_REGISTRY_SOURCE, "packaged test registry");
    }
  });

  it("reports cancellation during retry backoff as a ProviderError, like chat completions", async () => {
    const cancelDuringBackoff = async (providerName: string): Promise<void> => {
      const config = createDefaultEasyCodeConfig(process.cwd());
      config.providers[providerName]!.apiKey = "test-key";
      config.providers[providerName]!.maxRetries = 2;
      const controller = new AbortController();
      let attempts = 0;
      const provider = createProvider(config, providerName, undefined, {
        transport: async () => {
          attempts += 1;
          return { statusCode: 503, headers: {}, body: JSON.stringify({ error: { message: "busy" } }) };
        },
        sleep: async () => {
          controller.abort();
          throw new HttpTransportError("aborted", "Request was canceled");
        },
      });
      const error = await provider
        .complete({ messages: [{ role: "user", content: "hello" }], signal: controller.signal })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      assert.ok(error instanceof ProviderError, `${providerName} must normalize a backoff cancellation`);
      assert.equal(error.code, "aborted");
      assert.equal(attempts, 1);
    };

    activateModelRegistry(RESPONSES_REGISTRY, "responses test registry");
    try {
      await cancelDuringBackoff("openai-like");
    } finally {
      activateModelRegistry(PACKAGED_MODEL_REGISTRY_SOURCE, "packaged test registry");
    }
    await cancelDuringBackoff("deepseek");
  });

  it("waits for Retry-After when present and otherwise uses exponential backoff", async () => {
    const backoff = async (headers: Record<string, string>): Promise<{ delays: number[]; message: string }> => {
      const config = createDefaultEasyCodeConfig(process.cwd());
      config.providers["openai-like"]!.apiKey = "test-key";
      config.providers["openai-like"]!.maxRetries = 1;
      const delays: number[] = [];
      const provider = createProvider(config, "openai-like", undefined, {
        transport: async () => ({
          statusCode: 429,
          headers,
          body: JSON.stringify({ error: { message: "slow down" } }),
        }),
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        random: () => 0.5,
      });
      const error = await provider.complete({ messages: [{ role: "user", content: "hello" }] }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      assert.ok(error instanceof ProviderError);
      return { delays, message: error.message };
    };

    activateModelRegistry(RESPONSES_REGISTRY, "responses test registry");
    try {
      const advised = await backoff({ "retry-after": "2", "x-request-id": "req_123" });
      assert.deepEqual(advised.delays, [2_000]);
      assert.match(advised.message, /HTTP 429 \(request req_123\): slow down/u);
      const unadvised = await backoff({});
      assert.deepEqual(unadvised.delays, [500]);
      assert.match(unadvised.message, /HTTP 429: slow down/u);
    } finally {
      activateModelRegistry(PACKAGED_MODEL_REGISTRY_SOURCE, "packaged test registry");
    }
  });

  it("uses registry capabilities to omit unsupported native tools", async () => {
    activateModelRegistry(
      RESPONSES_REGISTRY.replace("tool_calling = true", "tool_calling = false"),
      "tool-free responses registry",
    );
    try {
      const config = createDefaultEasyCodeConfig(process.cwd());
      config.providers["openai-like"]!.apiKey = "test-key";
      let request: JsonPostRequest | undefined;
      const provider = createProvider(config, "openai-like", undefined, {
        transport: async (input) => {
          request = input;
          return { statusCode: 200, headers: {}, body: JSON.stringify({ status: "completed", output: [] }) };
        },
      });
      await provider.complete({
        messages: [{ role: "user", content: "answer directly" }],
        tools: [
          { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } },
        ],
      });
      const body = JSON.parse(request!.body) as Record<string, unknown>;
      assert.equal("tools" in body, false);
      assert.equal("parallel_tool_calls" in body, false);
    } finally {
      activateModelRegistry(PACKAGED_MODEL_REGISTRY_SOURCE, "packaged test registry");
    }
  });
});
