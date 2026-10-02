import path from "node:path";
import { WorkspaceToolObserver } from "../coordination/observer.js";
import { readFile } from "node:fs/promises";
import { recordUserRequirement } from "../context/user-requirements.js";
import type { ModelProvider, SessionState, ToolContext, ChatMessage, EventRecord } from "../core/types.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import type { ThreadStore } from "../threads/thread-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import { projectMemoryIdFromRoot } from "../memory/memory-manager.js";
import type { ContextArtifactIndex } from "../context/artifact-index.js";
import type { TaskBudget } from "../runtime/task-budget.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { CommandRuntime } from "../command/runtime.js";
import { NativeSandboxBackend } from "../sandbox/native-backend.js";
import { BenchmarkContainerBackend } from "../sandbox/benchmark-backend.js";
import { BuiltinToolSource } from "../tools/builtin-source.js";
import { ToolCatalog } from "../tools/catalog.js";
import { activePromptBundleBinding } from "../prompt-bundle/index.js";
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
  state: SessionState;
  turnId: string;
  userInput: string;
  incidentId?: string;
  remainingModelRequests?: number;
  signal?: AbortSignal;
  maxContextTokens?: number;
}
export interface WorkspaceReviewResult {
  decision: "reported" | "inconclusive" | "unavailable" | "interrupted";
  requests: number;
  reused: boolean;
  reason?: string;
  report?: ReviewReport;
}
export interface WorkspaceReviewDependencies {
  workspace: WorkspaceManager;
  store: ThreadStore;
  memory: MemoryManager;
  index: ContextArtifactIndex;
  provider: ModelProvider;
  budget: TaskBudget;
  limits: Readonly<RuntimeLimits>;
  sensitivePaths: string[];
  dataDir?: string;
  lifecycleDirectory: string;
  offline: boolean;
  approve(context: ToolContext, request: import("../core/types.js").ApprovalRequest): Promise<boolean>;
  status(text: string): void;
  onProgress?: (progress: Readonly<{ phase: UIReviewPhase }>) => void;
}

function bounded(value: string, max: number): string {
  const safe = redactSensitiveInformation(value);
  return safe.length <= max
    ? safe
    : safe.slice(0, max) + `\n[Brief excerpt ends; reviewer must inspect independently.]`;
}

/** No model request, source text, diff, or list of changed files is copied into the reviewer prompt. */
export function createMainReviewBrief(state: Readonly<SessionState>, input: WorkspaceReviewRequest): string {
  const failures = unresolvedCommands(state)
    .slice(-4)
    .map((command) => ({
      status: command.status,
      exitCode: command.exitCode,
      verificationKind: command.verificationKind,
      summary: bounded(command.summary ?? "", 450),
    }));
  const incident =
    input.incidentId && state.progressGuard?.incidents.find((item) => item.incidentId === input.incidentId);
  // A working summary is a fallible model narrative. Strip code blocks and
  // dense source-shaped lines; the reviewer reads the actual files itself.
  const narrative = (state.workingSummary ?? "")
    .replace(/```[\s\S]*?```/gu, "[code omitted]")
    .split("\n")
    .filter((line) => line.length <= 320 && !/^\s*(?:\+|-|@@|\d+\s*\|)/u.test(line))
    .join("\n");
  return bounded(
    JSON.stringify({
      mainAgentSummary: bounded(narrative, 5500),
      changedFileCount: state.changes.length,
      repeatedFailure: incident ? { reason: incident.reason, outcomeKey: incident.outcomeKey } : undefined,
      unresolvedVerification: failures,
      instruction:
        "This is the main Agent's fallible handoff, not a finding. Independently read the workspace and report one concrete conclusion/next direction.",
    }),
    15000,
  );
}

/** The app holds its workspace mutation lease for this entire call. */
export async function runWorkspaceReview(
  input: WorkspaceReviewRequest,
  deps: WorkspaceReviewDependencies,
): Promise<WorkspaceReviewResult> {
  const before = input.state.reviewSessions.reduce((total, session) => total + session.requests, 0);
  try {
    return await runWorkspaceReviewAttempt(input, deps);
  } catch (error) {
    if (error instanceof ReviewFatalError) throw error;
    const reason = bounded(String(error), 1800);
    durableReviewWrite(() =>
      deps.store.appendEvent(input.state.threadId, {
        type: "review.unavailable",
        turnId: input.turnId,
        payload: { code: "review_setup_unavailable", reason },
      }),
    );
    return {
      decision: input.signal?.aborted ? "interrupted" : "unavailable",
      requests: Math.max(
        0,
        input.state.reviewSessions.reduce((total, session) => total + session.requests, 0) - before,
      ),
      reused: false,
      reason,
    };
  }
}

/** What a review judges: the workspace snapshot, the user's requirements and the command evidence so far. */
interface ReviewIdentity {
  readonly scope: ReturnType<typeof recoveryScope>;
  readonly snapshotId: string;
  readonly corrections: string[];
  readonly requirementRevision: string;
  /** Equal keys mean an earlier review of the same material can be reused. */
  readonly key: string;
}

type ReviewEmitter = (event: ReviewEvent) => Promise<void>;
type ReviewCopies = Awaited<ReturnType<typeof createReviewCopies>>;

/** A review session with its reviewer workspace and private thread ready. */
interface ReviewerRun {
  readonly input: WorkspaceReviewRequest;
  readonly deps: WorkspaceReviewDependencies;
  readonly id: string;
  readonly threadId: string;
  readonly root: string;
  readonly workspaceId: string;
  readonly projectMemoryId: string;
  readonly workspace: WorkspaceManager;
  readonly reviewer: SessionState;
  readonly copies: ReviewCopies;
  readonly get: () => ReviewSession;
  readonly emit: ReviewEmitter;
}

async function runWorkspaceReviewAttempt(
  input: WorkspaceReviewRequest,
  deps: WorkspaceReviewDependencies,
): Promise<WorkspaceReviewResult> {
  const { state } = input;
  const identity = await reviewIdentity(input, deps);
  const previous = state.reviewSessions.find((session) => session.key === identity.key);
  if (previous?.status === "applied")
    return {
      decision: previous.report && previous.fresh ? "reported" : "inconclusive",
      requests: 0,
      reused: true,
      reason: previous.reason,
      report: previous.report,
    };
  if (!previous && input.remainingModelRequests !== undefined && input.remainingModelRequests < 1)
    return {
      decision: "unavailable",
      requests: 0,
      reused: true,
      reason: "The shared task budget does not leave a request for independent review.",
    };

  const emit = reviewEmitter(input, deps);
  const opened = await openReviewSession(input, deps, identity, previous, emit);
  if (opened.kind === "result") return opened.result;
  const { session, copies } = opened;
  const id = session.id;
  const get = (): ReviewSession => state.reviewSessions.find((item) => item.id === id)!;
  const fresh = async () =>
    !input.signal?.aborted &&
    !deps.store.hasPendingTurnSteering(state.threadId, input.turnId) &&
    reviewFingerprint(await deps.workspace.captureSnapshot()) === session.snapshotId;
  if (!copies) {
    await emit({ type: "unavailable", id, reason: "Reviewer snapshot is unavailable" });
    await emit({ type: "applied", id, fresh: false });
    return { decision: "unavailable", requests: 0, reused: false, reason: session.reason };
  }
  const run = await openReviewerRun(input, deps, identity, session, copies, get, emit);
  await investigate(run);
  await emit({ type: "applied", id, fresh: await fresh().catch(() => false) });
  return {
    decision: input.signal?.aborted
      ? "interrupted"
      : get().report
        ? get().fresh
          ? "reported"
          : "inconclusive"
        : "unavailable",
    requests: get().requests,
    reused: false,
    reason: get().reason,
    report: get().report,
  };
}

async function reviewIdentity(
  input: WorkspaceReviewRequest,
  deps: WorkspaceReviewDependencies,
): Promise<ReviewIdentity> {
  const { state } = input;
  const scope = recoveryScope(state);
  const snapshotId = reviewFingerprint(await deps.workspace.captureSnapshot());
  const corrections = (state.contextIntentLedger?.userCorrections ?? []).map(
    (item) => state.messages[item.sourceMessageIndex]?.content ?? item.text,
  );
  const requirementRevision = sha256(JSON.stringify([input.userInput, state.constraints, corrections]));
  const evidenceRevisions = [
    ...new Set(
      state.commands.map((command) =>
        sha256(JSON.stringify([command.program, command.args, command.exitCode, command.status, command.summary])),
      ),
    ),
  ].sort();
  const key = sha256(
    JSON.stringify([snapshotId, requirementRevision, process.platform, process.arch, evidenceRevisions]),
  );
  return { scope, snapshotId, corrections, requirementRevision, key };
}

/** Persist a review event on the parent thread, then fold it into the live state. */
function reviewEmitter(input: WorkspaceReviewRequest, deps: WorkspaceReviewDependencies): ReviewEmitter {
  const { state } = input;
  return async (event) => {
    const candidate = structuredClone(state);
    foldReviewEvent(candidate, event);
    durableReviewWrite(() =>
      deps.store.appendEvent(state.threadId, { type: "review.assignment.event", turnId: input.turnId, payload: event }),
    );
    foldReviewEvent(state, event);
    if (event.type === "review_started") {
      try {
        deps.onProgress?.({ phase: "independent_review" });
      } catch {
        /* Presentation cannot undo a durable reviewer transition. */
      }
    }
  };
}

/**
 * Start a new session with fresh snapshot copies, or resume the previous one. A resumed session that already has a
 * result, or whose interrupted reviewer request may have been charged, is settled without a new investigation.
 */
async function openReviewSession(
  input: WorkspaceReviewRequest,
  deps: WorkspaceReviewDependencies,
  identity: ReviewIdentity,
  previous: ReviewSession | undefined,
  emit: ReviewEmitter,
): Promise<
  { kind: "result"; result: WorkspaceReviewResult } | { kind: "session"; session: ReviewSession; copies?: ReviewCopies }
> {
  const { state } = input;
  if (!previous) {
    const id = createId("review"),
      reviewerThreadId = createId("thread");
    let copies: ReviewCopies | undefined;
    let copyError: unknown;
    try {
      copies = await createReviewCopies(deps.workspace, id, identity.snapshotId, deps.limits.reviewSnapshotMaxBytes, {
        limits: deps.limits,
        signal: input.signal,
        offline: deps.offline,
        changedPaths: state.changes.map((change) => change.path),
      });
    } catch (error) {
      copyError = error;
    }
    await emit({
      type: "started",
      id,
      key: identity.key,
      scope: identity.scope,
      snapshotId: identity.snapshotId,
      requirementRevision: identity.requirementRevision,
      reviewerThreadId,
      incidentId: input.incidentId,
      directory: copies?.directory,
    });
    const session = state.reviewSessions.at(-1)!;
    if (copyError) {
      await emit({ type: "unavailable", id, reason: bounded(String(copyError), 1800) });
      await emit({ type: "applied", id, fresh: false });
      return {
        kind: "result",
        result: { decision: "unavailable", requests: 0, reused: false, reason: session.reason },
      };
    }
    return { kind: "session", session, copies };
  }
  const session = previous;
  if (session.status === "reported" || session.status === "unavailable") {
    await emit({
      type: "applied",
      id: session.id,
      fresh:
        identity.snapshotId === session.snapshotId &&
        !input.signal?.aborted &&
        !deps.store.hasPendingTurnSteering(state.threadId, input.turnId),
    });
    return {
      kind: "result",
      result: {
        decision: session.report ? "reported" : "unavailable",
        requests: 0,
        reused: true,
        report: session.report,
        reason: session.reason,
      },
    };
  }
  // An interrupted provider call may have been charged. Resume the parent,
  // not an unknown reviewer effect or a second paid investigation.
  if (session.status === "reviewing" && session.requests > 0) {
    await emit({
      type: "unavailable",
      id: session.id,
      reason: "Interrupted reviewer request has an unknown outcome; it will not be replayed.",
    });
    await emit({ type: "applied", id: session.id, fresh: false });
    return { kind: "result", result: { decision: "unavailable", requests: 0, reused: true, reason: session.reason } };
  }
  return {
    kind: "session",
    session,
    ...(session.directory
      ? { copies: await restoreReviewCopies(session.directory, session.id, session.snapshotId) }
      : {}),
  };
}

/** Open the reviewer's guarded workspace over the snapshot copies and its private thread, and hand it the brief. */
async function openReviewerRun(
  input: WorkspaceReviewRequest,
  deps: WorkspaceReviewDependencies,
  identity: ReviewIdentity,
  session: ReviewSession,
  copies: ReviewCopies,
  get: () => ReviewSession,
  emit: ReviewEmitter,
): Promise<ReviewerRun> {
  const { state } = input;
  const id = session.id;
  const root = copies.root,
    workspaceId = deps.workspace.projectId ?? workspaceIdFromRoot(deps.workspace.root);
  const projectMemoryId = deps.workspace.projectId ?? projectMemoryIdFromRoot(deps.workspace.root);
  const workspace = await WorkspaceManager.create(root, {
    ignoredDirectoryNames: new Set([
      ".git",
      ".easycode",
      ".easy_code",
      "node_modules",
      ".venv",
      "venv",
      "dist",
      "build",
    ]),
  });
  for (const target of [...deps.sensitivePaths, ...deps.workspace.writableRoots]) workspace.pathGuard.protect(target);
  const threadId = session.reviewerThreadId;
  const reviewer =
    deps.store.get(threadId) ??
    durableReviewWrite(() =>
      deps.store.create({
        threadId,
        workspaceRoot: root,
        projectId: deps.workspace.projectId,
        mode: "code",
        provider: state.provider,
        model: state.model,
        thinkingEffort: state.thinkingEffort,
        promptBundle: activePromptBundleBinding(),
        modelRegistryHash: state.modelRegistryHash,
        goal: `Independent review ${id}`,
        constraints: ["Private review history. Project memory is read-only."],
      }),
    );
  if (!session.brief) await emit({ type: "brief_ready", id, text: createMainReviewBrief(state, input) });
  if (!reviewer.messages.some((message) => message.role === "user")) {
    const opening: ChatMessage = {
      role: "user",
      content:
        `Original user request:\n${input.userInput}\n` +
        `Constraints: ${JSON.stringify(state.constraints)}\nUser corrections: ${JSON.stringify(identity.corrections)}\n` +
        `Snapshot identity: ${identity.snapshotId}\nMain Agent handoff (unverified): ${get().brief}\n` +
        "Read the project yourself. Return one independent conclusion and one concrete next action; there is no agreement round.",
    };
    durableReviewWrite(() => deps.store.recordMessage(threadId, opening, undefined, "assignment"));
    reviewer.messages.push(opening);
    recordUserRequirement(reviewer, reviewer.messages.length - 1);
  }
  if (session.status === "preparing") await emit({ type: "review_started", id });
  try {
    deps.status(`Review ${id}: reviewer is independently inspecting the workspace.`);
  } catch {
    /* The persistent reviewer state remains authoritative. */
  }
  return { input, deps, id, threadId, root, workspaceId, projectMemoryId, workspace, reviewer, copies, get, emit };
}

/** Run the reviewer under its own thread lease and sandbox with read-only tools, then release everything it held. */
async function investigate(run: ReviewerRun): Promise<void> {
  const { deps, id, threadId, workspace, emit } = run;
  const lease = deps.store.acquireThreadLease(threadId);
  const runtime = reviewerCommandRuntime(run);
  const observer = deps.offline
    ? undefined
    : new WorkspaceToolObserver(
        workspace,
        deps.store.coordination,
        deps.limits,
        deps.status,
        (commandId) => runtime.whenSettled(commandId),
        deps.dataDir ? [deps.dataDir] : [],
      );
  const catalog = new ToolCatalog(observer);
  catalog.registerSource(
    new BuiltinToolSource({
      workspace,
      commandRuntime: runtime,
      limits: deps.limits,
      profile: deps.offline ? "benchmark" : undefined,
    }),
  );
  try {
    const tools = (await catalog.snapshot()).tools.filter((tool) =>
      ["read_file", "search_files", "run_command", "read_memory", "search_context", "recall_context"].includes(
        tool.name,
      ),
    );
    const driver = createReviewDriver({
      participant: reviewParticipant(run, tools, reviewerToolContext(run), runtime),
      provider: deps.provider,
      budget: deps.budget,
      limits: { ...deps.limits, maxContextTokens: run.input.maxContextTokens ?? deps.limits.maxContextTokens },
      get: run.get,
      emit,
      signal: run.input.signal,
      usage: async (usage, attempt) => {
        durableReviewWrite(() =>
          deps.store.appendEvent(run.input.state.threadId, {
            type: "model.usage",
            turnId: run.input.turnId,
            phase: "completed",
            payload: {
              actor: "reviewer",
              purpose: "progress_review",
              provider: deps.provider.name,
              model: deps.provider.model,
              turnId: run.input.turnId,
              retry: attempt?.retry ?? false,
              attempt: attempt?.attempt,
              sourceAgentId: `${id}_reviewer`,
              usage,
            },
          }),
        );
      },
    });
    try {
      await emit({ type: "reported", id, report: await driver.investigate() });
    } catch (error) {
      if (error instanceof ReviewFatalError) throw error;
      await emit({ type: "unavailable", id, reason: bounded(String(error), 1800) });
    }
  } finally {
    try {
      await runtime.cancelAll();
    } catch (error) {
      throw new ReviewCleanupError(error);
    } finally {
      await observer?.drain();
      await catalog.close();
      durableReviewWrite(() => deps.store.releaseThreadLease(lease));
    }
  }
}

/** The reviewer's command runtime: an offline container or the native sandbox over the snapshot copies. */
function reviewerCommandRuntime(run: ReviewerRun): CommandRuntime {
  const { deps, id, root, threadId, workspace, workspaceId } = run;
  const backend = deps.offline
    ? new BenchmarkContainerBackend({ id, actor: "reviewer", root })
    : new NativeSandboxBackend(workspace, {
        limits: deps.limits,
        dataDir: deps.dataDir ?? path.resolve(deps.lifecycleDirectory, ".."),
      });
  return new CommandRuntime(workspace, undefined, backend, undefined, {
    networkProfile: deps.offline ? "review_offline" : "development",
    limits: deps.limits,
    lifecycleDirectory: path.join(deps.lifecycleDirectory, threadId),
    createOutputArchive: (commandId) =>
      deps.memory.evidenceStore.createCommandArchive(workspaceId, threadId, commandId),
    recordLifecycle: (_context, commandId, type, payload) =>
      durableReviewWrite(() =>
        deps.store.appendEvent(threadId, { type, turnId: id, payload: { commandId, detail: payload } }),
      ),
  });
}

/** Tool context for the reviewer: a subagent with read-only project memory and its own history and evidence. */
function reviewerToolContext(run: ReviewerRun): ToolContext {
  const { deps, id, input, projectMemoryId, reviewer, root, threadId, workspaceId } = run;
  const context: ToolContext = {
    workspaceRoot: root,
    mode: "code",
    threadId,
    turnId: id,
    approvalPolicy: "ask",
    commandExecutionMode: "auto_approve",
    isUnrestrictedHostAccessActive: () => false,
    limits: deps.limits,
    agentRole: "subagent",
    agentId: `${id}_reviewer`,
    assignedTaskId: id,
    signal: input.signal,
    commandTimeoutMs: deps.limits.commandTimeoutMs,
    maxOutputChars: deps.limits.maxOutputChars,
    requestApproval: async (request) => deps.approve(context, request),
    searchProjectMemory: (query, options) =>
      deps.memory.searchScoped(projectMemoryId, query, {
        workspaceRoot: root,
        limit: options?.limit ?? deps.limits.memorySearchLimit,
        includeInactive: options?.includeInactive,
        scope: options?.scope,
        includeGlobalPreferences: options === undefined,
      }),
    recallContext: async (value) => {
      try {
        return recallThreadContext(
          reviewer,
          value,
          (evidenceId, offset, limit) =>
            deps.memory.evidenceStore.read(workspaceId, threadId, evidenceId, offset, limit),
          deps.limits,
        );
      } catch (error) {
        return { ok: false, summary: "Reviewer evidence unavailable", error: String(error) };
      }
    },
    searchHistory: async (query, limit) => {
      await deps.index.checkpoint(workspaceId, reviewer);
      return (
        await deps.index.search(workspaceId, threadId, query, {
          limit,
          beforeMessageIndex: reviewer.messages.length,
        })
      ).map((hit) => ({
        id: hit.id,
        title: hit.title,
        preview: hit.content.slice(0, 400),
        historical: true as const,
      }));
    },
    recordCommand: (command) => {
      durableReviewWrite(() => deps.store.recordToolAudit(threadId, id, command));
      reviewer.commands.push(command);
    },
  };
  return context;
}

/** The reviewer as the review driver sees it: its state, tools, optional memory, durable log and snapshot check. */
function reviewParticipant(
  run: ReviewerRun,
  tools: ReviewParticipant["tools"],
  context: ToolContext,
  runtime: CommandRuntime,
): ReviewParticipant {
  const { copies, deps, id, input, reviewer, threadId, workspace, workspaceId } = run;
  return {
    state: reviewer,
    tools,
    context,
    assertEnvironmentSafe: () => runtime.assertEnvironmentSafe(),
    optionalMemory: async () => {
      const queries = memoryQueries(reviewer, input.userInput);
      await deps.index.checkpoint(workspaceId, reviewer);
      const memories = (
        await Promise.all(
          queries.map((query, index) =>
            context.searchProjectMemory!(
              query,
              index === 0 || query === input.userInput ? undefined : { scope: "project" },
            ),
          ),
        )
      ).flat();
      const evidence = (
        await Promise.all(
          queries.map((query) =>
            deps.index.search(workspaceId, threadId, query, {
              limit: deps.limits.memorySearchLimit,
              beforeMessageIndex: reviewer.compactedMessageCount,
            }),
          ),
        )
      ).flat();
      const selected = selectMemoryContext({
        state: reviewer,
        memories,
        evidence,
        limits: deps.limits,
        tokenBudget: optionalMemoryTokenBudget(deps.limits.maxContextChars, deps.limits.maxContextTokens, deps.limits),
      });
      return JSON.stringify({
        memories: selected.memories.map((memory) => ({
          id: memory.id,
          scope: memory.scope,
          category: memory.category,
          content: memory.content,
          status: memory.status,
        })),
        historicalEvidence: selected.evidence,
      });
    },
    append: async (type, payload) => {
      durableReviewWrite(() =>
        type === "message"
          ? deps.store.recordMessage(threadId, payload as ChatMessage, id)
          : type.startsWith("context.")
            ? deps.store.appendEvent(threadId, { type: type as EventRecord["type"], turnId: id, payload })
            : deps.store.appendEvent(threadId, {
                type: "review.actor.event",
                turnId: id,
                payload: { kind: type, value: payload },
              }),
      );
    },
    capture: (callId, tool, result) =>
      durableReviewWrite(() => deps.memory.evidenceStore.capture(workspaceId, threadId, callId, tool, result)),
    unchanged: async () => {
      for (const [name, hash] of Object.entries(copies.baseline)) {
        try {
          if (sha256(await readFile(await workspace.pathGuard.resolveExisting(name))) !== hash) return false;
        } catch {
          return false;
        }
      }
      return true;
    },
  };
}
