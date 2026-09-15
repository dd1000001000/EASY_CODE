import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import type { ChatMessage, ModelRequest, SessionState } from "../src/core/types.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { TaskBudget } from "../src/runtime/task-budget.js";
import { createReviewDriver, type ReviewParticipant } from "../src/review/driver.js";
import { foldReviewEvent, type ReviewEvent } from "../src/review/session.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { createReviewCopies, restoreReviewCopies, reviewFingerprint } from "../src/review/workspace.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { EvidenceStore } from "../src/context/evidence-store.js";
import { createId } from "../src/utils/ids.js";
import { createMainReviewBrief, runWorkspaceReview } from "../src/review/application.js";
import type { MemoryManager } from "../src/memory/memory-manager.js";
import type { ContextArtifactIndex } from "../src/context/artifact-index.js";
import { baseSessionState } from "./session-state.js";

function state(threadId: string): SessionState { return { ...baseSessionState(), threadId, workspaceRoot: process.cwd(),
  mode: "code", provider: "glm", model: "mock", thinkingEffort: "none", messages: [], constraints: [],
  filesRead: new Map(), changes: [], commands: [], commandApprovalPrefixes: [], workingSummary: "",
  compactedMessageCount: 0, createdAt: "now", updatedAt: "now" }; }

describe("one-way review runtime", () => {
  it("folds one durable report, without author turns, rounds, or reviewer-specific ceilings", () => {
    const main = state("main");
    const emit = (event: ReviewEvent) => foldReviewEvent(main, event);
    emit({ type: "started", id: "r", key: "k", scope: "task", purpose: "delivery", snapshotId: "snap",
      requirementRevision: "req", reviewerThreadId: "private" });
    emit({ type: "brief_ready", id: "r", text: "Fallible handoff" });
    emit({ type: "review_started", id: "r" });
    for (let index = 0; index < 250; index++) emit({ type: "tool", id: "r" });
    emit({ type: "reported", id: "r", report: { verdict: "revise", conclusion: "Not yet proven", nextAction: "Check the edge case",
      evidenceRefs: [], uncertainties: ["One branch unknown"] } });
    emit({ type: "applied", id: "r", fresh: true });
    assert.equal(main.reviewSessions[0]!.tools, 250);
    assert.equal(main.reviewSessions[0]!.status, "applied");
    assert.equal(main.messages.length, 1);
    assert.match(main.messages[0]!.content ?? "", /RUNTIME_REVIEW_ADVICE/);
    assert.doesNotMatch(main.messages[0]!.content ?? "", /consensus|AUTHOR_SUMMARY/u);
    assert.throws(() => emit({ type: "applied", id: "r", fresh: true }), /already applied/);
  });

  it("persists report and injection exactly once across journal recovery", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-review-journal-"));
    const storage = createStorage(path.join(directory, "data"));
    try {
      const store = new ThreadStore(storage);
      const initial = store.create({ threadId: "main", workspaceRoot: directory, mode: "code", provider: "glm",
        model: "mock", thinkingEffort: "none" });
      const emit = (payload: ReviewEvent) => store.appendEvent(initial.threadId, { type: "review.assignment.event", payload });
      emit({ type: "started", id: "r", key: "k", scope: "task", purpose: "delivery", snapshotId: "snap",
        requirementRevision: "req", reviewerThreadId: "private" });
      emit({ type: "brief_ready", id: "r", text: "Fallible handoff" });
      emit({ type: "review_started", id: "r" });
      emit({ type: "reported", id: "r", report: { verdict: "revise", conclusion: "Review finding", nextAction: "Inspect branch",
        evidenceRefs: [], uncertainties: [] } });
      emit({ type: "applied", id: "r", fresh: true });
      const recovered = store.recover(initial.threadId);
      assert.equal(recovered.reviewSessions[0]!.status, "applied");
      assert.equal(recovered.messages.filter(message => message.content?.includes("RUNTIME_REVIEW_ADVICE")).length, 1);
      assert.throws(() => emit({ type: "applied", id: "r", fresh: true }), /already applied/);
    } finally { storage.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("creates only the reviewer snapshot and restores its immutable binding", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-review-copy-"));
    let copied: string | undefined;
    try {
      await writeFile(path.join(directory, "module.py"), "value = 1\n");
      const workspace = await WorkspaceManager.create(directory);
      const id = createId("review"), fingerprint = reviewFingerprint(await workspace.captureSnapshot());
      const copy = await createReviewCopies(workspace, id, fingerprint, 100000);
      copied = copy.directory;
      assert.equal(await readFile(path.join(copy.root, "module.py"), "utf8"), "value = 1\n");
      await assert.rejects(() => lstat(path.join(copy.directory, "author")), { code: "ENOENT" });
      assert.equal((await restoreReviewCopies(copy.directory, id, fingerprint)).root, copy.root);
      await assert.rejects(() => restoreReviewCopies(copy.directory, id, "wrong"), /binding mismatch/u);
    } finally { if (copied) await rm(copied, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true }); }
  });

  it("lets the reviewer read independently and send one report using the shared budget", async () => {
    const main = state("main"), reviewer = state("private");
    foldReviewEvent(main, { type: "started", id: "r", key: "k", scope: "task", purpose: "delivery", snapshotId: "snap",
      requirementRevision: "req", reviewerThreadId: "private" });
    foldReviewEvent(main, { type: "brief_ready", id: "r", text: "Fallible handoff" });
    foldReviewEvent(main, { type: "review_started", id: "r" });
    reviewer.messages.push({ role: "user", content: "Read the project yourself" });
    const id = "evidence_" + "a".repeat(64), records: ChatMessage[] = [];
    const participant: ReviewParticipant = { state: reviewer,
      tools: [{ name: "read_file", mutating: false, definition: { type: "function", function: {
        name: "read_file", description: "Read a file", parameters: { type: "object" } } },
        execute: async () => ({ ok: true, summary: "Actual source read", data: { content: "value = 1" } }) }],
      context: { workspaceRoot: process.cwd(), threadId: "private", turnId: "r", mode: "code", agentRole: "subagent",
        approvalPolicy: "ask", commandExecutionMode: "auto_approve", commandTimeoutMs: 1000, maxOutputChars: 8000,
        requestApproval: async () => false, recallContext: async () => ({ ok: true, summary: "captured" }) },
      append: async (type, payload) => { if (type === "message") records.push(payload as ChatMessage); },
      capture: () => id, unchanged: async () => true,
    };
    let calls = 0;
    const budget = new TaskBudget(10, 0);
    const driver = createReviewDriver({ participant, provider: { name: "glm", model: "mock",
      complete: async () => ({ message: { role: "assistant", content: "",
        tool_calls: [{ id: `call_${++calls}`, type: "function", function: { name: calls === 1 ? "read_file" : "submit_review_result",
          arguments: calls === 1 ? JSON.stringify({ path: "module.py" }) : JSON.stringify({ verdict: "revise", conclusion: "Fix branch",
            nextAction: "Test it", evidenceRefs: [id], uncertainties: [] }) } }] } }) }, budget,
      limits: defaultRuntimeLimits(), get: () => main.reviewSessions[0]!,
      emit: async event => foldReviewEvent(main, event), usage: async () => {} });
    const report = await driver.investigate();
    assert.equal(report.conclusion, "Fix branch");
    assert.deepEqual(report.evidenceRefs, [id]);
    assert.equal(main.reviewSessions[0]!.requests, 2);
    assert.equal(budget.snapshot().requests, 2);
    assert.equal(records.filter(message => message.role === "tool").length, 2);
  });

  it("starts one private reviewer, sends no diff/source listing, and reuses the result", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-review-app-"));
    const root = path.join(directory, "workspace"); await mkdir(root);
    await writeFile(path.join(root, "module.py"), "SECRET_SOURCE = 1\n");
    const storage = createStorage(path.join(directory, "data")), store = new ThreadStore(storage);
    const main = store.create({ threadId: "main", workspaceRoot: root, mode: "code", provider: "glm", model: "mock",
      thinkingEffort: "none" });
    main.workingSummary = "Investigating a boundary.\n```python\nSECRET_SOURCE = 1\n```";
    const request = { state: main, turnId: "turn", userInput: "Fix the module", purpose: "delivery" as const,
      draftAnswer: "Implementation complete; UI behavior remains unverified.", remainingModelRequests: 12 };
    const brief = createMainReviewBrief(main, request);
    assert.doesNotMatch(brief, /SECRET_SOURCE/);
    let calls = 0;
    const deps = { workspace: await WorkspaceManager.create(root), store,
      memory: { evidenceStore: new EvidenceStore(storage), searchHybrid: async () => [] } as unknown as MemoryManager,
      index: { checkpoint: async () => {}, search: async () => [] } as unknown as ContextArtifactIndex,
      provider: { name: "glm", model: "mock", complete: async (value: ModelRequest) => {
        calls++;
        assert.ok(value.tools?.some(tool => tool.function.name === "submit_review_result"));
        return { message: { role: "assistant" as const, content: "", tool_calls: [{ id: "report", type: "function" as const,
          function: { name: "submit_review_result", arguments: JSON.stringify({ verdict: "revise", conclusion: "Need an edge-case test",
            nextAction: "Inspect branch", evidenceRefs: [], uncertainties: [] }) } }] } };
      } }, budget: new TaskBudget(12, 0), limits: defaultRuntimeLimits(), sensitivePaths: [path.join(directory, "data")],
      lifecycleDirectory: path.join(directory, "leases"), offline: false, approve: async () => false, status: () => {} };
    try {
      const first = await runWorkspaceReview(request, deps);
      assert.equal(first.decision, "reported"); assert.equal(first.requests, 1);
      const session = main.reviewSessions[0]!;
      assert.equal(session.status, "applied");
      const opening = store.recover(session.reviewerThreadId).messages.find(message => message.role === "user")!.content;
      assert.doesNotMatch(opening, /SECRET_SOURCE|Changed paths|Full immutable diff/u);
      assert.match(opening, /Main-Agent delivery draft/u);
      assert.match(opening, /UI behavior remains unverified/u);
      assert.equal(main.messages.filter(message => message.content?.startsWith("RUNTIME_REVIEW_ADVICE")).length, 1);
      const second = await runWorkspaceReview(request, deps);
      assert.equal(second.reused, true); assert.equal(calls, 1);
      const revised = await runWorkspaceReview({ ...request, draftAnswer: "Revised answer with the same requirement." }, deps);
      assert.equal(revised.reused, true, "a revised answer must not start a second reviewer");
      assert.equal(calls, 1);
    } finally {
      for (const session of main.reviewSessions) if (session.directory) await rm(session.directory, { recursive: true, force: true });
      storage.close(); await rm(directory, { recursive: true, force: true });
    }
  });
});
