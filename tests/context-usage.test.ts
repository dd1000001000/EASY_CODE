import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDefaultEasyCodeConfig } from "../src/config/index.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { ContextManager } from "../src/context/manager.js";
import { estimatedTokens, messageTokens, requestTokens } from "../src/context/token-budget.js";
import {
  contextTokensInUse,
  contextUsageReport,
  contextUsedTokens,
  measureContextUsage,
} from "../src/context/usage.js";
import type { ChatMessage, SessionState, ToolDefinition } from "../src/core/types.js";
import { EASY_CODE_RUNTIME_VERSION, PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH } from "../src/prompt-bundle/generated.js";
import { ensurePromptBundleForTesting } from "../src/prompt-bundle/manager.js";
import { buildSystemPrompt } from "../src/prompts/index.js";
import { contextUsageRows, formatShare } from "../src/ui/context-usage.js";
import type { ContextUsageReport } from "../src/ui/contracts.js";
import { renderContextUsage } from "../src/ui/render/context-usage.js";
import { AgentRuntime } from "./approved-runtime.js";
import { snapshotToolSet } from "./tool-set.js";
import { describe, it } from "./harness.js";
import { baseSessionState } from "./session-state.js";

const state = (threadId = "thread_usage"): SessionState => ({
  ...baseSessionState(),
  threadId,
  workspaceRoot: process.cwd(),
  mode: "code",
  provider: "glm",
  model: "mock",
  thinkingEffort: "none",
  messages: [{ role: "user", content: "Fix the parser." }],
  constraints: [],
  filesRead: new Map(),
  changes: [],
  commands: [],
  commandApprovalPrefixes: [],
  workingSummary: "",
  compactedMessageCount: 0,
  createdAt: "now",
  updatedAt: "now",
});

const tool = (name: string): ToolDefinition => ({
  type: "function",
  function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } },
});

const counts = (tokens: Partial<ContextUsageReport["categories"]> = {}): ContextUsageReport["categories"] => ({
  messages: 0,
  systemPrompt: 0,
  instructions: 0,
  skills: 0,
  memory: 0,
  runtimeContext: 0,
  systemTools: 0,
  mcpTools: 0,
  ...tokens,
});

describe("context window usage", () => {
  it("splits the system prompt into policy, project instructions and memory", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-usage-"));
    try {
      await ensurePromptBundleForTesting({
        homeDirectory: path.join(temporary, "prompt-home"),
        packagedBundleDirectory: path.resolve("resources", "prompt-bundle"),
        expectedManifestHash: PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH,
        runtimeVersion: EASY_CODE_RUNTIME_VERSION,
      });
      const workspace = path.join(temporary, "workspace");
      const configDir = path.join(temporary, "config");
      await mkdir(workspace, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(workspace, "EASYCODE.md"), "Use the project test script. ".repeat(200), "utf8");
      const config = createDefaultEasyCodeConfig(workspace, {
        configDir,
        dataDir: path.join(temporary, "data"),
        cacheDir: path.join(temporary, "cache"),
      });
      const prompt = await buildSystemPrompt({
        config,
        mode: "code",
        memories: ["The parser keeps comments. ".repeat(100)],
        cwd: workspace,
        env: {},
      });
      // The context manager appends long-term memory after the built prompt.
      const system: ChatMessage = { role: "system", content: `${prompt}\n\nLong-term memory: ${"x ".repeat(400)}` };
      const usage = measureContextUsage({ messages: [system], tools: [] });
      assert.ok(usage.systemPrompt > 0);
      assert.ok(usage.instructions > 1000, String(usage.instructions));
      assert.ok(usage.memory > 700, String(usage.memory));
      assert.equal(contextUsedTokens({ ...report(usage), categories: usage }), messageTokens(system));

      // A system message no recent prompt starts is all policy.
      const unknown: ChatMessage = { role: "system", content: "Some other prompt." };
      assert.deepEqual(
        measureContextUsage({ messages: [unknown], tools: [] }),
        counts({ systemPrompt: messageTokens(unknown) }),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("counts the Runtime context message, its memory, and built-in and MCP tools apart", () => {
    const memory = JSON.stringify([{ id: "m1", content: "Prefer pnpm. ".repeat(50) }]);
    const runtimeContext = `RUNTIME_CONTEXT_DATA:\n${JSON.stringify({ workspaceSummary: "src/ ".repeat(200), memories: memory })}`;
    const messages: ChatMessage[] = [
      { role: "user", content: "Fix the parser." },
      { role: "assistant", content: "Reading it." },
      { role: "user", content: runtimeContext },
    ];
    const builtIn = [tool("read_file"), tool("run_command")];
    const mcp = [tool("mcp_docs_search")];
    const usage = measureContextUsage({
      messages,
      tools: [
        ...builtIn.map((definition) => ({ definition, mcp: false })),
        ...mcp.map((definition) => ({ definition, mcp: true })),
      ],
      runtimeContext,
      runtimeMemory: memory,
    });
    // Per message, so the parts add up to the request without counting an empty tool list per message.
    assert.equal(usage.messages, requestTokens(messages.slice(0, 2)) - requestTokens([]));
    assert.equal(usage.memory, estimatedTokens(memory));
    assert.equal(usage.runtimeContext + usage.memory, messageTokens(messages[2]!));
    assert.equal(usage.systemTools, estimatedTokens(JSON.stringify(builtIn)));
    assert.equal(usage.mcpTools, estimatedTokens(JSON.stringify(mcp)));
  });

  it("reports the window with messages as they stand and the rest from the latest request", () => {
    const manager = new ContextManager();
    const limits = defaultRuntimeLimits();
    const current = state();
    // Characters only: no token window to report.
    manager.configureTokenBudget(undefined, limits);
    assert.equal(contextUsageReport(manager, current), undefined);
    assert.equal(contextTokensInUse(manager, current), manager.estimateShortTermTokens(current));

    manager.configureTokenBudget(200_000, limits);
    const before = contextUsageReport(manager, current)!;
    assert.equal(before.measured, false);
    assert.equal(before.windowTokens, 200_000);
    assert.deepEqual(before.categories, counts({ messages: manager.conversationTokens(current) }));
    const budget = manager.tokenCapacity!;
    assert.equal(before.reservedTokens, budget.outputReserve + budget.toolReserve + budget.safetyReserve);
    assert.equal(before.compactionTokens, Math.floor(budget.inputCapacity * limits.contextCompactionTriggerRatio));

    manager.recordUsage(current.threadId, counts({ messages: 1, systemPrompt: 4_000, systemTools: 9_000 }));
    current.messages.push({ role: "assistant", content: "Done. ".repeat(500) });
    const after = contextUsageReport(manager, current)!;
    assert.equal(after.measured, true);
    assert.equal(after.categories.systemPrompt, 4_000);
    assert.equal(after.categories.messages, manager.conversationTokens(current));
    assert.ok(after.categories.messages > before.categories.messages);
    assert.equal(contextTokensInUse(manager, current), contextUsedTokens(after));
    // Another conversation is not measured yet.
    assert.equal(contextUsageReport(manager, state("thread_other"))!.measured, false);
  });

  it("records each main-agent request when the window is counted in tokens", async () => {
    const run = async (maxContextTokens?: number) => {
      const manager = new ContextManager();
      let calls = 0;
      const runtime = new AgentRuntime({
        limits: defaultRuntimeLimits(),
        contextManager: manager,
        buildSystemPrompt: async () => "Runtime policy. ".repeat(50),
        getWorkspaceSummary: async () => "",
        searchMemories: async () => [],
        appendEvent: async () => undefined,
        requestApproval: async () => false,
        toolCatalog: snapshotToolSet([
          {
            name: "read_file",
            mutating: false,
            definition: tool("read_file"),
            execute: async () => ({ ok: true, summary: "read", data: { content: "source" } }),
          },
        ]),
        provider: {
          name: "glm",
          model: "mock",
          complete: async () => ({
            message:
              ++calls === 1
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: "read", type: "function", function: { name: "read_file", arguments: "{}" } }],
                  }
                : { role: "assistant", content: "Source examined." },
          }),
        },
      });
      const current = state();
      await runtime.run(current, "Read source", {
        maxSteps: 3,
        maxContextChars: 250_000,
        ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
        maxOutputChars: 64_000,
        commandTimeoutMs: 1_000,
        approvalPolicy: "never",
      });
      return manager.measuredUsage(current.threadId);
    };
    const measured = await run(200_000);
    assert.ok(measured);
    assert.ok(measured.systemPrompt > 100, String(measured.systemPrompt));
    assert.ok(measured.systemTools > 0);
    assert.ok(measured.messages > 0);
    assert.equal(measured.mcpTools, 0);
    // Counted in characters, nothing is recorded.
    assert.equal(await run(), undefined);
  });

  it("lists used parts, the reserve and the free space so they add up to the window", () => {
    const usage = report(counts({ messages: 47_500, systemPrompt: 3_700, mcpTools: 11_500 }));
    const { used, rows } = contextUsageRows(usage);
    assert.equal(used, 62_700);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["messages", "systemPrompt", "mcpTools", "reserved", "free"],
    );
    assert.equal(
      rows.reduce((sum, row) => sum + row.tokens, 0),
      usage.windowTokens,
    );
    assert.equal(formatShare(0.048), "4.8%");
    assert.equal(formatShare(0.0004), "<0.1%");
    assert.equal(formatShare(0), "0.0%");
  });

  it("draws one bar and aligned rows in either language", () => {
    const usage = report(counts({ messages: 47_500, systemPrompt: 3_700, skills: 7_100 }));
    const english = renderContextUsage(usage, { language: "en_us", color: false, columns: 80 }).split("\n");
    assert.equal(english[0], "Context window  58.3k / 1m (6%)");
    // Parts under one cell still get one; the reserve is shaded apart from what is in use.
    assert.equal(english[1], `  ${"█".repeat(4)}${"▒".repeat(6)}${"░".repeat(30)}`);
    assert.deepEqual(english.slice(2, 8), [
      "  ■ Messages                 47.5k    4.8%",
      "  ■ System prompt             3.7k    0.4%",
      "  ■ Skills                    7.1k    0.7%",
      "  ▒ Reserved for responses  148.3k   14.8%",
      "  □ Free space              793.4k   79.3%",
      "  Older history is compacted at 766.5k.",
    ]);
    assert.equal(english.length, 8);
    const chinese = renderContextUsage({ ...usage, measured: false }, { language: "zh_cn", color: false, columns: 20 });
    assert.match(chinese, /^上下文窗口 {2}58\.3k \/ 1m \(6%\)\n {2}███▒▒░{11}\n/u);
    // Wide characters count two columns, so the numbers line up.
    assert.match(chinese, /\n {2}■ 消息 {9}47\.5k/u);
    assert.match(chinese, /\n {2}□ 剩余空间 {4}793\.4k/u);
    assert.match(chinese, /系统提示和工具会在下一次请求后计入。$/u);
  });
});

function report(categories: ContextUsageReport["categories"]): ContextUsageReport {
  return {
    windowTokens: 1_000_000,
    categories,
    reservedTokens: 148_304,
    compactionTokens: 766_526,
    measured: true,
  };
}
