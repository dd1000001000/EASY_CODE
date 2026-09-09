import path from "node:path";
import { recordUserRequirement } from "../context/user-requirements.js";
import type { ModelProvider, SessionState, ToolContext, ChatMessage, ToolExecutionResult } from "../core/types.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import type { ThreadStore } from "../threads/thread-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { ContextArtifactIndex } from "../context/artifact-index.js";
import type { TaskBudget } from "../runtime/task-budget.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { CommandRuntime } from "../command/runtime.js";
import { AnthropicSandboxBackend } from "../sandbox/anthropic-backend.js";
import { BenchmarkContainerBackend } from "../sandbox/benchmark-backend.js";
import { createDefaultTools } from "../tools/registry.js";
import { recallThreadContext } from "../context/recall.js";
import { recoveryScope } from "../context/capacity.js";
import { memoryQueries, selectMemoryContext, optionalMemoryTokenBudget } from "../context/memory-controller.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { unresolvedCommands } from "../context/runtime-state.js";
import { copyReviewDependencies, dependenciesUnchanged } from "./environment.js";
import { ReviewFatalError, ReviewCleanupError, durableReviewWrite } from "./errors.js";
import { readFile } from "node:fs/promises";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hash.js";
import { createReviewCopies, restoreReviewCopies, reviewDiff, reviewFingerprint } from "./workspace.js";
import { foldReviewEvent, runReviewDiscussion, type ReviewActor, type ReviewEvent } from "./session.js";
import { createReviewDriver, type ReviewParticipant } from "./driver.js";
import { preflightReviewEnvironment } from "./preflight.js";

export interface WorkspaceReviewRequest {
  state: SessionState; turnId: string; userInput: string; purpose: "stagnation" | "delivery";
  incidentId?: string; remainingModelRequests: number; signal?: AbortSignal;
  maxContextTokens?: number;
}
export interface WorkspaceReviewResult { approved: boolean; requests: number; reused: boolean; reason?: string;
  decision?: "approved" | "changes_requested" | "inconclusive" | "unavailable" | "interrupted" }
export interface WorkspaceReviewDependencies {
  workspace: WorkspaceManager; store: ThreadStore; memory: MemoryManager; index: ContextArtifactIndex;
  provider: ModelProvider; budget: TaskBudget; limits: Readonly<RuntimeLimits>;
  sensitivePaths: string[]; lifecycleDirectory: string; offline: boolean;
  approve(context: ToolContext, request: import("../core/types.js").ApprovalRequest): Promise<boolean>;
  status(text: string): void;
  readBaseline?: (hash: string) => Promise<Buffer | undefined>;
}

/** The app holds its workspace mutation lease for this entire call. */
export async function runWorkspaceReview(input: WorkspaceReviewRequest, deps: WorkspaceReviewDependencies): Promise<WorkspaceReviewResult> {
  const startedRequests = (input.state.reviewSessions ?? []).reduce((total, s) => total + s.requests, 0);
  try {
    const result = await runWorkspaceReviewAttempt(input, deps);
    const reason = result.reason ?? "";
    return { ...result, decision: result.approved ? "approved" : input.signal?.aborted ? "interrupted" :
      /unavailable|Insufficient|budget exhausted|time_limit|request_limit/iu.test(reason) ? "unavailable" : "inconclusive" };
  } catch (error) {
    if (error instanceof ReviewFatalError) throw error;
    const reason = redactSensitiveInformation(String(error)).slice(0, 1800);
    durableReviewWrite(() => deps.store.appendEvent(input.state.threadId, { type: "review.unavailable", turnId: input.turnId,
      payload: { code: "review_setup_unavailable", reason, deliveryId: input.state.delivery?.id } }));
    return { approved: false, requests: Math.max(0, (input.state.reviewSessions ?? []).reduce((total, s) => total + s.requests, 0) - startedRequests),
      reused: true, decision: input.signal?.aborted ? "interrupted" : "unavailable", reason };
  }
}

async function runWorkspaceReviewAttempt(input: WorkspaceReviewRequest, deps: WorkspaceReviewDependencies): Promise<WorkspaceReviewResult> {
  const { state } = input;
  const scope = state.delivery?.id ?? recoveryScope(state);
  const snapshot = await deps.workspace.captureSnapshot();
  const snapshotId = reviewFingerprint(snapshot);
  const correctionRefs = [...(state.contextIntentLedger?.userCorrections ?? [])];
  const latest = state.contextIntentLedger?.latestRequest;
  if (latest && state.delivery && latest.sourceMessageIndex > state.delivery.sourceMessageIndex) correctionRefs.push(latest);
  const corrections = [...new Set(correctionRefs.map(c => state.messages[c.sourceMessageIndex]?.content ?? c.text))];
  const requirementRevision = sha256(JSON.stringify([input.userInput, state.constraints, corrections]));
  // Dependencies are outside the source snapshot. They must still invalidate
  // cached approvals. The offline worker also owns image-level installations;
  // a new main command conservatively invalidates that environment revision.
  const environmentRevision = deps.offline ? sha256(JSON.stringify(state.commands.map(c => c.id))) :
    sha256(JSON.stringify(Object.entries(await copyReviewDependencies(deps.workspace.root, [], deps.limits, input.signal)).sort()));
  const key = sha256(JSON.stringify([scope, input.purpose, snapshotId, requirementRevision, environmentRevision,
    // A changed verified outcome is new evidence; merely re-running the same command is not.
    state.commands.slice(-6).map(c => [c.program, c.args, c.exitCode, c.status, c.summary])]));
  const previous = state.reviewSessions?.find(s => s.key === key);
  if (previous?.status === "applied") return { approved: previous.approval && !deps.store.hasPendingTurnSteering(state.threadId, input.turnId), requests: 0, reused: true, reason: previous.closeReason };
  let session = previous ?? state.reviewSessions?.find(s => s.status !== "applied");
  if (!session && input.remainingModelRequests < 3) return { approved: false, requests: 0, reused: true,
    reason: "Insufficient remaining task requests to start review and reserve both closing summaries." };
  const emit = async (event: ReviewEvent) => {
    const candidate = structuredClone(state); foldReviewEvent(candidate, event);
    durableReviewWrite(() => deps.store.appendEvent(state.threadId, { type: "review.session.event", turnId: input.turnId, payload: event }));
    foldReviewEvent(state, event);
  };
  if (!session && (state.reviewSessions?.filter(s => s.scope === scope).length ?? 0) >= deps.limits.reviewMaxSessionsPerTask)
    return { approved: false, requests: 0, reused: true, reason: "Review session budget exhausted; no new review was started." };
  let copies: Awaited<ReturnType<typeof createReviewCopies>> | undefined;
  let setupError: unknown;
  if (!session) {
    const id = createId("review");
    try { copies = await createReviewCopies(deps.workspace, id, snapshotId, deps.limits.reviewSnapshotMaxBytes,
      state.progressGuard?.validationBaseline, { readBaseline: deps.readBaseline, limits: deps.limits, signal: input.signal, offline: deps.offline }); } catch (error) { setupError = error; }
    await emit({ type: "started", id, key, scope, purpose: input.purpose, snapshotId, requirementRevision,
      changeCount: state.changes.length,
      changedPaths: [...new Set(state.changes.slice(state.delivery?.changeStart ?? 0).map(c => c.path.replaceAll("\\", "/")))],
      requirements: [...new Set([`request:${sha256(input.userInput)}`, ...state.constraints.map(c => `constraint:${sha256(c)}`),
        ...corrections.map(c => `correction:${sha256(c ?? "")}`)])],
      blockingChecks: unresolvedCommands(state).filter(c => c.validation?.status === "failed" || c.verificationKind && c.exitCode !== 0)
        .map(c => c.validation?.checkKey ?? c.validation?.targetKey ?? c.id),
      documentationOnly: state.changes.length > 0 && state.changes.slice(state.delivery?.changeStart ?? 0)
        .every(c => /\.(?:md|rst|txt)$/iu.test(c.path)) && state.changes.slice(state.delivery?.changeStart ?? 0).length > 0,
      incidentId: input.incidentId, directory: copies?.directory,
      actorThreads: { author: createId("thread"), reviewer: createId("thread") },
      maxRounds: deps.limits.reviewMaxRounds, maxRequests: Math.max(2, Math.min(deps.limits.reviewMaxRequests, input.remainingModelRequests)),
      maxTools: deps.limits.reviewMaxToolCalls, deadline: Date.now() + deps.limits.reviewTimeoutMs,
      summaryTokens: deps.limits.reviewSummaryMaxTokens });
    session = state.reviewSessions!.at(-1)!;
  } else if (session.directory) {
    try { copies = await restoreReviewCopies(session.directory, session.id, session.snapshotId); } catch (error) { setupError = error; }
  }
  const reviewId = session.id;
  const get = () => state.reviewSessions!.find(s => s.id === reviewId)!;
  const beforeRequests = session.requests;
  const fresh = async () => !input.signal?.aborted && !deps.store.hasPendingTurnSteering(state.threadId, input.turnId) && requirementRevision === get().requirementRevision &&
    get().key === key &&
    reviewFingerprint(await deps.workspace.captureSnapshot()) === get().snapshotId &&
    (!copies || deps.offline || await dependenciesUnchanged(deps.workspace.root, copies.dependencyHashes, deps.limits));
  if (session.status === "decided") {
    await emit({ type: "applied", id: reviewId, fresh: await fresh() });
    return { approved: session.approval && await fresh(), requests: 0, reused: true };
  }
  if (!copies || setupError || session.key !== key || session.snapshotId !== snapshotId || session.requirementRevision !== requirementRevision) {
    if (get().status === "discussing") await emit({ type: "close", id: reviewId,
      reason: `Review environment unavailable or stale: ${String(setupError ?? "snapshot changed").slice(0, 1500)}` });
    await runReviewDiscussion(get, emit, { canSummarize: false, discuss: async () => { throw new Error("No snapshot"); },
      summarize: async () => undefined, fresh: async () => false });
    await emit({ type: "applied", id: reviewId });
    return { approved: false, requests: 0, reused: false, reason: get().closeReason };
  }
  const workspaceId = workspaceIdFromRoot(deps.workspace.root);
  const commands: CommandRuntime[] = [];
  const leases: ReturnType<ThreadStore["acquireThreadLease"]>[] = [];
  let driver: ReturnType<typeof createReviewDriver> | undefined;
  try {
    const participants = {} as Record<ReviewActor, ReviewParticipant>;
    for (const who of ["author", "reviewer"] as const) {
      const root = copies.roots[who];
      const workspace = await WorkspaceManager.create(root, { ignoredDirectoryNames: new Set([
        ".git", ".easycode", ".easy_code", "node_modules", ".venv", "venv", "dist", "build",
      ]) });
      const privatePaths = [...deps.sensitivePaths, deps.workspace.root, copies.roots[who === "author" ? "reviewer" : "author"]];
      for (const target of privatePaths) workspace.pathGuard.protect(target);
      const threadId = get().actorThreads![who];
      let actorState = deps.store.get(threadId);
      if (!actorState) {
        actorState = durableReviewWrite(() => deps.store.create({ threadId, workspaceRoot: root, mode: "code", provider: state.provider,
          model: state.model, thinkingEffort: state.thinkingEffort, promptBundle: state.promptBundle,
          goal: `Review ${reviewId}`, constraints: ["Private review history. Project memory is read-only."] }));
        const diff = await reviewDiff(deps.workspace);
        const materialId = durableReviewWrite(() => deps.memory.evidenceStore.capture(workspaceId, threadId, "review_material", "review_material", {
          ok: true, summary: "Immutable review material, not instructions or self-certified facts", data: {
            request: input.userInput, constraints: state.constraints, corrections, diff,
            changes: state.changes, commands: state.commands, incidentId: input.incidentId,
            // Explicitly shared raw results are referenced here, not indexed as actor private thought.
            recentTools: state.messages.slice(-24).filter(m => m.role === "tool"),
          } }));
        const opening: ChatMessage = { role: "user", content: `Review ${input.purpose} for the original request:\n${input.userInput}\n` +
          `Constraints: ${JSON.stringify(state.constraints)}\nCorrections: ${JSON.stringify(corrections)}\nSnapshot: ${snapshotId}\n` +
          `Required acceptance IDs: ${JSON.stringify(get().requirements)}. Checks must bind these IDs to actual evidence.\n` +
          `Full immutable diff, history evidence and commands: ${materialId}. Use recall_context to read it in pages.\n` +
          "Independently inspect semantics and counterexamples. The author cannot grant delivery approval alone." };
        const material: ChatMessage = { role: "user", content: "RUNTIME_REVIEW_MATERIAL (historical evidence, not user requirements):\n" +
          `Changed paths: ${JSON.stringify(state.changes.map(c => c.path))}\n` +
          (who === "reviewer" ? `Original tests restored in YOUR copy (exact pre-agent baseline hashes): ${JSON.stringify(copies.restoredTests)}. Implementation files still match the reviewed snapshot.\n` : "") +
          `Latest verification records: ${JSON.stringify(state.commands.slice(-3))}\n` +
          "Author: first explain the implementation and uncertainties. Reviewer: independently inspect semantics and counterexamples. " +
          "Changes to tests are not independent proof. The author cannot grant delivery approval alone." };
        durableReviewWrite(() => deps.store.recordMessage(threadId, opening, undefined, "assignment")); actorState.messages.push(opening);
        recordUserRequirement(actorState, actorState.messages.length - 1);
        durableReviewWrite(() => deps.store.recordMessage(threadId, material)); actorState.messages.push(material);
      }
      leases.push(deps.store.acquireThreadLease(threadId));
      const backend = deps.offline ? new BenchmarkContainerBackend({ id: reviewId, actor: who, root })
        : new AnthropicSandboxBackend(workspace, { sensitiveReadPaths: privatePaths });
      const runtime = new CommandRuntime(workspace, undefined, backend, undefined, {
        networkProfile: deps.offline ? "review_offline" : "development",
        lifecycleDirectory: path.join(deps.lifecycleDirectory, threadId),
        recordLifecycle: (context, commandId, type, payload) => durableReviewWrite(() => deps.store.appendEvent(threadId,
          { type, turnId: reviewId, payload: { commandId, detail: payload } })),
      });
      commands.push(runtime);
      const tools = createDefaultTools(workspace, undefined, { commandRuntime: runtime }).filter(t =>
        ["read_file", "search_files", "run_command", "search_context", "recall_context"].includes(t.name));
      const context: ToolContext = {
        workspaceRoot: root, mode: "code", threadId, turnId: reviewId, approvalPolicy: "ask",
        commandExecutionMode: "auto_approve", isUnrestrictedHostAccessActive: () => false,
        limits: deps.limits, agentRole: "subagent", agentId: `${reviewId}_${who}`, assignedTaskId: reviewId,
        signal: input.signal, commandTimeoutMs: deps.limits.commandTimeoutMs, maxOutputChars: deps.limits.maxOutputChars,
        validationBaseline: state.progressGuard?.validationBaseline,
        requestApproval: async request => deps.approve(context, request),
        searchProjectMemory: query => deps.memory.searchHybrid(workspaceId, query, { workspaceRoot: root, readOnly: true, limit: deps.limits.memorySearchLimit }),
        recallContext: async value => {
          try {
            if (value.evidenceId === `review:${reviewId}:briefing`) return { ok: true, summary: "Opening brief, unverified",
              data: { content: get().briefing?.full.slice(value.offset, value.offset + value.limit) ?? "" } };
            return recallThreadContext(actorState!, value, (id, offset, limit) => {
            // Peer command evidence is explicitly shared in Runtime experiments; no blanket parent/peer history read.
            const owner = get().experiments.find(e => e.id === id)?.actor ??
              get().statements.find(s => s.value.evidenceRefs.includes(id))?.actor;
            return deps.memory.evidenceStore.read(workspaceId, owner ? get().actorThreads![owner] : threadId, id, offset, limit);
          }); } catch (error) { return { ok: false, summary: "Historical evidence unavailable", error: String(error) }; }
        },
        searchHistory: async (query, limit) => {
          await deps.index.checkpoint(workspaceId, actorState!);
          return (await deps.index.search(workspaceId, threadId, query, { limit, beforeMessageIndex: actorState!.messages.length }))
            .map(hit => ({ id: hit.id, title: hit.title, preview: hit.content.slice(0, 400), historical: true as const }));
        },
        recordCommand: command => { durableReviewWrite(() => deps.store.recordToolAudit(threadId, reviewId, command)); actorState!.commands.push(command); },
      };
      participants[who] = { state: actorState, tools, context,
        optionalMemory: async () => {
          const queries = memoryQueries(actorState!, input.userInput);
          await deps.index.checkpoint(workspaceId, actorState!);
          const memories = (await Promise.all(queries.map(query => context.searchProjectMemory!(query)))).flat();
          const evidence = (await Promise.all(queries.map(query => deps.index.search(workspaceId, threadId, query,
            { limit: deps.limits.memorySearchLimit, beforeMessageIndex: actorState!.compactedMessageCount })))).flat();
          const selected = selectMemoryContext({ state: actorState!, memories, evidence, queries, limits: deps.limits,
            tokenBudget: optionalMemoryTokenBudget(deps.limits.maxContextChars, deps.limits.maxContextTokens, deps.limits) });
          return JSON.stringify({ memories: selected.memories, historicalEvidence: selected.evidence });
        },
        append: async (type, payload) => {
          durableReviewWrite(() => type === "message" ? deps.store.recordMessage(threadId, payload as ChatMessage, reviewId)
            : deps.store.appendEvent(threadId, { type, turnId: reviewId, payload }));
        },
        capture: (callId, tool, result) => durableReviewWrite(() => deps.memory.evidenceStore.capture(workspaceId, threadId, callId, tool, result)),
        // Ignore newly created experimental files, but any original source/test
        // modification or deletion makes the experiment non-independent.
        unchanged: async () => {
          // Only immutable baseline files are proof inputs. A generated file
          // must not make a large dependency tree overflow source inventory.
          for (const [name, hash] of Object.entries(copies!.baselines[who])) {
            try { if (sha256(await readFile(await workspace.pathGuard.resolveExisting(name))) !== hash) return false; }
            catch { return false; }
          }
          return deps.offline || await dependenciesUnchanged(root, copies!.dependencyHashes, deps.limits);
        },
      };
    }
    driver = createReviewDriver({ participants, briefSource: state, provider: deps.provider, budget: deps.budget,
      limits: { ...deps.limits, maxContextTokens: input.maxContextTokens ?? deps.limits.maxContextTokens },
      get, emit, fresh, signal: input.signal,
      usage: async (who, usage, attempt) => { durableReviewWrite(() => deps.store.appendEvent(state.threadId, { type: "model.usage", turnId: input.turnId,
        phase: "completed", payload: { actor: "reviewer", purpose: "progress_review", provider: deps.provider.name,
          model: deps.provider.model, turnId: input.turnId, retry: attempt?.retry ?? false, attempt: attempt?.attempt, sourceAgentId: `${reviewId}_${who}`, usage } })); },
    });
    if (get().status === "discussing" && !get().environmentReady) {
      if (get().environmentStarted) throw new Error("Review environment preflight was unavailable or interrupted; no blind retry");
      await emit({ type: "environment_started", id: reviewId });
      for (const participant of Object.values(participants)) {
        await emit({ type: "tool", id: reviewId });
        await preflightReviewEnvironment(participant);
      }
      await emit({ type: "environment_checked", id: reviewId, ready: true });
    }
    deps.status(`Review ${reviewId}: ${input.purpose}; maximum five rounds, independent closing summaries.`);
    await runReviewDiscussion(get, emit, driver);
  } catch (error) {
    if (error instanceof ReviewFatalError) throw error;
    if (get().status === "discussing") await emit({ type: "close", id: reviewId, reason: `review_unavailable: ${String(error).slice(0, 1700)}` });
    await runReviewDiscussion(get, emit, { canSummarize: false, discuss: async () => { throw error; }, summarize: async () => undefined, fresh: async () => false });
  } finally {
    try { driver?.release(); } finally {
      try { await Promise.all(commands.map(runtime => runtime.cancelAll())); }
      catch (error) { throw new ReviewCleanupError(error); }
      finally { for (const lease of leases) durableReviewWrite(() => deps.store.releaseThreadLease(lease)); }
    }
  }
  if (get().status === "decided") await emit({ type: "applied", id: reviewId, fresh: await fresh() });
  return { approved: get().approval && await fresh(), requests: get().requests - beforeRequests, reused: false, reason: get().closeReason };
}
