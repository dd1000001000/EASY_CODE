import assert from "node:assert/strict";

import type {
  ChatMessage,
  FunctionToolCall,
  ImageAttachment,
  ModelProvider,
  ModelRequest,
} from "../src/core/types.js";
import {
  AutoRouteSelectionError,
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
  it("exposes only select_mode and routes exclusively from its structured call", async () => {
    let inspected = false;
    const result = await determineAutoRoute(
      selectionProvider("code", (request) => {
        inspected = true;
        assert.equal(request.tools?.length, 1);
        const tool = request.tools?.[0];
        assert.equal(tool?.function.name, "select_mode");
        assert.equal(tool?.function.strict, true);
        assert.deepEqual(
          (tool?.function.parameters as { required?: string[] }).required,
          ["mode", "reason"],
        );
      }),
      "Please only give me a plan. The ordinary-text hint must not override the tool call.",
    );

    assert.equal(inspected, true);
    assert.equal(result.mode, "code");
    assert.equal(result.reason, "The model selected this mode.");
  });

  it("returns a plan tool selection without translating it through keywords", async () => {
    const result = await determineAutoRoute(
      selectionProvider("plan"),
      "Implement the feature immediately. Keywords must not override the tool call.",
    );

    assert.equal(result.mode, "plan");
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
    assert.equal(result.mode, "code");
    assert.equal(result.reason, "Corrected with the required tool.");
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
        assert.match(error.message, /exactly one valid select_mode tool call/iu);
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

    assert.equal(result.mode, "code");
    assert.equal(routerText.split(currentRequest).length - 1, 1);
    assert.match(routerText, /Prior plan details/u);
  });
});
