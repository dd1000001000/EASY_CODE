import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { EasyCodeApp } from "../src/app.js";
import type {
  ModelSelectorChoice,
  ProviderSelectorChoice,
  ThinkingEffortSelectorChoice,
} from "../src/cli/model-selector.js";
import { Terminal } from "../src/cli/terminal.js";
import type {
  ProviderName,
  SessionState,
  SubagentAssignmentSnapshot,
  ThinkingEffort,
} from "../src/core/types.js";
import { createStorage } from "../src/storage/index.js";
import { applyTaskGraphOperation } from "../src/tasks/task-graph.js";
import { ThreadStore } from "../src/threads/index.js";
import { describe, it } from "./harness.js";

const TEST_ENVIRONMENT = [
  "EASY_CODE_CONFIG_DIR",
  "EASY_CODE_DATA_DIR",
  "EASY_CODE_CACHE_DIR",
  "EASY_CODE_PROVIDER",
  "EASY_CODE_THINKING_EFFORT",
  "EASY_CODE_MAX_STEPS",
  "EASY_CODE_MAX_CONTEXT_CHARS",
  "QWEN_API_KEY",
  "DASHSCOPE_API_KEY",
  "DEEPSEEK_API_KEY",
  "ZAI_API_KEY",
  "GLM_API_KEY",
  "ZHIPUAI_API_KEY",
  "QWEN_MODEL",
  "DEEPSEEK_MODEL",
  "GLM_MODEL",
] as const;

interface AppFixture {
  app: EasyCodeApp;
  terminal: Terminal;
  workspace: string;
  dataDir: string;
  output(): string;
  close(): void;
}

class ScriptedModelTerminal extends Terminal {
  providerChoices: readonly ProviderSelectorChoice[] = [];
  modelChoices: readonly ModelSelectorChoice[] = [];
  thinkingChoices: readonly ThinkingEffortSelectorChoice[] = [];
  initialThinkingEffort?: ThinkingEffort;
  thinkingProviderLabel?: string;
  thinkingModel?: string;

  constructor(
    input: PassThrough,
    output: PassThrough,
    private readonly providerSelection: ProviderName | undefined,
    private readonly modelSelection: string | undefined,
    private readonly thinkingSelection: ThinkingEffort | undefined,
  ) {
    super(input, output);
  }

  override isInteractive(): boolean {
    return true;
  }

  override async selectProvider(
    choices: readonly ProviderSelectorChoice[],
  ): Promise<ProviderName | undefined> {
    this.providerChoices = choices;
    return this.providerSelection;
  }

  override async selectModel(
    _providerName: string,
    choices: readonly ModelSelectorChoice[],
  ): Promise<string | undefined> {
    this.modelChoices = choices;
    return this.modelSelection;
  }

  override async selectThinkingEffort(
    providerName: string,
    model: string,
    choices: readonly ThinkingEffortSelectorChoice[],
    initialEffort: ThinkingEffort,
  ): Promise<ThinkingEffort | undefined> {
    this.thinkingProviderLabel = providerName;
    this.thinkingModel = model;
    this.thinkingChoices = choices;
    this.initialThinkingEffort = initialEffort;
    return this.thinkingSelection;
  }
}

async function createAppFixture(
  keys: { qwen?: string; deepseek?: string; glm?: string },
  selection?: {
    provider?: ProviderName;
    model?: string;
    thinkingEffort?: ThinkingEffort;
  },
): Promise<AppFixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-model-command-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const previous = new Map(
    TEST_ENVIRONMENT.map((name) => [name, process.env[name]] as const),
  );
  process.env.EASY_CODE_CONFIG_DIR = path.join(root, "config");
  process.env.EASY_CODE_DATA_DIR = path.join(root, "data");
  process.env.EASY_CODE_CACHE_DIR = path.join(root, "cache");
  process.env.EASY_CODE_PROVIDER = "qwen";
  delete process.env.EASY_CODE_THINKING_EFFORT;
  delete process.env.EASY_CODE_MAX_STEPS;
  delete process.env.EASY_CODE_MAX_CONTEXT_CHARS;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.QWEN_MODEL;
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.GLM_MODEL;
  delete process.env.GLM_API_KEY;
  delete process.env.ZHIPUAI_API_KEY;
  if (keys.qwen) process.env.QWEN_API_KEY = keys.qwen;
  else delete process.env.QWEN_API_KEY;
  if (keys.deepseek) process.env.DEEPSEEK_API_KEY = keys.deepseek;
  else delete process.env.DEEPSEEK_API_KEY;
  if (keys.glm) process.env.ZAI_API_KEY = keys.glm;
  else delete process.env.ZAI_API_KEY;

  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let transcript = "";
  output.on("data", (chunk: string) => {
    transcript += chunk;
  });
  const terminal = selection
    ? new ScriptedModelTerminal(
        input,
        output,
        selection.provider,
        selection.model,
        selection.thinkingEffort,
      )
    : new Terminal(input, output);

  try {
    const app = await EasyCodeApp.create({
      workspaceRoot: workspace,
      terminal,
      // Never inspect the developer's real operating-system credentials.
      credentialStore: false,
    });
    let closed = false;
    return {
      app,
      terminal,
      workspace,
      dataDir: path.join(root, "data"),
      output: () => transcript,
      close: () => {
        if (closed) return;
        closed = true;
        try {
          app.close();
        } finally {
          terminal.close();
          restoreEnvironment(previous);
          rmSync(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    terminal.close();
    restoreEnvironment(previous);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function restoreEnvironment(
  previous: ReadonlyMap<string, string | undefined>,
): void {
  for (const name of TEST_ENVIRONMENT) {
    const value = previous.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function assertMissingKey(
  provider: ProviderName,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      new RegExp(`easy-code config set ${provider}\\.api-key`, "u"),
    );
    assert.doesNotMatch(error.message, /config\.toml|YOUR_API_KEY/u);
    return true;
  };
}

describe("/model", () => {
  it("validates direct switches against the provider catalog and preserves state on failure", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    try {
      await assert.rejects(
        fixture.app.handleSlashCommand("/model deepseek deepseek-v4-pro"),
        assertMissingKey("deepseek"),
      );
      await assert.rejects(
        fixture.app.handleSlashCommand("/provider deepseek"),
        assertMissingKey("deepseek"),
      );
      await assert.rejects(
        fixture.app.handleSlashCommand("/model glm glm-5.3-flash"),
        assertMissingKey("glm"),
      );
      await assert.rejects(
        fixture.app.handleSlashCommand("/model qwen deepseek-v4-pro"),
        /not in the Alibaba Qwen catalog/u,
      );
      await assert.rejects(
        fixture.app.handleSlashCommand("/model unknown-model"),
        /Supported models:/u,
      );

      let offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/status");
      const unchanged = fixture.output().slice(offset);
      assert.match(unchanged, /"provider": "qwen"/u);
      assert.match(unchanged, /"model": "qwen3\.7-max"/u);

      offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/model Qwen3.7-Plus");
      await fixture.app.handleSlashCommand("/status");
      const switched = fixture.output().slice(offset);
      assert.match(switched, /Alibaba Qwen \/ qwen3\.7-plus/u);
      assert.match(switched, /"model": "qwen3\.7-plus"/u);

      await assert.rejects(
        fixture.app.handleSlashCommand("/model qwen"),
        /Usage: \/model/u,
      );
      await assert.rejects(
        fixture.app.handleSlashCommand("/model unknown model"),
        /Usage: \/model/u,
      );
    } finally {
      fixture.close();
    }
  });

  it("switches provider/model directly when the target key is configured", async () => {
    const fixture = await createAppFixture({
      qwen: "qwen-test-key",
      deepseek: "deepseek-test-key",
    });
    try {
      const offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/model deepseek deepseek-v4-flash");
      await fixture.app.handleSlashCommand("/status");
      const result = fixture.output().slice(offset);
      assert.match(result, /DeepSeek \/ deepseek-v4-flash/u);
      assert.match(result, /"provider": "deepseek"/u);
      assert.match(result, /"model": "deepseek-v4-flash"/u);
    } finally {
      fixture.close();
    }
  });

  it("switches to GLM labels canonically and applies its vision matrix", async () => {
    const fixture = await createAppFixture({
      qwen: "qwen-test-key",
      glm: "glm-test-key",
    });
    try {
      await fixture.app.handleSlashCommand("/model glm GLM-5.3-Flash");
      await fixture.app.handleSlashCommand("/status");
      assert.match(fixture.output(), /Zhipu GLM \/ glm-5\.3-flash/u);
      assert.match(fixture.output(), /"provider": "glm"/u);
      assert.match(fixture.output(), /"vision": true/u);

      const offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/model GLM-5.3");
      await fixture.app.handleSlashCommand("/status");
      const textOnly = fixture.output().slice(offset);
      assert.match(textOnly, /Zhipu GLM \/ glm-5\.3/u);
      assert.match(textOnly, /"vision": false/u);
    } finally {
      fixture.close();
    }
  });

  it("opens provider, model, and thinking menus and saves an unsupported effort choice", async () => {
    const fixture = await createAppFixture(
      { qwen: "qwen-test-key", deepseek: "deepseek-test-key" },
      {
        provider: "deepseek",
        model: "deepseek-v4-flash-vision-exp",
        thinkingEffort: "high",
      },
    );
    try {
      await fixture.app.handleSlashCommand("/model");
      await fixture.app.handleSlashCommand("/status");
      await fixture.app.handleSlashCommand("/context");

      const terminal = fixture.terminal as ScriptedModelTerminal;
      assert.deepEqual(
        terminal.providerChoices.map((choice) => choice.label),
        ["DeepSeek", "Alibaba Qwen", "Zhipu GLM"],
      );
      assert.deepEqual(
        terminal.modelChoices.map((choice) => choice.id),
        [
          "deepseek-v4-flash",
          "deepseek-v4-pro",
          "deepseek-v4-flash-vision-exp",
        ],
      );
      assert.equal(terminal.thinkingProviderLabel, "DeepSeek");
      assert.equal(terminal.thinkingModel, "deepseek-v4-flash-vision-exp");
      assert.equal(terminal.initialThinkingEffort, "medium");
      assert.deepEqual(
        terminal.thinkingChoices.map(({ id, applied }) => ({ id, applied })),
        [
          { id: "none", applied: false },
          { id: "low", applied: false },
          { id: "medium", applied: false },
          { id: "high", applied: false },
        ],
      );
      assert.match(
        fixture.output(),
        /DeepSeek \/ deepseek-v4-flash-vision-exp \/ thinking high \(saved, not applied\)/u,
      );
      assert.match(fixture.output(), /"provider": "deepseek"/u);
      assert.match(fixture.output(), /"thinkingEffort": "high"/u);
      assert.match(fixture.output(), /"thinkingApplied": false/u);
      assert.match(fixture.output(), /"baseStepLimit": 40/u);
      assert.match(fixture.output(), /"stepLimit": 160/u);
      assert.match(fixture.output(), /"baseContextCharLimit": 400000/u);
      assert.match(fixture.output(), /"contextCharLimit": 1600000/u);
      assert.match(fixture.output(), /"budgetChars": 1600000/u);
    } finally {
      fixture.close();
    }
  });

  it("keeps the current selection when the model stage is canceled", async () => {
    const fixture = await createAppFixture(
      { qwen: "qwen-test-key", deepseek: "deepseek-test-key" },
      { provider: "deepseek" },
    );
    try {
      await fixture.app.handleSlashCommand("/model");
      await fixture.app.handleSlashCommand("/status");
      assert.match(fixture.output(), /Model selection canceled/u);
      assert.match(fixture.output(), /"provider": "qwen"/u);
      assert.match(fixture.output(), /"model": "qwen3\.7-max"/u);
      assert.match(fixture.output(), /"thinkingEffort": "medium"/u);
    } finally {
      fixture.close();
    }
  });

  it("keeps provider, model, and effort unchanged when the thinking stage is canceled", async () => {
    const fixture = await createAppFixture(
      { qwen: "qwen-test-key", deepseek: "deepseek-test-key" },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinkingEffort: undefined,
      },
    );
    try {
      await fixture.app.handleSlashCommand("/model");
      await fixture.app.handleSlashCommand("/status");

      const terminal = fixture.terminal as ScriptedModelTerminal;
      assert.equal(terminal.thinkingModel, "deepseek-v4-pro");
      assert.deepEqual(
        terminal.thinkingChoices.map((choice) => choice.id),
        ["none", "low", "medium", "high"],
      );
      assert.match(fixture.output(), /Model selection canceled/u);
      assert.match(fixture.output(), /"provider": "qwen"/u);
      assert.match(fixture.output(), /"model": "qwen3\.7-max"/u);
      assert.match(fixture.output(), /"thinkingEffort": "medium"/u);
      assert.match(fixture.output(), /"thinkingApplied": true/u);
      assert.match(fixture.output(), /"stepLimit": 80/u);
      assert.doesNotMatch(fixture.output(), /Model switched to DeepSeek/u);
    } finally {
      fixture.close();
    }
  });

  it("fails the first task locally when the active provider has no key", async () => {
    const fixture = await createAppFixture({});
    try {
      await assert.rejects(
        fixture.app.runOnce("do not send a network request"),
        assertMissingKey("qwen"),
      );
    } finally {
      fixture.close();
    }
  });

  it("keeps the user-facing task DAG command read-only", async () => {
    const fixture = await createAppFixture({ qwen: "qwen-test-key" });
    try {
      await fixture.app.handleSlashCommand("/tasks");
      assert.match(fixture.output(), /This thread has no task DAG/u);
      const internal = fixture.app as unknown as { state: SessionState };
      internal.state.taskGraph = applyTaskGraphOperation(undefined, {
        action: "create",
        goal: "Show this graph without changing it",
        tasks: [{
          id: "inspect",
          title: "Inspect",
          description: "Inspect the current state",
          dependencies: [],
          inputs: ["Thread state"],
          expectedArtifacts: ["Read-only output"],
          completionChecks: ["The state is displayed"],
          failureHandling: "Block if state cannot be read",
        }],
      }, { turnId: "turn_cli_tasks" });
      const before = JSON.stringify(internal.state.taskGraph);
      await fixture.app.handleSlashCommand("/tasks");
      assert.match(fixture.output(), /Show this graph without changing it/u);
      assert.match(fixture.output(), /□ 1\. \[inspect\] Inspect/u);
      assert.equal(JSON.stringify(internal.state.taskGraph), before);
      await assert.rejects(
        fixture.app.handleSlashCommand("/tasks complete"),
        /Usage: \/tasks/u,
      );
    } finally {
      fixture.close();
    }
  });

  it("shows child-agent assignments through read-only slash commands", async () => {
    const fixture = await createAppFixture({ qwen: "qwen-test-key" });
    try {
      await fixture.app.handleSlashCommand("/agents");
      await fixture.app.handleSlashCommand("/subagents");
      assert.match(fixture.output(), /Child agents · 0\/4 active · 0 total/u);
      assert.match(fixture.output(), /No child agents in this runtime/u);
      await assert.rejects(
        fixture.app.handleSlashCommand("/agents stop"),
        /Usage: \/agents/u,
      );
    } finally {
      fixture.close();
    }
  });

  it("refuses Plan mode while a task DAG is unfinished", async () => {
    const fixture = await createAppFixture({ qwen: "qwen-test-key" });
    try {
      const internal = fixture.app as unknown as { state: SessionState };
      internal.state.taskGraph = applyTaskGraphOperation(undefined, {
        action: "create",
        goal: "Finish implementation before entering Plan mode",
        tasks: [{
          id: "implementation",
          title: "Implementation",
          description: "Complete the implementation",
          dependencies: [],
          inputs: ["Workspace"],
          expectedArtifacts: ["Implemented change"],
          completionChecks: ["Implementation is verified"],
          failureHandling: "Block on an external requirement",
        }],
      }, { turnId: "turn_mode_guard" });
      await assert.rejects(
        fixture.app.handleSlashCommand("/mode plan"),
        /Cannot switch to Plan mode while a task DAG is active or blocked/u,
      );
      assert.notEqual(internal.state.mode, "plan");
    } finally {
      fixture.close();
    }
  });

  it("refuses a Plan-mode override when resuming an unfinished DAG", async () => {
    const fixture = await createAppFixture({ qwen: "qwen-test-key" });
    const resumeInput = new PassThrough();
    const resumeOutput = new PassThrough();
    const resumeTerminal = new Terminal(resumeInput, resumeOutput);
    try {
      const internal = fixture.app as unknown as { state: SessionState };
      const operation = {
        action: "create" as const,
        goal: "Resume this graph only in an execution-capable mode",
        tasks: [{
          id: "resume",
          title: "Resume",
          description: "Continue implementation after resume",
          dependencies: [],
          inputs: ["Saved task state"],
          expectedArtifacts: ["Completed work"],
          completionChecks: ["The resumed work is verified"],
          failureHandling: "Block on a missing external condition",
        }],
      };
      const graph = applyTaskGraphOperation(undefined, operation, {
        turnId: "turn_resume_guard",
      });
      const threadId = internal.state.threadId;
      const storage = createStorage(fixture.dataDir);
      try {
        const threads = new ThreadStore(storage);
        threads.appendEvent(threadId, {
          type: "tool.result",
          turnId: "turn_resume_guard",
          phase: "completed",
          payload: {
            callId: "call_resume_guard",
            tool: "manage_tasks",
            message: {
              role: "tool",
              tool_call_id: "call_resume_guard",
              name: "manage_tasks",
              content: '{"ok":true}',
            },
            taskGraph: graph,
            taskGraphOperation: operation,
          },
        });
      } finally {
        storage.close();
      }
      await fixture.app.closeAsync();

      await assert.rejects(
        EasyCodeApp.create({
          workspaceRoot: fixture.workspace,
          resumeThreadId: threadId,
          mode: "plan",
          terminal: resumeTerminal,
          credentialStore: false,
        }),
        /Cannot resume an active or blocked task DAG in Plan mode/u,
      );
    } finally {
      resumeTerminal.close();
      fixture.close();
    }
  });

  it("queues /image paths only for verified vision models", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    try {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAEklEQVR4nGNgGAWjYBSMAggAAAQQAAFVN1rQAAAAAElFTkSuQmCC",
        "base64",
      );
      writeFileSync(path.join(fixture.workspace, "screen shot.png"), png);
      await assert.rejects(
        fixture.app.handleSlashCommand('/image "screen shot.png"'),
        /text-only/u,
      );

      await fixture.app.handleSlashCommand("/model qwen3-vl-plus");
      await fixture.app.handleSlashCommand('/image "screen shot.png"');
      await fixture.app.handleSlashCommand("/status");
      assert.match(fixture.output(), /Queued Image #1: 16x16 image\/png/u);
      assert.match(fixture.output(), /"pendingImages": \[\s*"Image #1"/u);
      assert.match(fixture.output(), /"vision": true/u);

      await fixture.app.handleSlashCommand("/model qwen3-max");
      assert.match(fixture.output(), /queued image\(s\) remain attached/u);
    } finally {
      fixture.close();
    }
  });
});

describe("memory commands", () => {
  it("shows the last eight active short-term message previews by default", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    try {
      const internal = fixture.app as unknown as { state: SessionState };
      internal.state.goal = "Explain the current task";
      internal.state.messages = Array.from({ length: 12 }, (_, index) => ({
        role: "user" as const,
        content: `message-${index + 1}`,
      }));
      internal.state.compactedMessageCount = 2;

      const offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/memory short");
      const memory = JSON.parse(fixture.output().slice(offset)) as {
        latestRequest?: string;
        showingLast?: number;
        totalActive?: number;
        recentMessagePreviews?: string[];
        goal?: unknown;
        activeMessageCount?: unknown;
        recentMessages?: unknown;
      };

      assert.equal(memory.latestRequest, "Explain the current task");
      assert.equal(memory.showingLast, 8);
      assert.equal(memory.totalActive, 10);
      assert.deepEqual(
        memory.recentMessagePreviews,
        Array.from({ length: 8 }, (_, index) => `User: message-${index + 5}`),
      );
      assert.equal("goal" in memory, false);
      assert.equal("activeMessageCount" in memory, false);
      assert.equal("recentMessages" in memory, false);
    } finally {
      fixture.close();
    }
  });

  it("accepts a positive preview limit and rejects invalid short-memory arguments", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    try {
      const internal = fixture.app as unknown as { state: SessionState };
      internal.state.messages = Array.from({ length: 6 }, (_, index) => ({
        role: "assistant" as const,
        content: `reply-${index + 1}`,
      }));
      internal.state.compactedMessageCount = 1;

      const offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/memory short 3");
      const memory = JSON.parse(fixture.output().slice(offset)) as {
        showingLast?: number;
        totalActive?: number;
        recentMessagePreviews?: string[];
      };
      assert.equal(memory.showingLast, 3);
      assert.equal(memory.totalActive, 5);
      assert.deepEqual(memory.recentMessagePreviews, [
        "Assistant: reply-4",
        "Assistant: reply-5",
        "Assistant: reply-6",
      ]);

      for (const command of [
        "/memory short 0",
        "/memory short -1",
        "/memory short 1.5",
        "/memory short nope",
        "/memory short 3 extra",
        "/memory short 9007199254740992",
      ]) {
        await assert.rejects(
          fixture.app.handleSlashCommand(command),
          /Usage: \/memory short \[limit\]/u,
        );
      }
    } finally {
      fixture.close();
    }
  });
});

describe("/usage", () => {
  it("prints cumulative provider-reported accounting for the active thread", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    try {
      const internal = fixture.app as unknown as {
        state: SessionState;
        threadStore: ThreadStore;
      };
      internal.threadStore.appendEvent(internal.state.threadId, {
        turnId: "turn_cli_usage",
        type: "model.usage",
        phase: "completed",
        payload: {
          actor: "main_agent",
          purpose: "auto_route",
          provider: "qwen",
          model: internal.state.model,
          turnId: "turn_cli_usage",
          attempt: 1,
          retry: false,
          usage: {
            promptTokens: 120,
            completionTokens: 12,
            totalTokens: 132,
            cachedInputTokens: 20,
            reasoningTokens: 4,
          },
        },
      });
      internal.threadStore.appendEvent(internal.state.threadId, {
        turnId: "turn_cli_usage",
        type: "model.usage",
        phase: "completed",
        payload: {
          actor: "main_agent",
          purpose: "agent_step",
          provider: "qwen",
          model: internal.state.model,
          turnId: "turn_cli_usage",
          step: 1,
          retry: false,
        },
      });

      const offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/usage");
      const usage = JSON.parse(fixture.output().slice(offset)) as {
        threadId?: string;
        requests?: number;
        reportedRequests?: number;
        unreportedRequests?: number;
        totalTokens?: number;
        cachedInputTokens?: number;
        uncachedInputTokens?: number;
        reasoningTokens?: number;
        byPurpose?: { auto_route?: { totalTokens?: number } };
        note?: string;
      };
      assert.equal(usage.threadId, internal.state.threadId);
      assert.equal(usage.requests, 2);
      assert.equal(usage.reportedRequests, 1);
      assert.equal(usage.unreportedRequests, 1);
      assert.equal(usage.totalTokens, 132);
      assert.equal(usage.cachedInputTokens, 20);
      assert.equal(usage.uncachedInputTokens, 100);
      assert.equal(usage.reasoningTokens, 4);
      assert.equal(usage.byPurpose?.auto_route?.totalTokens, 132);
      assert.match(usage.note ?? "", /providers that omit usage/u);
      await assert.rejects(
        fixture.app.handleSlashCommand("/usage extra"),
        /Usage: \/usage/u,
      );
    } finally {
      fixture.close();
    }
  });
});

describe("thinking commands", () => {
  it("shows indexed thinking and invalidates old blocks when the thread changes", async () => {
    const fixture = await createAppFixture(
      { qwen: "configured-for-test" },
      {},
    );
    try {
      const firstId = fixture.terminal.addReasoning("First private reasoning block.");
      assert.equal(firstId, 1);
      await fixture.app.handleSlashCommand("/thinking");
      assert.match(fixture.output(), /▼ Thinking #1[\s\S]*First private reasoning block\./u);

      await assert.rejects(
        fixture.app.handleSlashCommand("/thinking 0"),
        /Usage: \/thinking \[id\|last\]/u,
      );
      await fixture.app.handleSlashCommand("/new");
      await fixture.app.handleSlashCommand(`/thinking ${firstId}`);
      assert.match(
        fixture.output(),
        /Thinking block #1 is not available in this thread\./u,
      );

      const secondId = fixture.terminal.addReasoning("Second thread reasoning.");
      assert.equal(secondId, 2);
      await fixture.app.handleSlashCommand("/thinking last");
      assert.match(fixture.output(), /▼ Thinking #2[\s\S]*Second thread reasoning\./u);
    } finally {
      fixture.close();
    }
  });
});

describe("thread leases", () => {
  it("restores paused children when a /new lease transition fails", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    const internals = fixture.app as unknown as {
      state: SessionState;
      threadStore: ThreadStore & {
        releaseThreadLease: (lease: { threadId: string }) => void;
      };
      subagentCoordinator: unknown;
    };
    const parentThreadId = internals.state.threadId;
    const assignment: Extract<
      SubagentAssignmentSnapshot,
      { kind: "standalone" }
    > = {
      kind: "standalone",
      agentId: "subagent_00000000-0000-4000-8000-000000000401",
      childThreadId: "thread_00000000-0000-4000-8000-000000000401",
      environmentId: "environment_00000000-0000-4000-8000-000000000401",
      taskId: "restore_after_failed_new",
      taskTitle: "Restore after failed new thread",
      taskDescription: "Continue the exact child after the parent switch fails.",
      completionChecks: ["The child is restored in the original parent"],
      provider: "qwen",
      model: internals.state.model,
      thinkingEffort: internals.state.thinkingEffort,
      requestedIsolation: "shared",
      createdAt: "2026-08-28T15:00:00.000Z",
    };
    internals.threadStore.appendEvent(parentThreadId, {
      type: "tool.result",
      turnId: "turn_restore_after_failed_new",
      phase: "completed",
      payload: {
        callId: "call_restore_after_failed_new",
        tool: "manage_subagents",
        message: {
          role: "tool",
          tool_call_id: "call_restore_after_failed_new",
          name: "manage_subagents",
          content: '{"ok":true}',
        },
        subagentAssignment: assignment,
        subagentLifecycle: { action: "activate", agentId: assignment.agentId },
      },
    });

    const originalCoordinator = internals.subagentCoordinator;
    const originalRelease = internals.threadStore.releaseThreadLease.bind(
      internals.threadStore,
    );
    let pauseCalls = 0;
    let discardCalls = 0;
    const restored: string[] = [];
    const activated: string[][] = [];
    const fakeCoordinator = {
      pause: async (threadId: string) => {
        assert.equal(threadId, parentThreadId);
        pauseCalls += 1;
      },
      discardPausedJobs: (threadId: string) => {
        assert.equal(threadId, parentThreadId);
        discardCalls += 1;
        return 1;
      },
      hasAgent: () => false,
      restore: (input: { assignment: SubagentAssignmentSnapshot }) => {
        restored.push(input.assignment.agentId);
      },
      restoreStandalone: () => {
        throw new Error("V2 binding should use restore");
      },
      rollbackRestored: () => undefined,
      activateRestored: (agentIds: readonly string[]) => {
        activated.push([...agentIds]);
      },
      hasOutstanding: () => false,
    };
    Object.defineProperty(fixture.app, "subagentCoordinator", {
      value: fakeCoordinator,
      configurable: true,
      writable: true,
    });
    let failedPreviousRelease = false;
    internals.threadStore.releaseThreadLease = (lease) => {
      if (lease.threadId === parentThreadId && !failedPreviousRelease) {
        failedPreviousRelease = true;
        throw new Error("injected previous lease release failure");
      }
      originalRelease(lease as never);
    };

    try {
      await assert.rejects(
        fixture.app.handleSlashCommand("/new"),
        /injected previous lease release failure/u,
      );
      assert.equal(internals.state.threadId, parentThreadId);
      assert.equal(pauseCalls, 1);
      assert.equal(discardCalls, 1);
      assert.deepEqual(restored, [assignment.agentId]);
      assert.deepEqual(activated, [[assignment.agentId]]);
    } finally {
      internals.threadStore.releaseThreadLease = originalRelease as never;
      Object.defineProperty(fixture.app, "subagentCoordinator", {
        value: originalCoordinator,
        configurable: true,
        writable: true,
      });
      fixture.close();
    }
  });

  it("transfers ownership for /new and /resume and releases it on close", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    const activeThread = (): string =>
      (fixture.app as unknown as { state: { threadId: string } }).state.threadId;
    const resetThreadIds: string[] = [];
    const resettableTerminal = fixture.terminal as unknown as {
      resetForNewThread: (session: { threadId: string }) => void;
    };
    const originalReset = resettableTerminal.resetForNewThread.bind(fixture.terminal);
    resettableTerminal.resetForNewThread = (session) => {
      resetThreadIds.push(session.threadId);
      originalReset(session);
    };
    try {
      const firstThreadId = activeThread();
      await fixture.app.handleSlashCommand("/new");
      const secondThreadId = activeThread();
      assert.notEqual(secondThreadId, firstThreadId);
      assert.deepEqual(resetThreadIds, [secondThreadId]);

      const probeStorage = createStorage(fixture.dataDir);
      try {
        const probeThreads = new ThreadStore(probeStorage);
        const releasedFirst = probeThreads.acquireThreadLease(firstThreadId);
        probeThreads.releaseThreadLease(releasedFirst);
        assert.throws(
          () => probeThreads.acquireThreadLease(secondThreadId),
          /already active/u,
        );
      } finally {
        probeStorage.close();
      }

      await fixture.app.handleSlashCommand(`/resume ${firstThreadId}`);
      assert.equal(activeThread(), firstThreadId);
      assert.deepEqual(resetThreadIds, [secondThreadId]);
      const transferredStorage = createStorage(fixture.dataDir);
      try {
        const transferredThreads = new ThreadStore(transferredStorage);
        const releasedSecond = transferredThreads.acquireThreadLease(secondThreadId);
        transferredThreads.releaseThreadLease(releasedSecond);
        assert.throws(
          () => transferredThreads.acquireThreadLease(firstThreadId),
          /already active/u,
        );
      } finally {
        transferredStorage.close();
      }

      fixture.app.close();
      const closedStorage = createStorage(fixture.dataDir);
      try {
        const closedThreads = new ThreadStore(closedStorage);
        const releasedOnClose = closedThreads.acquireThreadLease(firstThreadId);
        closedThreads.releaseThreadLease(releasedOnClose);
      } finally {
        closedStorage.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("acquires before interrupted-turn repair and releases after create failure", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    const setupStorage = createStorage(fixture.dataDir);
    try {
      const threads = new ThreadStore(setupStorage);
      const canonicalWorkspace = (
        fixture.app as unknown as { workspace: { root: string } }
      ).workspace.root;
      const target = threads.create({
        threadId: "thread_app_lease_target",
        workspaceRoot: canonicalWorkspace,
        mode: "auto",
        provider: "qwen",
        model: "qwen3-vl-plus",
      });
      threads.startTurn(target.threadId, "unfinished request", "turn_unfinished");
      const blocker = threads.acquireThreadLease(target.threadId);

      await assert.rejects(
        EasyCodeApp.create({
          workspaceRoot: fixture.workspace,
          resumeThreadId: target.threadId,
          terminal: new Terminal(new PassThrough(), new PassThrough()),
          credentialStore: false,
        }),
        /already active/u,
      );
      assert.equal(threads.recover(target.threadId).activeTurnId, "turn_unfinished");
      threads.releaseThreadLease(blocker);

      await assert.rejects(
        EasyCodeApp.create({
          workspaceRoot: fixture.workspace,
          resumeThreadId: target.threadId,
          imagePaths: [path.join(fixture.workspace, "missing-image.png")],
          terminal: new Terminal(new PassThrough(), new PassThrough()),
          credentialStore: false,
        }),
        /does not exist|not found|no such file/iu,
      );
      const releasedAfterFailure = threads.acquireThreadLease(target.threadId);
      threads.releaseThreadLease(releasedAfterFailure);
    } finally {
      setupStorage.close();
      fixture.close();
    }
  });
});
