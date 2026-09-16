import path from "node:path";
import { readFile } from "node:fs/promises";
import { recordUserRequirement } from "../context/user-requirements.js";
import type { ModelProvider, SessionState, ToolContext, ChatMessage, EventRecord } from "../core/types.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import type { ThreadStore } from "../threads/thread-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { ContextArtifactIndex } from "../context/artifact-index.js";
import type { TaskBudget } from "../runtime/task-budget.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { CommandRuntime } from "../command/runtime.js";
import { NativeSandboxBackend } from "../sandbox/native-backend.js";
import { BenchmarkContainerBackend } from "../sandbox/benchmark-backend.js";
import { BuiltinToolSource } from "../tools/builtin-source.js";
import { ToolCatalog } from "../tools/catalog.js";
import { recallThreadContext } from "../context/recall.js";
import { recoveryScope } from "../context/capacity.js";
import { memoryQueries, selectMemoryContext, optionalMemoryTokenBudget } from "../context/memory-controller.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { unresolvedCommands } from "../context/runtime-state.js";
import { ReviewFatalError, ReviewCleanupError, durableReviewWrite } from "./errors.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hash.js";
import { createReviewCopies, restoreReviewCopies, reviewFingerprint } from "./workspace.js";
import { foldReviewEvent, type ReviewEvent, type ReviewReport, type ReviewSession } from "./session.js";
import type { UIReviewPhase } from "../ui/contracts.js";
import { createReviewDriver, type ReviewParticipant } from "./driver.js";

export interface WorkspaceReviewRequest {
  state: SessionState; turnId: string; userInput: string;
  incidentId?: string; remainingModelRequests: number; signal?: AbortSignal;
  maxContextTokens?: number;
}
export interface WorkspaceReviewResult {
  decision: "reported" | "inconclusive" | "unavailable" | "interrupted";
  requests: number; reused: boolean; reason?: string; report?: ReviewReport;
}
export interface WorkspaceReviewDependencies {
  workspace: WorkspaceManager; store: ThreadStore; memory: MemoryManager; index: ContextArtifactIndex;
  provider: ModelProvider; budget: TaskBudget; limits: Readonly<RuntimeLimits>;
  sensitivePaths: string[]; dataDir?: string; lifecycleDirectory: string; offline: boolean;
  approve(context: ToolContext, request: import("../core/types.js").ApprovalRequest): Promise<boolean>;
  status(text: string): void;
  onProgress?: (progress: Readonly<{ phase: UIReviewPhase }>) => void;
}

function bounded(value: string, max: number): string {
  const safe = redactSensitiveInformation(value);
  return safe.length <= max ? safe : safe.slice(0, max) + `\n[Brief excerpt ends; reviewer must inspect independently.]`;
}

/** No model request, source text, diff, or list of changed files is copied into the reviewer prompt. */
export function createMainReviewBrief(state: Readonly<SessionState>, input: WorkspaceReviewRequest): string {
  const failures = unresolvedCommands(state).slice(-4).map(command => ({
    status: command.status, exitCode: command.exitCode, verificationKind: command.verificationKind,
    summary: bounded(command.summary ?? "", 450),
  }));
  const incident = input.incidentId && state.progressGuard?.incidents.find(item => item.incidentId === input.incidentId);
  // A working summary is a fallible model narrative. Strip code blocks and
  // dense source-shaped lines; the reviewer reads the actual files itself.
  const narrative = (state.workingSummary ?? "").replace(/```[\s\S]*?```/gu, "[code omitted]")
    .split("\n").filter(line => line.length <= 320 && !/^\s*(?:\+|-|@@|\d+\s*\|)/u.test(line))
    .join("\n");
  return bounded(JSON.stringify({ mainAgentSummary: bounded(narrative, 5500),
    changedFileCount: state.changes.length,
    repeatedFailure: incident ? { reason: incident.reason, outcomeKey: incident.outcomeKey } : undefined,
    unresolvedVerification: failures,
    instruction: "This is the main Agent's fallible handoff, not a finding. Independently read the workspace and report one concrete conclusion/next direction." }), 15000);
}

/** The app holds its workspace mutation lease for this entire call. */
export async function runWorkspaceReview(input: WorkspaceReviewRequest, deps: WorkspaceReviewDependencies): Promise<WorkspaceReviewResult> {
  const before = input.state.reviewSessions.reduce((total, session) => total + session.requests, 0);
  try { return await runWorkspaceReviewAttempt(input, deps); }
  catch (error) {
    if (error instanceof ReviewFatalError) throw error;
    const reason = bounded(String(error), 1800);
    durableReviewWrite(() => deps.store.appendEvent(input.state.threadId, { type: "review.unavailable", turnId: input.turnId,
      payload: { code: "review_setup_unavailable", reason } }));
    return { decision: input.signal?.aborted ? "interrupted" : "unavailable", requests: Math.max(0,
      input.state.reviewSessions.reduce((total, session) => total + session.requests, 0) - before), reused: false, reason };
  }
}

async function runWorkspaceReviewAttempt(input: WorkspaceReviewRequest, deps: WorkspaceReviewDependencies): Promise<WorkspaceReviewResult> {
  const { state } = input;
  const scope = recoveryScope(state);
  const snapshotId = reviewFingerprint(await deps.workspace.captureSnapshot());
  const corrections = (state.contextIntentLedger?.userCorrections ?? [])
    .map(item => state.messages[item.sourceMessageIndex]?.content ?? item.text);
  const requirementRevision = sha256(JSON.stringify([input.userInput, state.constraints, corrections]));
  const evidenceRevisions = [...new Set(state.commands.map(command => sha256(JSON.stringify([
    command.program, command.args, command.exitCode, command.status, command.summary,
  ]))))].sort();
  const key = sha256(JSON.stringify([snapshotId, requirementRevision, process.platform, process.arch, evidenceRevisions]));
  const previous = state.reviewSessions.find(session => session.key === key);
  if (previous?.status === "applied") return { decision: previous.report && previous.fresh ? "reported" : "inconclusive",
    requests: 0, reused: true, reason: previous.reason, report: previous.report };
  if (!previous && input.remainingModelRequests < 1)
    return { decision: "unavailable", requests: 0, reused: true,
      reason: "The shared task budget does not leave a request for independent review." };

  const emit = async (event: ReviewEvent) => {
    const candidate = structuredClone(state);
    foldReviewEvent(candidate, event);
    durableReviewWrite(() => deps.store.appendEvent(state.threadId, { type: "review.assignment.event", turnId: input.turnId, payload: event }));
    foldReviewEvent(state, event);
    if (event.type === "review_started") {
      try { deps.onProgress?.({ phase: "independent_review" }); }
      catch { /* Presentation cannot undo a durable reviewer transition. */ }
    }
  };
  let copies: Awaited<ReturnType<typeof createReviewCopies>> | undefined;
  let session = previous;
  if (!session) {
    const id = createId("review"), reviewerThreadId = createId("thread");
    let copyError: unknown;
    try { copies = await createReviewCopies(deps.workspace, id, snapshotId, deps.limits.reviewSnapshotMaxBytes,
      { limits: deps.limits, signal: input.signal, offline: deps.offline,
        changedPaths: state.changes.map(change => change.path) }); }
    catch (error) { copyError = error; }
    await emit({ type: "started", id, key, scope, snapshotId, requirementRevision,
      reviewerThreadId, incidentId: input.incidentId, directory: copies?.directory });
    session = state.reviewSessions.at(-1)!;
    if (copyError) { await emit({ type: "unavailable", id, reason: bounded(String(copyError), 1800) });
      await emit({ type: "applied", id, fresh: false });
      return { decision: "unavailable", requests: 0, reused: false, reason: session.reason }; }
  } else {
    if (session.status === "reported" || session.status === "unavailable") {
      await emit({ type: "applied", id: session.id, fresh: snapshotId === session.snapshotId && !input.signal?.aborted &&
        !deps.store.hasPendingTurnSteering(state.threadId, input.turnId) });
      return { decision: session.report ? "reported" : "unavailable", requests: 0, reused: true,
        report: session.report, reason: session.reason };
    }
    // An interrupted provider call may have been charged. Resume the parent,
    // not an unknown reviewer effect or a second paid investigation.
    if (session.status === "reviewing" && session.requests > 0) {
      await emit({ type: "unavailable", id: session.id, reason: "Interrupted reviewer request has an unknown outcome; it will not be replayed." });
      await emit({ type: "applied", id: session.id, fresh: false });
      return { decision: "unavailable", requests: 0, reused: true, reason: session.reason };
    }
    if (session.directory) copies = await restoreReviewCopies(session.directory, session.id, session.snapshotId);
  }
  const id = session.id;
  const get = (): ReviewSession => state.reviewSessions.find(item => item.id === id)!;
  const fresh = async () => !input.signal?.aborted && !deps.store.hasPendingTurnSteering(state.threadId, input.turnId) &&
    reviewFingerprint(await deps.workspace.captureSnapshot()) === session!.snapshotId;
  if (!copies) { await emit({ type: "unavailable", id, reason: "Reviewer snapshot is unavailable" });
    await emit({ type: "applied", id, fresh: false });
    return { decision: "unavailable", requests: 0, reused: false, reason: session.reason }; }
  const root = copies.root, workspaceId = workspaceIdFromRoot(deps.workspace.root);
  const workspace = await WorkspaceManager.create(root, { ignoredDirectoryNames: new Set([
    ".git", ".easycode", ".easy_code", "node_modules", ".venv", "venv", "dist", "build",
  ]) });
  for (const target of [...deps.sensitivePaths, deps.workspace.root]) workspace.pathGuard.protect(target);
  const threadId = session.reviewerThreadId;
  let reviewer = deps.store.get(threadId);
  if (!reviewer) reviewer = durableReviewWrite(() => deps.store.create({ threadId, workspaceRoot: root, mode: "code", provider: state.provider,
    model: state.model, thinkingEffort: state.thinkingEffort, promptBundle: state.promptBundle,
    modelRegistryHash: state.modelRegistryHash, goal: `Independent review ${id}`,
    constraints: ["Private review history. Project memory is read-only."] }));
  if (!session.brief) await emit({ type: "brief_ready", id, text: createMainReviewBrief(state, input) });
  if (!reviewer.messages.some(message => message.role === "user")) {
    const opening: ChatMessage = { role: "user", content: `Original user request:\n${input.userInput}\n` +
      `Constraints: ${JSON.stringify(state.constraints)}\nUser corrections: ${JSON.stringify(corrections)}\n` +
      `Snapshot identity: ${snapshotId}\nMain Agent handoff (unverified): ${get().brief}\n` +
      "Read the project yourself. Return one independent conclusion and one concrete next action; there is no agreement round." };
    durableReviewWrite(() => deps.store.recordMessage(threadId, opening, undefined, "assignment"));
    reviewer.messages.push(opening);
    recordUserRequirement(reviewer, reviewer.messages.length - 1);
  }
  if (session.status === "preparing") await emit({ type: "review_started", id });
  try { deps.status(`Review ${id}: reviewer is independently inspecting the workspace.`); }
  catch { /* The persistent reviewer state remains authoritative. */ }

  const lease = deps.store.acquireThreadLease(threadId);
  const backend = deps.offline ? new BenchmarkContainerBackend({ id, actor: "reviewer", root })
    : new NativeSandboxBackend(workspace, { limits: deps.limits, dataDir: deps.dataDir ?? path.resolve(deps.lifecycleDirectory, "..") });
  const runtime = new CommandRuntime(workspace, undefined, backend, undefined, {
    networkProfile: deps.offline ? "review_offline" : "development", limits: deps.limits,
    lifecycleDirectory: path.join(deps.lifecycleDirectory, threadId),
    createOutputArchive: commandId => deps.memory.evidenceStore.createCommandArchive(workspaceId, threadId, commandId),
    recordLifecycle: (_context, commandId, type, payload) => durableReviewWrite(() => deps.store.appendEvent(threadId,
      { type, turnId: id, payload: { commandId, detail: payload } })),
  });
  const catalog = new ToolCatalog();
  catalog.registerSource(new BuiltinToolSource({ workspace, commandRuntime: runtime, limits: deps.limits }));
  try {
    const tools = (await catalog.snapshot()).tools.filter(tool =>
      ["read_file", "search_files", "run_command", "read_memory", "search_context", "recall_context"].includes(tool.name));
    const context: ToolContext = {
      workspaceRoot: root, mode: "code", threadId, turnId: id, approvalPolicy: "ask",
      commandExecutionMode: "auto_approve", isUnrestrictedHostAccessActive: () => false,
      limits: deps.limits, agentRole: "subagent", agentId: `${id}_reviewer`, assignedTaskId: id,
      signal: input.signal, commandTimeoutMs: deps.limits.commandTimeoutMs, maxOutputChars: deps.limits.maxOutputChars,
      requestApproval: async request => deps.approve(context, request),
      searchProjectMemory: (query, options) => deps.memory.searchHybrid(workspaceId, query, {
        workspaceRoot: root, readOnly: true, limit: options?.limit ?? deps.limits.memorySearchLimit,
        includeInactive: options?.includeInactive,
      }),
      recallContext: async value => {
        try { return recallThreadContext(reviewer!, value, (evidenceId, offset, limit) =>
          deps.memory.evidenceStore.read(workspaceId, threadId, evidenceId, offset, limit), deps.limits); }
        catch (error) { return { ok: false, summary: "Reviewer evidence unavailable", error: String(error) }; }
      },
      searchHistory: async (query, limit) => {
        await deps.index.checkpoint(workspaceId, reviewer!);
        return (await deps.index.search(workspaceId, threadId, query, { limit, beforeMessageIndex: reviewer!.messages.length }))
          .map(hit => ({ id: hit.id, title: hit.title, preview: hit.content.slice(0, 400), historical: true as const }));
      },
      recordCommand: command => { durableReviewWrite(() => deps.store.recordToolAudit(threadId, id, command)); reviewer!.commands.push(command); },
    };
    const participant: ReviewParticipant = { state: reviewer, tools, context,
      assertEnvironmentSafe: () => runtime.assertEnvironmentSafe(),
      optionalMemory: async () => {
        const queries = memoryQueries(reviewer!, input.userInput);
        await deps.index.checkpoint(workspaceId, reviewer!);
        const memories = (await Promise.all(queries.map(query => context.searchProjectMemory!(query)))).flat();
        const evidence = (await Promise.all(queries.map(query => deps.index.search(workspaceId, threadId, query,
          { limit: deps.limits.memorySearchLimit, beforeMessageIndex: reviewer!.compactedMessageCount })))).flat();
        const selected = selectMemoryContext({ state: reviewer!, memories, evidence, queries, limits: deps.limits,
          tokenBudget: optionalMemoryTokenBudget(deps.limits.maxContextChars, deps.limits.maxContextTokens, deps.limits) });
        return JSON.stringify({ memories: selected.memories, historicalEvidence: selected.evidence });
      },
      append: async (type, payload) => {
        durableReviewWrite(() => type === "message" ? deps.store.recordMessage(threadId, payload as ChatMessage, id)
          : type.startsWith("context.") ? deps.store.appendEvent(threadId, { type: type as EventRecord["type"], turnId: id, payload })
          : deps.store.appendEvent(threadId, { type: "review.actor.event", turnId: id, payload: { kind: type, value: payload } }));
      },
      capture: (callId, tool, result) => durableReviewWrite(() => deps.memory.evidenceStore.capture(workspaceId, threadId, callId, tool, result)),
      unchanged: async () => {
        for (const [name, hash] of Object.entries(copies!.baseline)) {
          try { if (sha256(await readFile(await workspace.pathGuard.resolveExisting(name))) !== hash) return false; }
          catch { return false; }
        }
        return true;
      },
    };
    const driver = createReviewDriver({ participant, provider: deps.provider, budget: deps.budget,
      limits: { ...deps.limits, maxContextTokens: input.maxContextTokens ?? deps.limits.maxContextTokens },
      get, emit, signal: input.signal,
      usage: async (usage, attempt) => { durableReviewWrite(() => deps.store.appendEvent(state.threadId, { type: "model.usage", turnId: input.turnId,
        phase: "completed", payload: { actor: "reviewer", purpose: "progress_review", provider: deps.provider.name,
          model: deps.provider.model, turnId: input.turnId, retry: attempt?.retry ?? false, attempt: attempt?.attempt,
          sourceAgentId: `${id}_reviewer`, usage } })); },
    });
    try { await emit({ type: "reported", id, report: await driver.investigate() }); }
    catch (error) { if (error instanceof ReviewFatalError) throw error;
      await emit({ type: "unavailable", id, reason: bounded(String(error), 1800) }); }
  } finally {
    try { await runtime.cancelAll(); } catch (error) { throw new ReviewCleanupError(error); }
    finally { await catalog.close(); durableReviewWrite(() => deps.store.releaseThreadLease(lease)); }
  }
  await emit({ type: "applied", id, fresh: await fresh().catch(() => false) });
  return { decision: input.signal?.aborted ? "interrupted" : get().report ? get().fresh ? "reported" : "inconclusive" : "unavailable",
    requests: get().requests, reused: false, reason: get().reason, report: get().report };
}
