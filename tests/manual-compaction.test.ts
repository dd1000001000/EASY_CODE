import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import type { ChatMessage, EventRecord } from "../src/core/types.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { ContextManager, shortTermMessages } from "../src/context/manager.js";
import { runManualCompaction, manualSummaryContext } from "../src/context/manual-compaction.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import { projectWebHistory } from "../src/web-server/history.js";
import { WebInteraction } from "../src/web-server/interaction.js";
import { recallCompactionEvidence } from "../src/context/semantic-compaction.js";
import { compactionRunning, type CompactionProgress } from "../src/ui/compaction.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { ProviderError } from "../src/providers/errors.js";
import { snapshotToolSet } from "./tool-set.js";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "easy-code-manual-compact-"));
  const storage = createStorage(directory);
  const store = new ThreadStore(storage);
  let state = store.create({
    threadId: "manual",
    workspaceRoot: directory,
    mode: "code",
    provider: "deepseek",
    model: "test",
    thinkingEffort: "high",
  });
  const message = (m: ChatMessage) => {
    store.appendEvent(state.threadId, {
      type: m.role === "user" ? "message.user" : m.role === "tool" ? "tool.result" : "message.assistant",
      turnId: "prior",
      payload:
        m.role === "user"
          ? { message: m }
          : m.role === "tool"
            ? { callId: m.tool_call_id, tool: m.name, message: m }
            : m,
    });
  };
  message({ role: "user", content: "Fix parser without changing the public API." });
  message({
    role: "assistant",
    content: "Investigating parser failure",
    reasoning_content: "PRIVATE_REASONING ".repeat(3000),
    tool_calls: [{ id: "read", type: "function", function: { name: "read_file", arguments: "{}" } }],
  });
  message({
    role: "tool",
    tool_call_id: "read",
    name: "read_file",
    content: "Important evidence: parser fails on CRLF.\n" + "source line\n".repeat(4000),
  });
  message({ role: "assistant", content: "CRLF handling still needs a fix and verification." });
  state = store.recover(state.threadId);
  const manager = new ContextManager();
  manager.configureTokenBudget(200_000, DEFAULT_RUNTIME_LIMITS);
  const append = async (event: Omit<EventRecord, "schemaVersion" | "sequence" | "timestamp" | "eventId">) => {
    const { threadId, ...record } = event;
    store.appendEvent(threadId, record);
  };
  const progress: CompactionProgress[] = [];
  const run = (overrides: Partial<Parameters<typeof runManualCompaction>[0]> = {}) =>
    runManualCompaction({
      state,
      manager,
      maxContextChars: 800_000,
      nextRequest: { systemPrompt: "Rules", runtimeContext: "Workspace", tools: [] },
      append,
      onProgress: (value) => progress.push(value),
      complete: async () => ({
        role: "assistant",
        content:
          "<summary>Fix CRLF parsing without changing the public API. Read journal_message_2 for evidence. Implementation and tests remain pending.</summary>",
        reasoning_content: "NEW_PRIVATE_THOUGHT",
      }),
      ...overrides,
    });
  return {
    state,
    manager,
    store,
    run,
    progress,
    append,
    dispose() {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("manual deep compaction", () => {
  it("does not reset or shrink source history when the provider rejects summary capacity", async () => {
    const f = fixture();
    let calls = 0;
    try {
      const runtime = new AgentRuntime({
        provider: {
          name: "deepseek",
          model: "test",
          complete: async () => {
            calls++;
            throw new ProviderError("context_length_exceeded", {
              provider: "deepseek",
              code: "context_length_exceeded",
              retryable: false,
            });
          },
        },
        contextManager: f.manager,
        toolCatalog: snapshotToolSet([]),
        buildSystemPrompt: async () => "Rules",
        getWorkspaceSummary: async () => "Workspace",
        appendEvent: f.append,
        limits: { ...DEFAULT_RUNTIME_LIMITS, maxProviderRetries: 0 },
      } as unknown as ConstructorParameters<typeof AgentRuntime>[0]);
      const result = await runtime.compactSession(f.state, { maxContextChars: 800_000 });
      assert.equal(result.phase, "failed");
      assert.equal(calls, 1);
      assert.equal(f.state.compactedMessageCount, 0);
      assert.ok(
        !f.store
          .journal(f.state.threadId)
          .read()
          .some((e) => e.type === "context.server_reset"),
      );
    } finally {
      f.dispose();
    }
  });
  it("compacts below automatic thresholds, references recent tools, excludes thinking and replays the full boundary", async () => {
    const f = fixture();
    try {
      const raw = JSON.stringify(f.state.messages);
      const source = JSON.stringify(manualSummaryContext(f.state));
      assert.doesNotMatch(source, /PRIVATE_REASONING/);
      assert.match(source, /Important evidence/);
      assert.match(source, /omitted; not verified/);
      let calls = 0;
      const result = await f.run({
        complete: async (messages) => {
          calls++;
          assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_REASONING/);
          assert.match(JSON.stringify(messages), /Important evidence/);
          return {
            role: "assistant",
            content:
              "<summary>Fix CRLF parsing; public API must not change. Evidence: journal_message_2. Implementation and tests are pending.</summary>",
            reasoning_content: "NEW_PRIVATE_THOUGHT",
          };
        },
      });
      assert.equal(result.phase, "completed");
      assert.equal(result.outcome, "compacted");
      assert.equal(result.referencedOutputs, 1);
      assert.equal(calls, 1);
      assert.ok(result.afterChars! < result.beforeChars / 4);
      assert.equal(f.state.compactedMessageCount, f.state.messages.length);
      assert.equal(JSON.stringify(f.state.messages), raw);
      assert.doesNotMatch(
        JSON.stringify(shortTermMessages(f.state)),
        /PRIVATE_REASONING|NEW_PRIVATE_THOUGHT|source line/,
      );
      const recovered = f.store.recover(f.state.threadId);
      assert.equal(recovered.workingSummary, f.state.workingSummary);
      assert.equal(recovered.compactedMessageCount, recovered.messages.length);
      assert.match(
        JSON.stringify(
          recallCompactionEvidence(
            recovered,
            JSON.stringify({ action: "recall", evidenceId: "journal_message_2", offset: 0, limit: 200 }),
          ),
        ),
        /Important evidence/,
      );
      const again = await f.run({
        complete: async () => {
          throw new Error("Must not call provider twice");
        },
      });
      assert.equal(again.outcome, "unchanged");
    } finally {
      f.dispose();
    }
  });

  it("retains successful references but never evicts history when the model fails", async () => {
    const f = fixture();
    try {
      const result = await f.run({
        complete: async () => {
          throw new Error("provider offline");
        },
      });
      assert.equal(result.phase, "failed");
      assert.equal(result.outcome, "references_only");
      assert.equal(f.state.compactedMessageCount, 0);
      assert.equal(f.state.workingSummary, "");
      assert.equal(f.state.compactionControl.transaction?.status, "superseded");
      assert.deepEqual(f.store.recover(f.state.threadId).pressureRecovery?.toolReferences, [2]);
      assert.ok(
        !f.store
          .journal(f.state.threadId)
          .read()
          .some((e) => e.type === "context.server_reset"),
      );
    } finally {
      f.dispose();
    }
  });

  it("cancels an in-flight summary without committing even if the provider returns text", async () => {
    const f = fixture();
    const controller = new AbortController();
    try {
      const result = await f.run({
        signal: controller.signal,
        complete: async () => {
          controller.abort();
          return { role: "assistant", content: "<summary>Do not commit this</summary>" };
        },
      });
      assert.equal(result.phase, "cancelled");
      assert.equal(f.state.compactedMessageCount, 0);
      assert.equal(f.store.recover(f.state.threadId).workingSummary, "");
    } finally {
      f.dispose();
    }
  });

  it("rejects thinking-only or oversized responses after a bounded correction", async () => {
    for (const content of [null, `<summary>${"very long ".repeat(15000)}</summary>`]) {
      const f = fixture();
      let calls = 0;
      try {
        const result = await f.run({
          complete: async () => {
            calls++;
            return { role: "assistant", content, reasoning_content: "do not salvage this" };
          },
        });
        assert.equal(calls, 2);
        assert.equal(result.phase, "failed");
        assert.equal(f.state.compactedMessageCount, 0);
        assert.equal(f.state.workingSummary, "");
      } finally {
        f.dispose();
      }
    }
  });

  it("refuses incomplete tool exchanges before any provider call or projection change", async () => {
    const f = fixture();
    try {
      f.state.messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "pending", type: "function", function: { name: "read_file", arguments: "{}" } }],
      });
      await assert.rejects(f.run(), /all tool results/);
      assert.equal(f.progress.length, 0);
      assert.equal(f.state.pressureRecovery?.toolReferences.length ?? 0, 0);
    } finally {
      f.dispose();
    }
  });

  it("restores results and interrupted operations without keeping the Web composer locked", async () => {
    const f = fixture();
    try {
      const result = await f.run();
      const events = f.store.journal(f.state.threadId).read();
      const history = projectWebHistory(events);
      const entries = history.filter((e) => e.compaction);
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0]!.compaction, result);
      const port = new WebInteraction();
      port.loadHistory(history);
      assert.deepEqual(port.snapshot().view.compaction, result);
      const start = events.find((e) => e.type === "context.manual.started")!;
      const interrupted = projectWebHistory([start]);
      assert.equal(interrupted[0]?.compaction?.phase, "cancelled");
      assert.equal(compactionRunning(interrupted[0]?.compaction), false);
    } finally {
      f.dispose();
    }
  });
});
