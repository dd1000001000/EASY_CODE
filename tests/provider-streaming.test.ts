import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createDefaultEasyCodeConfig } from "../src/config/defaults.js";
import type { ProviderStreamEvent } from "../src/core/types.js";
import {
  PACKAGED_MODEL_REGISTRY_SOURCE,
  activateModelRegistry,
} from "../src/models/catalog.js";
import { createProvider } from "../src/providers/factory.js";
import { HttpTransportError, type JsonPostRequest } from "../src/providers/http-transport.js";
import { ServerSentEventDecoder } from "../src/providers/sse.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { ResponsesProvider } from "../src/providers/responses.js";
import { completeWithApiRetries, incompleteModelOutput } from "../src/runtime/model-retry.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import { describe, it } from "./harness.js";

const STREAMING_RESPONSES_REGISTRY = `schema_version = 1
default_model = "coder"
[providers.openai-like]
name = "OpenAI-like"
base_url = "https://models.example/v1"
env_key = "OPENAI_LIKE_API_KEY"
wire_api = "responses"
supports_streaming = true
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

function deliverStream(
  request: JsonPostRequest,
  chunks: readonly Buffer[],
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  request.onResponseStart?.({
    statusCode: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
  for (const chunk of chunks) request.onResponseChunk?.(chunk);
  return Promise.resolve({
    statusCode: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
    body: Buffer.concat(chunks).toString("utf8"),
  });
}

describe("provider streaming", () => {
  it("decodes split UTF-8 bytes, CRLF and multiline SSE data", () => {
    const decoder = new ServerSentEventDecoder();
    const bytes = Buffer.from("event: sample\r\ndata: {\"text\":\"你\r\ndata: 好\"}\r\n\r\n", "utf8");
    const split = bytes.indexOf(Buffer.from("你", "utf8")) + 1;
    assert.deepEqual(decoder.push(bytes.subarray(0, split)), []);
    const events = [
      ...decoder.push(bytes.subarray(split)),
      ...decoder.finish(),
    ];
    assert.deepEqual(events, [{ event: "sample", data: "{\"text\":\"你\n好\"}" }]);
  });

  it("assembles Chat Completions deltas and emits ordered transient events", async () => {
    activateModelRegistry(PACKAGED_MODEL_REGISTRY_SOURCE, "packaged streaming registry");
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.qwen.apiKey = "test-key";
    let sent: JsonPostRequest | undefined;
    const wire = [
      'data: {"choices":[{"delta":{"reasoning_content":"检查"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"完成"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"read_","arguments":"{\\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"file","arguments":"th\\\":\\\"README.md\\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\n',
      "data: [DONE]\n\n",
    ].map((value) => Buffer.from(value, "utf8"));
    const provider = createProvider(config, "qwen", undefined, {
      transport: async (request) => {
        sent = request;
        return deliverStream(request, wire);
      },
    });
    const events: ProviderStreamEvent[] = [];
    const response = await provider.complete({
      messages: [{ role: "user", content: "inspect" }],
      onStreamEvent: (event) => events.push(event),
    });
    assert.equal(JSON.parse(sent!.body).stream, true);
    assert.equal(sent?.headers.accept, "text/event-stream");
    assert.equal(response.message.reasoning_content, "检查");
    assert.equal(response.message.content, "完成");
    assert.deepEqual(response.message.tool_calls?.[0], {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"README.md"}' },
    });
    assert.equal(response.usage?.totalTokens, 11);
    assert.deepEqual(events.map((event) => event.kind), [
      "started",
      "reasoning_delta",
      "text_delta",
      "tool_call_delta",
      "tool_call_delta",
      "usage",
      "completed",
    ]);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  });

  it("sends configured tool_stream only for streamed Chat Completions requests with tools", async () => {
    activateModelRegistry(PACKAGED_MODEL_REGISTRY_SOURCE, "packaged tool streaming registry");
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.qwen.apiKey = "test-key";
    const bodies: Array<Record<string, unknown>> = [];
    const provider = createProvider(config, "qwen", undefined, {
      transport: async (request) => {
        bodies.push(JSON.parse(request.body) as Record<string, unknown>);
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] }),
        };
      },
    });
    const tool = {
      type: "function" as const,
      function: { name: "read_file", description: "read", parameters: { type: "object" } },
    };
    await provider.complete({ messages: [{ role: "user", content: "plain" }] });
    await provider.complete({ messages: [{ role: "user", content: "use a tool" }], tools: [tool] });
    assert.equal(bodies[0]?.tool_stream, undefined);
    assert.equal(bodies[1]?.tool_stream, true);

    const disabled = createProvider(config, "qwen", undefined, {
      toolStream: false,
      transport: async (request) => {
        bodies.push(JSON.parse(request.body) as Record<string, unknown>);
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] }),
        };
      },
    });
    await disabled.complete({ messages: [{ role: "user", content: "use a tool" }], tools: [tool] });
    assert.equal(bodies[2]?.tool_stream, undefined);
  });

  it("assembles Responses semantic events without exposing partial tool calls", async () => {
    activateModelRegistry(STREAMING_RESPONSES_REGISTRY, "streaming responses registry");
    try {
      const config = createDefaultEasyCodeConfig(process.cwd());
      config.providers["openai-like"]!.apiKey = "test-key";
      const wire = [
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"plan"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"done"}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"read_file","arguments":""}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\\"path\\\":\\\"README.md\\\"}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"plan"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]},{"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\\\"path\\\":\\\"README.md\\\"}"}],"usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}}}\n\n',
      ].map((value) => Buffer.from(value, "utf8"));
      const events: ProviderStreamEvent[] = [];
      const provider = createProvider(config, "openai-like", undefined, {
        transport: (request) => deliverStream(request, wire),
      });
      const response = await provider.complete({
        messages: [{ role: "user", content: "inspect" }],
        onStreamEvent: (event) => events.push(event),
      });
      assert.equal(response.message.content, "done");
      assert.equal(response.message.reasoning_content, "plan");
      assert.equal(response.message.tool_calls?.[0]?.function.arguments, '{"path":"README.md"}');
      assert.equal(response.usage?.totalTokens, 9);
      assert.deepEqual(events.map((event) => event.kind), [
        "started", "reasoning_delta", "text_delta", "tool_call_delta",
        "tool_call_delta", "usage", "completed",
      ]);
    } finally {
      activateModelRegistry(PACKAGED_MODEL_REGISTRY_SOURCE, "packaged test registry");
    }
  });

  it("keeps JSON behavior for a registry that omits streaming capability", async () => {
    const registry = STREAMING_RESPONSES_REGISTRY.replace("supports_streaming = true\n", "");
    activateModelRegistry(registry, "non-streaming responses registry");
    try {
      const config = createDefaultEasyCodeConfig(process.cwd());
      config.providers["openai-like"]!.apiKey = "test-key";
      let sent: JsonPostRequest | undefined;
      const provider = createProvider(config, "openai-like", undefined, {
        transport: async (request) => {
          sent = request;
          return { statusCode: 200, headers: { "content-type": "application/json" }, body: '{"status":"completed","output":[]}' };
        },
      });
      const events: ProviderStreamEvent[] = [];
      await provider.complete({
        messages: [{ role: "user", content: "answer" }],
        onStreamEvent: (event) => events.push(event),
      });
      assert.equal(JSON.parse(sent!.body).stream, false);
      assert.equal(sent?.onResponseChunk, undefined);
      assert.deepEqual(events, []);
    } finally {
      activateModelRegistry(PACKAGED_MODEL_REGISTRY_SOURCE, "packaged test registry");
    }
  });

  it("honors maxRetries=0 after a visible stream and leaves retry ownership to Runtime", async () => {
    activateModelRegistry(PACKAGED_MODEL_REGISTRY_SOURCE, "packaged streaming registry");
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.qwen.apiKey = "test-key";
    config.qwen.maxRetries = 3;
    let attempts = 0;
    const events: ProviderStreamEvent[] = [];
    const provider = createProvider(config, "qwen", undefined, {
      transport: async (request) => {
        attempts += 1;
        request.onResponseStart?.({ statusCode: 200, headers: { "content-type": "text/event-stream" } });
        request.onResponseChunk?.(Buffer.from('data: {"choices":[{"delta":{"content":"visible"}}]}\n\n'));
        throw new HttpTransportError("network", "connection lost");
      },
      sleep: async () => undefined,
    });
    await assert.rejects(provider.complete({
      messages: [{ role: "user", content: "answer" }],
      maxRetries: 0,
      onStreamEvent: (event) => events.push(event),
    }), /connection lost/u);
    assert.equal(attempts, 1);
    assert.deepEqual(events.map((event) => event.kind), [
      "started", "text_delta", "interrupted",
    ]);
  });
});

const mockConfig = { apiKey: "mock-key", model: "mock", baseUrl: "https://example.invalid", maxRetries: 0, timeoutMs: 1000 };
const mockRequest = { messages: [{ role: "user" as const, content: "test" }] };
const buffers = (events: readonly unknown[]) => events.map((event) => Buffer.from(
  `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
));
const chatFinish = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const chatText = (content: string) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }], usage: null });
const responseFinish = (text: string, status = "completed") => ({
  type: `response.${status}`, response: { status, output: [{ type: "message", content: [{ type: "output_text", text }] }] },
});

describe("stream recovery boundaries", () => {
  it("recovers a clean HTTP EOF on a real local SSE connection", async () => {
    let attempts = 0;
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      attempts++;
      response.end(Buffer.concat(buffers(attempts === 1
        ? [chatText("discarded")]
        : [chatText("complete"), chatFinish, "[DONE]"])));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const provider = new OpenAICompatibleProvider("qwen", { ...mockConfig, baseUrl: `http://127.0.0.1:${port}` }, { supportsStreaming: true });
      const result = await completeWithApiRetries(provider, mockRequest, { sleep: async () => undefined });
      assert.equal(result.message.content, "complete");
      assert.equal(attempts, 2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("accepts null usage and usage-only chunks and requests usage only when supported", async () => {
    for (const supportsStreamUsage of [true, false]) {
      let body: Record<string, unknown> = {};
      const events: ProviderStreamEvent[] = [];
      const provider = new OpenAICompatibleProvider("qwen", mockConfig, {
        supportsStreaming: true, supportsStreamUsage,
        transport: async (request) => {
          body = JSON.parse(request.body);
          return deliverStream(request, buffers([chatText("hello"), chatFinish,
            { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
            { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }, "[DONE]"]));
        },
      });
      const result = await provider.complete({ ...mockRequest, onStreamEvent: (event) => events.push(event) });
      assert.deepEqual(body.stream_options, supportsStreamUsage ? { include_usage: true } : undefined);
      assert.equal(result.message.content, "hello");
      assert.equal(result.usage?.totalTokens, 12);
      assert.equal(events.filter((event) => event.kind === "usage").length, 1);
    }
  });

  it("rejects text and even valid tool JSON if the protocol terminal event is missing", async () => {
    for (const Provider of [OpenAICompatibleProvider, ResponsesProvider]) {
      for (const withTool of [false, true]) {
        const events: ProviderStreamEvent[] = [];
        const data = Provider === OpenAICompatibleProvider
          ? withTool ? { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "run_command", arguments: '{"program":"echo"}' } }] } }] } : chatText("partial")
          : withTool ? { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item_1", call_id: "call_1", name: "run_command", arguments: '{"program":"echo"}' } } : { type: "response.output_text.delta", delta: "partial" };
        const provider = new Provider("qwen", mockConfig, { supportsStreaming: true, transport: (request) => deliverStream(request, buffers([data])) });
        await assert.rejects(provider.complete({ ...mockRequest, onStreamEvent: (event) => events.push(event) }),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "incomplete_stream");
        assert.equal(events.at(-1)?.kind, "interrupted");
        assert.equal(events.some((event) => event.kind === "completed"), false);
      }
    }
  });

  it("rejects DONE without finish_reason and ignores neither late deltas nor server errors", async () => {
    for (const wire of [
      [chatText("partial"), "[DONE]"],
      [chatText("partial"), chatFinish],
      [chatText("partial"), chatFinish, chatText("late"), "[DONE]"],
      [chatText("partial"), { error: { code: "server_error", message: "upstream failed" } }],
    ]) {
      const provider = new OpenAICompatibleProvider("qwen", mockConfig, { supportsStreaming: true, transport: (request) => deliverStream(request, buffers(wire)) });
      await assert.rejects(provider.complete(mockRequest));
    }
    for (const wire of [
      [{ type: "response.output_text.delta", delta: "partial" }, { type: "error", code: "server_error", message: "upstream failed" }],
      [responseFinish("done"), { type: "response.output_text.delta", delta: "late" }],
      [{ type: "response.completed", response: { status: "in_progress", output: [] } }],
    ]) {
      const provider = new ResponsesProvider("qwen", mockConfig, { supportsStreaming: true, transport: (request) => deliverStream(request, buffers(wire)) });
      await assert.rejects(provider.complete(mockRequest));
    }
  });

  it("retries interrupted attempts through the shared budget without mixing candidate output", async () => {
    for (const Provider of [OpenAICompatibleProvider, ResponsesProvider]) {
      let attempts = 0, settlements = 0;
      const events: ProviderStreamEvent[] = [];
      const provider = new Provider("qwen", { ...mockConfig, maxRetries: 5 }, {
        supportsStreaming: true,
        transport: async (request) => {
          attempts++;
          if (attempts <= 2) {
            request.onResponseStart?.({ statusCode: 200, headers: { "content-type": "text/event-stream" } });
            if (attempts === 2) request.onResponseChunk?.(buffers([Provider === OpenAICompatibleProvider ? chatText("discard me") : { type: "response.output_text.delta", delta: "discard me" }])[0]!);
            throw new HttpTransportError("network", "connection lost");
          }
          return deliverStream(request, buffers(Provider === OpenAICompatibleProvider ? [chatText("accepted"), chatFinish, "[DONE]"] : [responseFinish("accepted")]));
        },
      });
      const result = await completeWithApiRetries(provider, { ...mockRequest, onStreamEvent: (event) => events.push(event) }, {
        sleep: async () => undefined, reserve: () => () => { settlements++; },
      });
      assert.equal(attempts, 3);
      assert.equal(settlements, 3);
      assert.equal(result.message.content, "accepted");
      assert.equal(new Set(events.filter((event) => event.kind === "started").map((event) => event.streamId)).size, 3);
      assert.equal(events.filter((event) => event.kind === "completed").length, 1);
    }
  });

  it("stops at the configured retry count and never retries cancellation or authentication", async () => {
    for (const scenario of ["network", "authentication", "cancel"] as const) {
      let attempts = 0;
      const controller = new AbortController();
      const provider = new OpenAICompatibleProvider("qwen", mockConfig, {
        supportsStreaming: true, transport: async (request) => {
          attempts++;
          request.onResponseStart?.({ statusCode: 200, headers: { "content-type": "text/event-stream" } });
          if (scenario === "authentication") return deliverStream(request, buffers([{ error: { code: "invalid_api_key", message: "bad key" } }]));
          if (scenario === "cancel") controller.abort();
          throw new HttpTransportError("network", "lost");
        },
      });
      await assert.rejects(completeWithApiRetries(provider, { ...mockRequest, signal: controller.signal }, {
        limits: { ...DEFAULT_RUNTIME_LIMITS, maxProviderRetries: 2 }, sleep: async () => undefined,
      }));
      assert.equal(attempts, scenario === "network" ? 3 : 1);
    }
  });

  it("preserves length/incomplete outcomes for Runtime content correction", async () => {
    const chat = new OpenAICompatibleProvider("qwen", mockConfig, { supportsStreaming: true,
      transport: (request) => deliverStream(request, buffers([chatText("partial"), { choices: [{ delta: {}, finish_reason: "length" }] }, "[DONE]"])),
    });
    assert.match(incompleteModelOutput(await chat.complete(mockRequest)) ?? "", /truncated/u);
    const responses = new ResponsesProvider("qwen", mockConfig, { supportsStreaming: true,
      transport: (request) => deliverStream(request, buffers([responseFinish("partial", "incomplete")])),
    });
    assert.match(incompleteModelOutput(await responses.complete(mockRequest)) ?? "", /did not complete/u);
  });

  it("decodes CR-only events and discards unfinished events on EOF", () => {
    const decoder = new ServerSentEventDecoder();
    assert.deepEqual(decoder.push(Buffer.from("data: first\r")), []);
    assert.deepEqual(decoder.push(Buffer.from("\rdata: unfinished")), [{ data: "first" }]);
    assert.deepEqual(decoder.finish(), []);
  });

  it("keeps interleaved tools separate and ignores observer exceptions", async () => {
    const provider = new OpenAICompatibleProvider("qwen", mockConfig, { supportsStreaming: true,
      transport: (request) => deliverStream(request, buffers([
        { choices: [{ delta: { tool_calls: [
          { index: 1, id: "second", function: { name: "read_file", arguments: '{"path":' } },
          { index: 0, id: "first", function: { name: "read_file", arguments: '{"path":"a"}' } },
        ] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"b"}' } }] }, finish_reason: "tool_calls" }] }, "[DONE]",
      ])),
    });
    const result = await provider.complete({ ...mockRequest, onStreamEvent: () => { throw new Error("UI failure"); } });
    assert.deepEqual(result.message.tool_calls?.map((call) => [call.id, call.function.arguments]), [
      ["first", '{"path":"a"}'], ["second", '{"path":"b"}'],
    ]);
  });

  it("does not silently omit malformed Responses calls from a completed response", async () => {
    const provider = new ResponsesProvider("qwen", mockConfig, { supportsStreaming: true,
      transport: (request) => deliverStream(request, buffers([{ type: "response.completed", response: {
        status: "completed", output: [{ type: "function_call", call_id: "id", name: "run_command" }],
      } }])),
    });
    await assert.rejects(provider.complete(mockRequest), /incomplete function call/u);
  });

  it("reports invalid UTF-8 as a protocol error without spending API retries", async () => {
    let attempts = 0;
    const provider = new OpenAICompatibleProvider("qwen", mockConfig, { supportsStreaming: true,
      transport: async (request) => {
        attempts++;
        return deliverStream(request, [Buffer.from([0xff])]);
      },
    });
    await assert.rejects(completeWithApiRetries(provider, mockRequest, { sleep: async () => undefined }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_response");
    assert.equal(attempts, 1);
  });
});
