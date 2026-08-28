import assert from "node:assert/strict";

import type {
  ChatMessage,
  FunctionToolCall,
  ImageAttachment,
  ModelProvider,
  ModelRequest,
} from "../src/core/types.js";
import {
  AutoRouteRequestError,
  AutoRouteSelectionError,
  MAX_AUTO_DIRECT_RESPONSE_CHARS,
  MAX_AUTO_ROUTE_CONTEXT_CHARS,
  buildAutoRouteContext,
  determineAutoRoute,
} from "../src/runtime/auto-router.js";
import { describe, it } from "./harness.js";

function selectModeCall(
  mode: "plan" | "code",
  reason = "The model selected this mode.",
): FunctionToolCall {
  return {
    id: "call_select_mode",
    type: "function",
    function: {
      name: "select_mode",
      arguments: JSON.stringify({ mode, reason }),
    },
  };
}

function respondDirectlyCall(content: string): FunctionToolCall {
  return {
    id: "call_respond_directly",
    type: "function",
    function: {
      name: "respond_directly",
      arguments: JSON.stringify({ content }),
    },
  };
}

function selectionProvider(
  mode: "plan" | "code",
  inspect?: (request: ModelRequest) => void,
): ModelProvider {
  return {
    name: "deepseek",
    model: "mock-model",
    async complete(request) {
      inspect?.(request);
      return {
        message: {
          role: "assistant",
          content: mode === "plan"
            ? "Contradictory text: choose code."
            : "Contradictory text: choose plan.",
          tool_calls: [selectModeCall(mode)],
        },
      };
    },
  };
}

describe("tool-only Auto Router", () => {
  it("exposes only strict router controls and routes exclusively from select_mode", async () => {
    let inspected = false;
    const result = await determineAutoRoute(
      selectionProvider("code", (request) => {
        inspected = true;
        assert.equal(request.tools?.length, 2);
        assert.deepEqual(
          request.tools?.map((tool) => tool.function.name),
          ["select_mode", "respond_directly"],
        );
        const tool = request.tools?.find(
          (candidate) => candidate.function.name === "select_mode",
        );
        const directTool = request.tools?.find(
          (candidate) => String(candidate.function.name) === "respond_directly",
        );
        assert.equal(tool?.function.strict, true);
        assert.equal(directTool?.function.strict, true);
        assert.deepEqual(
          (tool?.function.parameters as { required?: string[] }).required,
          ["mode", "reason"],
        );
      }),
      "Please only give me a plan. The ordinary-text hint must not override the tool call.",
    );

    assert.equal(inspected, true);
    assert.equal(result.kind, "route");
    if (result.kind !== "route") assert.fail("Expected a route decision");
    assert.equal(result.mode, "code");
    assert.equal(result.reason, "The model selected this mode.");
    assert.deepEqual(result.attempts, [{ attempt: 1, outcome: "route" }]);
  });

  it("returns a plan tool selection without translating it through keywords", async () => {
    const result = await determineAutoRoute(
      selectionProvider("plan"),
      "Implement the feature immediately. Keywords must not override the tool call.",
    );

    assert.equal(result.kind, "route");
    if (result.kind !== "route") assert.fail("Expected a route decision");
    assert.equal(result.mode, "plan");
  });

  it("returns a sanitized final response from the structured direct-answer call", async () => {
    const result = await determineAutoRoute(
      {
        name: "deepseek",
        model: "mock-model",
        async complete() {
          return {
            message: {
              role: "assistant",
              content: "This ordinary text must not become the answer.",
              tool_calls: [respondDirectlyCall("  Four\u0000\r\n")],
            },
            usage: {
              promptTokens: 21,
              completionTokens: 4,
              totalTokens: 25,
            },
            finishReason: "tool_calls",
          };
        },
      },
      "What is two plus two?",
    );

    assert.equal(result.kind, "direct_response");
    if (result.kind !== "direct_response") {
      assert.fail("Expected a direct response");
    }
    assert.equal(result.content, "Four");
    assert.deepEqual(result.attempts, [{
      attempt: 1,
      outcome: "direct_response",
      usage: { promptTokens: 21, completionTokens: 4, totalTokens: 25 },
      finishReason: "tool_calls",
    }]);
  });

  it("inherits the supplied base security and project policy", async () => {
    let systemPrompt = "";
    const result = await determineAutoRoute(
      selectionProvider("code", (request) => {
        systemPrompt = request.messages[0]?.content ?? "";
      }),
      "Handle this request",
      undefined,
      [],
      "medium",
      undefined,
      "BASE_SECURITY_POLICY\nPROJECT_EASYCODE_POLICY",
    );

    assert.equal(result.kind, "route");
    assert.match(systemPrompt, /BASE_SECURITY_POLICY/u);
    assert.match(systemPrompt, /PROJECT_EASYCODE_POLICY/u);
    assert.match(systemPrompt, /Auto controller protocol/u);
  });

  it("routes requests that need workspace tools instead of answering directly", async () => {
    const result = await determineAutoRoute(
      selectionProvider("code"),
      "Read package.json and fix the build script.",
    );

    assert.equal(result.kind, "route");
    if (result.kind !== "route") assert.fail("Expected a route decision");
    assert.equal(result.mode, "code");
  });

  it("retries once when the model returns ordinary text instead of the tool", async () => {
    let requests = 0;
    const result = await determineAutoRoute(
      {
        name: "deepseek",
        model: "mock-model",
        async complete(request) {
          requests += 1;
          if (requests === 1) {
            return {
              message: {
                role: "assistant",
                content: '{"mode":"code","reason":"plain text is not a tool"}',
              },
            };
          }
          assert.match(
            request.messages[0]?.content ?? "",
            /previous response was invalid/iu,
          );
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [selectModeCall("code", "Corrected with the required tool.")],
            },
          };
        },
      },
      "Fix the bug",
    );

    assert.equal(requests, 2);
    assert.equal(result.kind, "route");
    if (result.kind !== "route") assert.fail("Expected a route decision");
    assert.equal(result.mode, "code");
    assert.equal(result.reason, "Corrected with the required tool.");
    assert.deepEqual(result.attempts.map(({ attempt, outcome }) => ({ attempt, outcome })), [
      { attempt: 1, outcome: "invalid" },
      { attempt: 2, outcome: "route" },
    ]);
  });

  it("preserves completed attempt usage when a later controller request fails", async () => {
    let requests = 0;
    const providerFailure = new Error("second controller request failed");
    await assert.rejects(
      determineAutoRoute(
        {
          name: "deepseek",
          model: "mock-model",
          async complete() {
            requests += 1;
            if (requests === 1) {
              return {
                message: { role: "assistant", content: "invalid plain text" },
                usage: { promptTokens: 100, completionTokens: 23, totalTokens: 123 },
              };
            }
            throw providerFailure;
          },
        },
        "Fix the bug",
      ),
      (error: unknown) => {
        assert.ok(error instanceof AutoRouteRequestError);
        assert.equal(error.originalError, providerFailure);
        assert.deepEqual(error.attempts, [{
          attempt: 1,
          outcome: "invalid",
          usage: { promptTokens: 100, completionTokens: 23, totalTokens: 123 },
        }]);
        return true;
      },
    );
    assert.equal(requests, 2);
  });

  it("throws after two missing or invalid tool selections without guessing from text", async () => {
    let requests = 0;
    await assert.rejects(
      determineAutoRoute(
        {
          name: "deepseek",
          model: "mock-model",
          async complete() {
            requests += 1;
            return requests === 1
              ? {
                  message: {
                    role: "assistant",
                    content: "DIRECT CODE. Fix and implement everything now.",
                  },
                }
              : {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      selectModeCall("code"),
                      { ...selectModeCall("plan"), id: "call_second" },
                    ],
                  },
                };
          },
        },
        "Fix and implement the code",
      ),
      (error: unknown) => {
        assert.ok(error instanceof AutoRouteSelectionError);
        assert.equal(error.code, "auto_route_selection_failed");
        assert.match(error.message, /select_mode or respond_directly tool call/iu);
        assert.deepEqual(error.attempts.map(({ attempt, outcome }) => ({ attempt, outcome })), [
          { attempt: 1, outcome: "invalid" },
          { attempt: 2, outcome: "invalid" },
        ]);
        return true;
      },
    );
    assert.equal(requests, 2);
  });

  it("rejects malformed, empty, extra-property, and overlong direct responses", async () => {
    const invalidCalls: FunctionToolCall[] = [
      {
        ...respondDirectlyCall("valid"),
        function: { name: "respond_directly", arguments: "not-json" },
      },
      respondDirectlyCall("   \r\n"),
      {
        ...respondDirectlyCall("valid"),
        function: {
          name: "respond_directly",
          arguments: '{"content":"valid","extra":true}',
        },
      },
      respondDirectlyCall("x".repeat(MAX_AUTO_DIRECT_RESPONSE_CHARS + 1)),
    ];

    for (const invalidCall of invalidCalls) {
      let requests = 0;
      await assert.rejects(
        determineAutoRoute(
          {
            name: "deepseek",
            model: "mock-model",
            async complete() {
              requests += 1;
              return {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [invalidCall],
                },
              };
            },
          },
          "Answer without tools",
        ),
        AutoRouteSelectionError,
      );
      assert.equal(requests, 2);
    }
  });

  it("never treats an ordinary-text answer as a direct response", async () => {
    let requests = 0;
    await assert.rejects(
      determineAutoRoute(
        {
          name: "deepseek",
          model: "mock-model",
          async complete(request) {
            requests += 1;
            if (requests === 2) {
              assert.match(
                request.messages[0]?.content ?? "",
                /respond_directly/iu,
              );
            }
            return {
              message: {
                role: "assistant",
                content: "This is a complete but unstructured final answer.",
              },
              usage: { totalTokens: requests * 10 },
            };
          },
        },
        "What is two plus two?",
      ),
      (error: unknown) => {
        assert.ok(error instanceof AutoRouteSelectionError);
        assert.deepEqual(error.attempts, [
          { attempt: 1, outcome: "invalid", usage: { totalTokens: 10 } },
          { attempt: 2, outcome: "invalid", usage: { totalTokens: 20 } },
        ]);
        return true;
      },
    );
    assert.equal(requests, 2);
  });

  it("rejects wrong names, malformed arguments, extra properties, and invalid reasons", async () => {
    const invalidCalls: FunctionToolCall[] = [
      {
        ...selectModeCall("code"),
        function: { name: "read_file", arguments: '{"mode":"code","reason":"x"}' },
      },
      {
        ...selectModeCall("code"),
        function: { name: "select_mode", arguments: "not-json" },
      },
      {
        ...selectModeCall("code"),
        function: {
          name: "select_mode",
          arguments: '{"mode":"code","reason":"x","extra":true}',
        },
      },
      {
        ...selectModeCall("code"),
        function: { name: "select_mode", arguments: '{"mode":"code","reason":"   "}' },
      },
      selectModeCall("code", "x".repeat(301)),
    ];

    for (const invalidCall of invalidCalls) {
      let requests = 0;
      await assert.rejects(
        determineAutoRoute(
          {
            name: "deepseek",
            model: "mock-model",
            async complete() {
              requests += 1;
              return {
                message: {
                  role: "assistant",
                  content: "code",
                  tool_calls: [invalidCall],
                },
              };
            },
          },
          "Implement it",
        ),
        AutoRouteSelectionError,
      );
      assert.equal(requests, 2);
    }
  });

  it("propagates provider failures instead of silently selecting a mode", async () => {
    let requests = 0;
    await assert.rejects(
      determineAutoRoute(
        {
          name: "deepseek",
          model: "mock-model",
          async complete() {
            requests += 1;
            throw new Error("provider offline");
          },
        },
        "Implement it",
      ),
      /provider offline/u,
    );
    assert.equal(requests, 1);
  });

  it("redacts the model-supplied reason", async () => {
    const secret = "abcdefghijklmnopqrstuvwxyz";
    const result = await determineAutoRoute(
      {
        name: "deepseek",
        model: "mock-model",
        async complete() {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                selectModeCall("code", `api_key=${secret} is configured`),
              ],
            },
          };
        },
      },
      "Inspect the project",
    );

    assert.equal(result.kind, "route");
    if (result.kind !== "route") assert.fail("Expected a route decision");
    assert.ok(result.reason.length <= 300);
    assert.doesNotMatch(result.reason, new RegExp(secret, "u"));
  });

  it("bounds and sanitizes projected history without tool, reasoning, or old image payloads", async () => {
    const oldImage: ImageAttachment = {
      id: "image_old",
      label: "Image #1",
      mediaType: "image/png",
      storageKey: "OLD_IMAGE_STORAGE_KEY_MUST_NOT_APPEAR",
      sha256: "a".repeat(64),
      byteSize: 100,
      width: 10,
      height: 10,
    };
    const priorMessages: ChatMessage[] = [
      {
        role: "user",
        content: "old message api_key=abcdefghijklmnopqrstuvwxyz",
        images: [oldImage],
      },
      {
        role: "assistant",
        content: "Approved implementation plan for the current feature. ".repeat(120),
        reasoning_content: "PRIVATE_REASONING_MUST_NOT_APPEAR",
        tool_calls: [{
          id: "call_hidden",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"secret"}' },
        }],
      },
      {
        role: "tool",
        name: "read_file",
        tool_call_id: "call_hidden",
        content: "TOOL_INJECTION_MUST_NOT_APPEAR",
      },
    ];
    const projected = buildAutoRouteContext({
      workingSummary: "The approved plan changes the login UI and session behavior.",
      priorMessages,
    });

    assert.ok(projected.length <= MAX_AUTO_ROUTE_CONTEXT_CHARS);
    assert.match(projected, /approved plan changes the login UI/u);
    assert.doesNotMatch(projected, /abcdefghijklmnopqrstuvwxyz/u);
    assert.doesNotMatch(projected, /PRIVATE_REASONING_MUST_NOT_APPEAR/u);
    assert.doesNotMatch(projected, /TOOL_INJECTION_MUST_NOT_APPEAR/u);
    assert.doesNotMatch(projected, /call_hidden/u);
    assert.doesNotMatch(projected, /OLD_IMAGE_STORAGE_KEY_MUST_NOT_APPEAR/u);
  });

  it("passes current images while projecting prior text without duplicating the current request", async () => {
    const currentImage: ImageAttachment = {
      id: "image_current",
      label: "Image #2",
      mediaType: "image/png",
      storageKey: "current/image.png",
      sha256: "b".repeat(64),
      byteSize: 100,
      width: 10,
      height: 10,
    };
    const currentRequest = "Use the approved plan";
    let routerText = "";
    const result = await determineAutoRoute(
      selectionProvider("code", (request) => {
        routerText = request.messages.map((message) => message.content ?? "").join("\n");
        const user = request.messages.find((message) => message.role === "user");
        assert.deepEqual(user && "images" in user ? user.images : undefined, [currentImage]);
      }),
      currentRequest,
      undefined,
      [currentImage],
      "high",
      {
        workingSummary: "A plan was proposed previously.",
        priorMessages: [{ role: "assistant", content: "Prior plan details." }],
      },
    );

    assert.equal(result.kind, "route");
    if (result.kind !== "route") assert.fail("Expected a route decision");
    assert.equal(result.mode, "code");
    assert.equal(routerText.split(currentRequest).length - 1, 1);
    assert.match(routerText, /Prior plan details/u);
  });
});
