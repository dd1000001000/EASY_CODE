import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeAssembly } from "../src/app/runtime-assembly.js";
import { ApprovalQueue } from "../src/command/approval-agent.js";
import { DEFAULT_RUNTIME_LIMITS, runtimeLimitsSchema } from "../src/config/runtime-limits.js";
import { ContextManager } from "../src/context/manager.js";
import type {
  ModelProvider,
  SessionState,
  ToolContext,
  TurnSteeringBatch,
  UserQuestion,
  UserQuestionHandler,
} from "../src/core/types.js";
import { isReservedOptionLabel, normalizeUserAnswers } from "../src/core/user-questions.js";
import { toolDisplayDetails } from "../src/runtime/tool-display-details.js";
import { TurnSteeringAttemptNotifier } from "../src/runtime/turn-steering-notifier.js";
import { AskUserTool } from "../src/tools/ask-user.js";
import { BENCHMARK_DISABLED_TOOLS, BuiltinToolSource } from "../src/tools/builtin-source.js";
import { bindBuiltinToolMetadata, toolMetadata } from "../src/tools/capabilities.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { createUIState } from "../src/ui/store.js";
import { questionModalHeight, renderQuestionModal } from "../src/ui/ink/modal.js";
import type { QuestionModal } from "../src/ui/ink/ink-store.js";
import type { UserQuestionPrompt, UserQuestionReply } from "../src/ui/interaction-port.js";
import { chooseOption, formatRemaining, questionDrafts, questionRows } from "../src/ui/user-questions.js";
import { WebInteraction } from "../src/web-server/interaction.js";
import { AgentRuntime } from "./approved-runtime.js";
import { describe, it } from "./harness.js";
import { baseSessionState } from "./session-state.js";
import { snapshotToolSet } from "./tool-set.js";

const storage: UserQuestion = {
  header: "Storage",
  question: "Which storage should the cache use?",
  multiSelect: false,
  options: [
    { label: "SQLite (Recommended)", description: "One file, no server" },
    { label: "PostgreSQL", description: null },
  ],
};
const targets: UserQuestion = {
  header: "Targets",
  question: "Which platforms must it run on?",
  multiSelect: true,
  options: [
    { label: "Windows", description: null },
    { label: "Linux", description: null },
    { label: "macOS", description: null },
  ],
};

function input(questions: readonly UserQuestion[]) {
  return {
    questions: questions.map((question) => ({
      header: question.header,
      question: question.question,
      multi_select: question.multiSelect,
      options: question.options.map((option) => ({ label: option.label, description: option.description ?? "" })),
    })),
  };
}

function context(askUser?: UserQuestionHandler, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    mode: "code",
    threadId: "thread_ask",
    turnId: "turn_ask",
    approvalPolicy: "never",
    requestApproval: async () => false,
    commandTimeoutMs: 1_000,
    maxOutputChars: 10_000,
    agentRole: "main_agent",
    ...(askUser ? { askUser } : {}),
    ...extra,
  };
}

function state(): SessionState {
  const now = new Date().toISOString();
  return {
    ...baseSessionState(),
    threadId: "thread_ask",
    mode: "code",
    provider: "deepseek",
    model: "mock",
    thinkingEffort: "low",
    workspaceRoot: process.cwd(),
    constraints: [],
    messages: [],
    filesRead: new Map(),
    changes: [],
    commands: [],
    commandApprovalPrefixes: [],
    pendingSteering: [],
    steeringSequence: 0,
    steeringWatermark: 0,
    workingSummary: "",
    compactedMessageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const options = {
  maxSteps: 4,
  maxContextChars: 100_000,
  maxOutputChars: 10_000,
  commandTimeoutMs: 1_000,
  approvalPolicy: "never" as const,
};

function askCall(questions: readonly UserQuestion[], id = "call_ask") {
  return { id, type: "function" as const, function: { name: "ask_user", arguments: JSON.stringify(input(questions)) } };
}

describe("ask_user tool", () => {
  it("builds its schema from the configured question and option counts", () => {
    const tool = new AskUserTool({
      askUserMinQuestions: 2,
      askUserMaxQuestions: 5,
      askUserMinOptions: 3,
      askUserMaxOptions: 6,
    });
    const questions = (tool.definition.function.parameters as { properties: { questions: Record<string, unknown> } })
      .properties.questions;
    assert.equal(questions.minItems, 2);
    assert.equal(questions.maxItems, 5);
    const options = (questions.items as { properties: { options: Record<string, unknown> } }).properties.options;
    assert.equal(options.minItems, 3);
    assert.equal(options.maxItems, 6);
    assert.throws(() => tool.inputSchema.parse(input([targets])));
    assert.doesNotThrow(() => tool.inputSchema.parse(input([targets, targets])));
  });

  it("rejects an Other option, repeated labels and too many questions", async () => {
    const tool = new AskUserTool();
    const ask: UserQuestionHandler = async () => ({ status: "answered", answers: [] });
    for (const label of ["Other", "other (please specify)", "其他", "其它方案"])
      assert.equal(isReservedOptionLabel(label), true);
    assert.equal(isReservedOptionLabel("Otherwise keep it"), false);
    const withOther = input([{ ...storage, options: [...storage.options, { label: "Other", description: null }] }]);
    assert.equal((await tool.execute(withOther, context(ask))).ok, false);
    const repeated = input([{ ...storage, options: [storage.options[0]!, storage.options[0]!] }]);
    assert.equal((await tool.execute(repeated, context(ask))).ok, false);
    assert.equal((await tool.execute(input([storage, storage, storage, storage]), context(ask))).ok, false);
  });

  it("is a main-agent control tool that never needs approval and stays out of benchmarks", async () => {
    const tool = bindBuiltinToolMetadata(new AskUserTool());
    const metadata = toolMetadata(tool);
    assert.deepEqual([...metadata.allowedRoles], ["main_agent"]);
    assert.deepEqual([...metadata.allowedModes].sort(), ["auto", "code", "plan"]);
    assert.equal(metadata.controlPlane, true);
    assert.equal(BENCHMARK_DISABLED_TOOLS.has("ask_user"), true);
    let asked = false;
    const ask: UserQuestionHandler = async () => {
      asked = true;
      return { status: "answered", answers: [{ selected: ["PostgreSQL"], custom: null }] };
    };
    const child = await tool.execute(input([storage]), context(ask, { agentRole: "subagent" }));
    assert.equal(child.ok, false);
    assert.equal(asked, false);
    assert.equal((await tool.execute(input([storage]), context())).ok, false);
  });

  it("is offered only when the session can answer it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-ask-user-"));
    try {
      const workspace = await WorkspaceManager.create(root);
      const names = async (userQuestions?: boolean) =>
        (
          await new BuiltinToolSource({
            workspace,
            ...(userQuestions === undefined ? {} : { userQuestions }),
          }).listTools()
        ).map((tool) => tool.name);
      assert.equal((await names(true)).includes("ask_user"), true);
      assert.equal((await names(false)).includes("ask_user"), false);
      assert.equal((await names()).includes("ask_user"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports answers, unanswered questions, a message instead, and a closed request", async () => {
    const tool = new AskUserTool();
    const answered = await tool.execute(
      input([storage]),
      context(async (questions) => {
        assert.equal(questions[0]?.options[1]?.description, null);
        return { status: "answered", answers: [{ selected: [], custom: "Keep JSON files for now" }] };
      }),
    );
    assert.equal(answered.ok, true);
    assert.deepEqual((answered.data as { answers: unknown[] }).answers, [
      { header: "Storage", question: storage.question, selected: [], custom: "Keep JSON files for now" },
    ]);
    const timeout = await tool.execute(
      input([storage]),
      context(async () => ({ status: "unanswered", reason: "timeout" })),
    );
    assert.equal(timeout.unansweredQuestions?.reason, "timeout");
    assert.equal(timeout.unansweredQuestions?.questions[0]?.question, storage.question);
    const superseded = await tool.execute(
      input([storage]),
      context(async () => ({ status: "superseded" })),
    );
    assert.deepEqual(superseded.data, { status: "superseded" });
    assert.equal(superseded.unansweredQuestions, undefined);
    const cancelled = await tool.execute(
      input([storage]),
      context(async () => ({ status: "cancelled" })),
    );
    assert.equal(cancelled.ok, false);
  });

  it("accepts only answers that fit the questions that were shown", () => {
    assert.deepEqual(normalizeUserAnswers([storage], [{ selected: ["PostgreSQL"], custom: null }]), [
      { selected: ["PostgreSQL"], custom: null },
    ]);
    assert.equal(normalizeUserAnswers([storage], [{ selected: ["PostgreSQL", "SQLite (Recommended)"] }]), undefined);
    assert.equal(normalizeUserAnswers([storage], [{ selected: ["PostgreSQL"], custom: "and more" }]), undefined);
    assert.equal(normalizeUserAnswers([storage], [{ selected: ["MySQL"] }]), undefined);
    assert.equal(normalizeUserAnswers([storage], [{ selected: [], custom: "   " }]), undefined);
    assert.equal(normalizeUserAnswers([storage], [{ selected: [], custom: "x".repeat(2001) }]), undefined);
    assert.equal(normalizeUserAnswers([storage, targets], [{ selected: ["PostgreSQL"] }]), undefined);
    assert.deepEqual(normalizeUserAnswers([targets], [{ selected: ["macOS", "Windows"], custom: "FreeBSD" }]), [
      { selected: ["Windows", "macOS"], custom: "FreeBSD" },
    ]);
  });

  it("validates the configured limits", () => {
    const parse = (patch: Record<string, number>) =>
      runtimeLimitsSchema.safeParse({ ...DEFAULT_RUNTIME_LIMITS, ...patch });
    assert.equal(DEFAULT_RUNTIME_LIMITS.askUserMaxQuestions, 3);
    assert.equal(DEFAULT_RUNTIME_LIMITS.askUserMinOptions, 2);
    assert.equal(DEFAULT_RUNTIME_LIMITS.askUserMaxOptions, 4);
    assert.equal(DEFAULT_RUNTIME_LIMITS.askUserTimeoutMs, 900_000);
    assert.equal(parse({ askUserMinQuestions: 4, askUserMaxQuestions: 3 }).success, false);
    assert.equal(parse({ askUserMinOptions: 5, askUserMaxOptions: 4 }).success, false);
    assert.equal(parse({ askUserMinOptions: 1 }).success, false);
    assert.equal(parse({ askUserTimeoutMs: 1_000 }).success, false);
    assert.equal(parse({ askUserMaxQuestions: 6, askUserMaxOptions: 8, askUserTimeoutMs: 120_000 }).success, true);
  });

  it("shows each question with its answer in the tool details", () => {
    const details = toolDisplayDetails(
      new AskUserTool(),
      "ask_user",
      JSON.stringify(input([storage, targets])),
      {
        ok: true,
        summary: "answered",
        data: {
          status: "answered",
          answers: [
            { selected: ["PostgreSQL"], custom: null },
            { selected: ["Linux"], custom: "FreeBSD" },
          ],
        },
      },
      state(),
    );
    assert.deepEqual(details, [
      { label: "Storage", value: `${storage.question} → PostgreSQL` },
      { label: "Targets", value: `${targets.question} → Linux, FreeBSD` },
    ]);
    const skipped = toolDisplayDetails(
      new AskUserTool(),
      "ask_user",
      JSON.stringify(input([storage])),
      { ok: true, summary: "skipped", data: { status: "unanswered", reason: "skipped" } },
      state(),
    );
    assert.equal(skipped[0]?.value, `${storage.question} → Not answered (skipped)`);
  });
});

describe("ask_user in a request", () => {
  function runtime(provider: ModelProvider, askUser: UserQuestionHandler, extra: Record<string, unknown> = {}) {
    return new AgentRuntime({
      provider,
      toolCatalog: snapshotToolSet([new AskUserTool()]),
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
      askUser,
      ...extra,
    });
  }

  it("continues the request with the answer", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock",
      async complete(request) {
        calls += 1;
        if (calls === 1) return { message: { role: "assistant", content: null, tool_calls: [askCall([storage])] } };
        const reply = request.messages.find((message) => message.role === "tool");
        assert.match(String(reply?.content), /PostgreSQL/u);
        return { message: { role: "assistant", content: "Using PostgreSQL.", tool_calls: [] } };
      },
    };
    const result = await runtime(provider, async () => ({
      status: "answered",
      answers: [{ selected: ["PostgreSQL"], custom: null }],
    })).run(state(), "add a cache", options);
    assert.equal(result.reason, "success");
    assert.equal(result.text, "Using PostgreSQL.");
    assert.equal(calls, 2);
  });

  it("ends the request without another model call when the question goes unanswered", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock",
      async complete() {
        calls += 1;
        return { message: { role: "assistant", content: null, tool_calls: [askCall([storage, targets])] } };
      },
    };
    for (const reason of ["timeout", "skipped"] as const) {
      calls = 0;
      const result = await runtime(provider, async () => ({ status: "unanswered", reason })).run(
        state(),
        "add a cache",
        options,
      );
      assert.equal(result.reason, "needs_input");
      assert.equal(calls, 1);
      assert.match(result.text, reason === "timeout" ? /not answered in time/u : /was skipped/u);
      assert.match(result.text, /1\. Which storage should the cache use\?\n {3}- SQLite \(Recommended\) — One file/u);
      assert.match(result.text, /2\. Which platforms must it run on\? \(choose any\)/u);
    }
  });

  it("rejects ask_user batched with other calls without asking", async () => {
    let calls = 0;
    let asked = false;
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock",
      async complete(request) {
        calls += 1;
        if (calls === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [askCall([storage], "call_a"), askCall([targets], "call_b")],
            },
          };
        }
        const replies = request.messages.filter((message) => message.role === "tool");
        assert.equal(replies.length, 2);
        assert.ok(replies.every((message) => String(message.content).includes("ask_user_must_be_exclusive")));
        return { message: { role: "assistant", content: "Asked nothing.", tool_calls: [] } };
      },
    };
    const result = await runtime(provider, async () => {
      asked = true;
      return { status: "cancelled" };
    }).run(state(), "add a cache", options);
    assert.equal(result.reason, "success");
    assert.equal(asked, false);
  });

  it("closes the question when the user sends a message and continues with it", async () => {
    const notifier = new TurnSteeringAttemptNotifier();
    let pending: TurnSteeringBatch | undefined;
    let calls = 0;
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock",
      async complete(request) {
        calls += 1;
        if (calls === 1) return { message: { role: "assistant", content: null, tool_calls: [askCall([storage])] } };
        assert.ok(request.messages.some((message) => message.role === "user" && message.content.includes("Use Redis")));
        return { message: { role: "assistant", content: "Using Redis.", tool_calls: [] } };
      },
    };
    const askUser: UserQuestionHandler = (_questions, { supersede }) =>
      new Promise((resolve) => {
        supersede?.addEventListener("abort", () => resolve({ status: "superseded" }), { once: true });
        const text = "Use Redis instead";
        pending = {
          source: "user_adjust",
          entries: [
            {
              source: "user_adjust",
              id: "steering_1",
              sequence: 1,
              targetTurnId: "turn_active",
              message: { role: "user", content: text },
              queuedAt: new Date().toISOString(),
            },
          ],
          throughSequence: 1,
          message: { role: "user", content: text },
        } as TurnSteeringBatch;
        notifier.notify(1);
      });
    const result = await runtime(provider, askUser, {
      steeringNotifier: notifier,
      takeSteering: async () => {
        const value = pending;
        pending = undefined;
        return value;
      },
      sealSteering: async () => undefined,
      hasPendingSteering: async () => Boolean(pending),
    }).run(state(), "add a cache", options);
    assert.equal(result.reason, "success");
    assert.equal(result.text, "Using Redis.");
  });
});

describe("ask_user host", () => {
  function assembly(askUser: (prompt: Readonly<UserQuestionPrompt>) => Promise<UserQuestionReply>, timeoutMs = 60_000) {
    const host = new RuntimeAssembly({
      state: { threadId: "thread_ask" },
      approvalQueue: new ApprovalQueue(),
      config: { limits: { ...DEFAULT_RUNTIME_LIMITS, askUserTimeoutMs: timeoutMs } },
      terminal: { askUser },
    } as unknown as ConstructorParameters<typeof RuntimeAssembly>[0]);
    return (questions: readonly UserQuestion[], options: { signal?: AbortSignal; supersede?: AbortSignal } = {}) =>
      (host as unknown as { askUser: UserQuestionHandler }).askUser(questions, options);
  }

  it("turns replies into outcomes", async () => {
    assert.deepEqual(await assembly(async () => [{ selected: ["PostgreSQL"], custom: null }])([storage]), {
      status: "answered",
      answers: [{ selected: ["PostgreSQL"], custom: null }],
    });
    assert.deepEqual(await assembly(async () => "skipped")([storage]), { status: "unanswered", reason: "skipped" });
    // A reply that does not fit the questions counts as no answer.
    assert.deepEqual(await assembly(async () => [{ selected: ["MySQL"], custom: null }])([storage]), {
      status: "unanswered",
      reason: "skipped",
    });
  });

  it("ends the question when its time runs out", async () => {
    let shown: Readonly<UserQuestionPrompt> | undefined;
    const outcome = await assembly(
      (prompt) =>
        new Promise((resolve) => {
          shown = prompt;
          prompt.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
      20,
    )([storage]);
    assert.deepEqual(outcome, { status: "unanswered", reason: "timeout" });
    assert.ok(shown && shown.expiresAt > Date.now() - 1_000);
  });

  it("withdraws the question for a new message or a closed request", async () => {
    const waitForClose = (prompt: Readonly<UserQuestionPrompt>): Promise<UserQuestionReply> =>
      new Promise((resolve) => prompt.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
    const message = new AbortController();
    const superseded = assembly(waitForClose)([storage], { supersede: message.signal });
    message.abort();
    assert.deepEqual(await superseded, { status: "superseded" });
    const request = new AbortController();
    const cancelled = assembly(waitForClose)([storage], { signal: request.signal });
    request.abort();
    assert.deepEqual(await cancelled, { status: "cancelled" });
  });
});

describe("ask_user screens", () => {
  it("lets the Web answer, skip, or reject answers that do not fit", async () => {
    const host = new WebInteraction();
    const controller = new AbortController();
    const prompt = { questions: [storage, targets], expiresAt: Date.now() + 60_000, signal: controller.signal };
    const answered = host.askUser(prompt);
    const decision = host.snapshot().view.decision!;
    assert.equal(decision.kind, "question");
    assert.equal(decision.questions?.length, 2);
    assert.equal(host.resolveDecision(decision.id, `answer:${JSON.stringify([{ selected: ["MySQL"] }, {}])}`), false);
    assert.equal(host.resolveDecision(decision.id, "allow_once"), false);
    const valid = [
      { selected: ["PostgreSQL"], custom: null },
      { selected: ["Linux"], custom: "FreeBSD" },
    ];
    assert.equal(host.resolveDecision(decision.id, `answer:${JSON.stringify(valid)}`), true);
    assert.deepEqual(await answered, valid);

    const skipped = host.askUser(prompt);
    assert.equal(host.resolveDecision(host.snapshot().view.decision!.id, "skip"), true);
    assert.equal(await skipped, "skipped");

    const withdrawn = host.askUser(prompt);
    controller.abort();
    assert.equal(await withdrawn, undefined);
    assert.equal(host.snapshot().view.decision, null);
  });

  it("draws the Ink question card with a countdown, the input row last, and a fixed height", () => {
    const modal: QuestionModal = {
      kind: "question",
      id: "question-1",
      questions: [storage, targets],
      expiresAt: 1_000_000 + 14 * 60_000 + 5_000,
      resolve: () => undefined,
    };
    const drafts = [
      { selected: [], custom: null },
      { selected: ["Linux"], custom: "FreeBSD" },
    ];
    const texts = ["", "FreeBSD"];
    const view = { language: "en_us" as const, columns: 90, rows: 40, color: false };
    const ui = createUIState();
    const first = renderQuestionModal(modal, { page: 0, drafts, texts, selectedIndex: 1, now: 1_000_000 }, ui, view);
    assert.match(first, /Question 1\/2 · Storage · Ends in 14:05 without an answer/u);
    assert.match(first, /Which storage should the cache use\?/u);
    assert.match(first, /› PostgreSQL/u);
    assert.match(first, /Other: type your answer here/u);
    assert.doesNotMatch(first, /last row/u);
    const typing = renderQuestionModal(modal, { page: 0, drafts, texts, selectedIndex: 2, now: 1_000_000 }, ui, view);
    assert.match(typing, /› Other: █type your answer here/u);
    const second = renderQuestionModal(modal, { page: 1, drafts, texts, selectedIndex: 3, now: 1_000_000 }, ui, view);
    assert.match(second, /\[x\] Linux/u);
    assert.match(second, /› \[x\] Other: FreeBSD█/u);
    assert.doesNotMatch(second, /Continue/u);
    assert.equal(questionModalHeight(modal, ui, view), Math.max(first.split("\n").length, second.split("\n").length));
    const zh = renderQuestionModal(modal, { page: 0, drafts, texts, selectedIndex: 0, now: 1_000_000 }, ui, {
      ...view,
      language: "zh_cn",
    });
    assert.match(zh, /问题 1\/2 · Storage · 14:05 内未回答将结束本轮/u);
    assert.match(zh, /其他：在这里直接输入你的回答/u);
    assert.doesNotMatch(zh, /最后一行/u);
  });

  it("keeps choices and the user's own text consistent", () => {
    assert.deepEqual(chooseOption(storage, { selected: [], custom: "x" }, "PostgreSQL"), {
      selected: ["PostgreSQL"],
      custom: null,
    });
    assert.deepEqual(chooseOption(targets, { selected: ["macOS"], custom: null }, "Windows"), {
      selected: ["Windows", "macOS"],
      custom: null,
    });
    assert.deepEqual(chooseOption(targets, { selected: ["macOS"], custom: null }, "macOS"), {
      selected: [],
      custom: null,
    });
    assert.deepEqual(questionDrafts([storage, targets], [[], ["Linux"]], ["  Redis  ", " "]), [
      { selected: [], custom: "Redis" },
      { selected: ["Linux"], custom: null },
    ]);
    const unfocused = { text: "", focused: false, width: 40 };
    assert.equal(
      questionRows("en_us", targets, { selected: ["Linux"], custom: null }, unfocused)[1]?.label,
      "[x] Linux",
    );
    assert.equal(questionRows("en_us", targets, { selected: [], custom: null }, unfocused).length, 4);
    // Long text keeps its end visible next to the cursor.
    const long = questionRows(
      "en_us",
      storage,
      { selected: [], custom: "x" },
      { text: `start ${"y".repeat(60)}end`, focused: true, width: 30 },
    );
    const row = long.at(-1)!.label;
    assert.match(row, /^✓ Other: …y+end█$/u);
    assert.ok(row.length <= 30);
    assert.equal(formatRemaining(61_000), "1:01");
    assert.equal(formatRemaining(3_725_000), "1:02:05");
    assert.equal(formatRemaining(-5), "0:00");
  });
});
