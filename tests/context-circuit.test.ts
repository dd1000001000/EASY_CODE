import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { extractSummaryEnvelope, foldSummaryRecovery, requestSummaryWithCorrections, SUMMARY_INSTRUCTIONS,
  type SummaryRecoveryState, type SummaryRecoveryEvent } from "../src/context/summary-output.js";
import { ProviderError } from "../src/providers/errors.js";
import { TaskBudgetExceeded } from "../src/runtime/task-budget.js";
import { ContextManager, shortTermMessages } from "../src/context/manager.js";
import { resetServerContext, capacityResetUsed } from "../src/context/server-reset.js";
import { recordUserRequirement } from "../src/context/user-requirements.js";
import { runCompactionTransaction } from "../src/context/compaction-transaction.js";
import { completeWithApiRetries } from "../src/runtime/model-retry.js";
import { foldReconciliation, reconciliationGate, reconciliationObservation, reconciliationPending } from "../src/context/reconciliation.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { benchmarkResultControls } from "../src/sandbox/benchmark-result.js";
import type { SessionState } from "../src/core/types.js";

function state(): SessionState {
  return { threadId: "circuit", workspaceRoot: process.cwd(), mode: "code", provider: "glm", model: "test", thinkingEffort: "none",
    messages: [{ role: "user", content: "Original request. Preserve compatibility." }], userMessageIndices: [0], constraints: [],
    filesRead: new Map(), changes: [], commands: [], commandApprovalPrefixes: [], workingSummary: "", compactedMessageCount: 0,
    createdAt: "now", updatedAt: "now" };
}
function durable(saved: SummaryRecoveryState = { attempts: 0 }) {
  const events: SummaryRecoveryEvent[] = [];
  return { events, get: () => saved, append: async (e: SummaryRecoveryEvent) => { events.push(e); foldSummaryRecovery(saved, e); } };
}
describe("durable auxiliary summary recovery", () => {
  it("uses tool-free XML instructions and ignores inline/code/scratch example tags", () => {
    assert.doesNotMatch(SUMMARY_INSTRUCTIONS, /compact_context/);
    assert.equal(extractSummaryEnvelope('Example `<summary>not final</summary>`\n<analysis>draft <summary>example</summary></analysis>\n<summary>actual</summary>\nDone'), "actual");
    assert.equal(extractSummaryEnvelope("<summary>one</summary><summary>two</summary>"), undefined);
  });
  it("retains the last nonempty body when a correction API fails, without counting a third content failure", async () => {
    const d = durable(); let calls = 0;
    const result = await requestSummaryWithCorrections(async () => {
      if (++calls === 1) return "unfinished raw handoff";
      throw new ProviderError("busy", { provider: "glm", code: "503", retryable: true });
    }, defaultRuntimeLimits(), d);
    assert.deepEqual(result, { text: "unfinished raw handoff", raw: true, attempts: 2 });
    assert.equal(calls, 2);
    const replay = durable(structuredClone(d.get()));
    assert.deepEqual(await requestSummaryWithCorrections(async () => { throw new Error("No dispatch"); }, defaultRuntimeLimits(), replay), result);
  });
  it("does not resend an unknown correction after a crash or lose an earlier body to an empty response", async () => {
    const d = durable();
    await d.append({ type: "attempt", attempt: 1 });
    await d.append({ type: "candidate", attempt: 1, body: "raw retained" });
    await d.append({ type: "attempt", attempt: 2 });
    await d.append({ type: "candidate", attempt: 2, body: "" });
    await d.append({ type: "attempt", attempt: 3 });
    const result = await requestSummaryWithCorrections(async () => { throw new Error("Do not replay unknown request"); }, defaultRuntimeLimits(), d);
    assert.equal(result.text, "raw retained"); assert.equal(result.attempts, 3); assert.equal(result.raw, true);
  });
  it("never salvages authentication, budget, cancellation or journal failure as invalid content", async () => {
    for (const error of [new Error("journal write failed"), new TaskBudgetExceeded("limit"),
      new ProviderError("invalid key", { provider: "glm", code: "401", statusCode: 401 }),
      new DOMException("canceled", "AbortError")]) {
      const d = durable(); let calls = 0;
      await assert.rejects(requestSummaryWithCorrections(async () => { calls++; throw error; }, defaultRuntimeLimits(), d), e => e === error);
      assert.equal(calls, 1); assert.equal(d.get().result, undefined);
    }
    const d = durable();
    await assert.rejects(requestSummaryWithCorrections(async () => "<summary>good</summary>", defaultRuntimeLimits(), {
      ...d, append: async event => { if (event.type === "candidate") throw new Error("journal failed"); await d.append(event); },
    }), /journal failed/);
    assert.equal(d.get().attempts, 1); assert.equal(d.get().result, undefined);
  });
  it("normal extraction discards scratch before persisting a summary", async () => {
    const d = durable();
    const result = await requestSummaryWithCorrections(async () => "<analysis>PRIVATE SCRATCH</analysis><summary>formal</summary>", defaultRuntimeLimits(), d);
    assert.equal(result.text, "formal"); assert.doesNotMatch(JSON.stringify(d.events), /PRIVATE SCRATCH/);
  });
});

describe("requirements-only circuit breaker", () => {
  it("shares one local/remote reset across Resume and keeps journal-backed requirements, not synthetic user-role text", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "easy-code-circuit-"));
    const storage = createStorage(dir); const store = new ThreadStore(storage);
    try {
      const created = store.create({ workspaceRoot: dir, mode: "code", provider: "glm", model: "mock", thinkingEffort: "none" });
      for (const content of ["Original task", "RUNTIME_ is literally a required user prefix", "Also preserve compatibility"]) {
        store.appendEvent(created.threadId, { type: "message.user", turnId: "turn", payload: { content } });
      }
      store.appendEvent(created.threadId, { type: "message.user.synthetic", payload: { role: "user", content: "Unprefixed synthetic history is not a requirement" } });
      store.recordMessage(created.threadId, { role: "assistant", content: "OLD EVIDENCE", reasoning_content: "x".repeat(100000) });
      const s = store.recover(created.threadId), manager = new ContextManager();
      const result = await runCompactionTransaction({ state: s, manager, turnId: "first", required: true, maxContextChars: 12000,
        maxRequests: 0, limits: { ...defaultRuntimeLimits(), contextMaxRebasesPerRequest: 0 }, nextRequest: { systemPrompt: "rules", tools: [], runtimeContext: "OLD RAG" },
        complete: async () => { throw new Error("No model call"); }, append: async e => store.appendEvent(s.threadId, e) });
      assert.equal(result.paused, undefined); assert.equal(result.committed, true); assert.equal(capacityResetUsed(s), true);
      assert.equal(shortTermMessages(s).length, 3);
      const request = manager.build({ state: s, maxContextChars: 12000, systemPrompt: "rules", runtimeContext: "OLD RAG" });
      assert.doesNotMatch(JSON.stringify(request), /OLD RAG|OLD EVIDENCE|Unprefixed synthetic/);
      assert.match(JSON.stringify(request), /RUNTIME_ is literally/);
      store.save(s); const resumed = store.recover(s.threadId);
      await assert.rejects(resetServerContext(resumed, "different_turn_id", async e => store.appendEvent(s.threadId, e)), /already consumed/);
      assert.deepEqual(resumed.pressureRecovery, s.pressureRecovery);
    } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("does not reset allowance when the same user requirement is repeated", async () => {
    const s = state(); await resetServerContext(s, "one", async () => {});
    s.messages.push({ ...s.messages[0]! }); recordUserRequirement(s, 1);
    assert.equal(capacityResetUsed(s), true);
  });
  it("requires workspace and original operation observations before a mutation, not just a prompt", async () => {
    const s = state(); s.contextOperations = { commands: { cmd: { commandId: "cmd", program: "python", args: ["test.py"], cwd: ".", status: "running", exitCode: null } },
      children: { child: { assignment: { agentId: "child", kind: "standalone", taskId: "task", taskTitle: "task", taskDescription: "task", completionChecks: [] }, followUps: [] } } };
    await resetServerContext(s, "one", async () => {});
    assert.equal(reconciliationGate(s, "run_command", {})?.failure?.execution, "not_started");
    assert.equal(reconciliationGate(s, "update_file", {})?.failure?.recovery, "inspect_state");
    assert.equal(reconciliationGate(s, "poll_command", { commandId: "cmd" }), undefined);
    assert.ok(reconciliationGate(s, "poll_command", { commandId: "other" }));
    foldReconciliation(s, "read_file", reconciliationObservation(s, "read_file", { ok: true, summary: "read" }));
    assert.equal(reconciliationPending(s), true);
    foldReconciliation(s, "poll_command", { command: "cmd" });
    foldReconciliation(s, "manage_subagents", { children: ["child"] });
    assert.equal(reconciliationPending(s), false); assert.equal(reconciliationGate(s, "run_command", {}), undefined);
    assert.equal(s.contextOperations.commands.cmd?.status, "running"); // querying never manufactures completion
  });
  it("does not resend an already minimal identical rejected request", async () => {
    let calls = 0;
    await assert.rejects(completeWithApiRetries({ name: "glm", model: "test", complete: async () => {
      calls++; throw new ProviderError("maximum context length exceeded", { provider: "glm", code: "context_length_exceeded", statusCode: 400 });
    } }, { messages: [{ role: "user", content: "task" }] }, { resetContext: async r => r }), /context length/);
    assert.equal(calls, 1);
  });
});

describe("benchmark execution and cleanup are independent", () => {
  it("does not quarantine output limits when worker restoration is confirmed", () => {
    assert.deepEqual(benchmarkResultControls({ version: 2, exitCode: 137, outcome: "output_limit", cleanup: "confirmed", workerRestored: true,
      executionError: "32 MiB output" }), [{ type: "execution_exited", exitCode: 137, outcome: "output_limit" }, { type: "cleanup_complete" }]);
  });
  it("never infers cleanup or worker restoration from an exit code", () => {
    for (const cleanup of ["failed", "unknown", "confirmed"]) assert.equal(benchmarkResultControls({ version: 2, exitCode: 0,
      outcome: "exited", cleanup, workerRestored: false })[1]?.type, "cleanup_error");
    assert.throws(() => benchmarkResultControls({ exitCode: 0 }));
  });
});
