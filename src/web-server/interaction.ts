import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision, ApprovalRequest, AssistantPhase, FileDiffPresentation, ImageAttachment,
  PlanProposal, ProviderStreamEvent, ThinkingEffort,
} from "../core/types.js";
import type { TaskGraphView } from "../tasks/task-graph.js";
import type { SubagentView } from "../subagents/types.js";
import type { UIActivityKind, UIReviewPhase, UISessionInfo } from "../ui/contracts.js";
import type {
  AppInteractionPort, CompletedTurnTiming, CurrentRequestOptions, InteractionChoice,
  ModelSelectorChoice, PlanReviewDecision, PlanReviewInputOptions,
  ProviderSelectorChoice, RequestInputOptions, ThinkingEffortSelectorChoice,
  TimedChoiceOptions, UserSubmission,
} from "../ui/interaction-port.js";
import { DECISION_TIMEOUT_MS } from "../ui/decision-timeout.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { sanitizeTerminalText } from "../ui/render/layout.js";
import { canGrantCommandPrefix, formatCommandApprovalPrefix } from "../command/approval.js";
import type { Language } from "../i18n/language.js";
import { translate } from "../i18n/catalog.js";
import { toolRunContinuesAcross, turnContinuesAcross } from "../web-tool-run.js";
import type { WebChange, WebDecision, WebEntry, WebEntryKind, WebHistoryMarker, WebHistoryPage, WebHistoryState, WebPatch, WebView } from "../web-contracts.js";

export const WEB_HISTORY_PAGE_SIZE = 80;
function userMarker(entry: WebEntry): WebHistoryMarker {
  return { id: entry.id,
    preview: (entry.text.replace(/\s+/gu, " ").trim() || (entry.images?.length ? "Image attachment" : "Your message")).slice(0, 120) };
}

interface PendingDecision {
  readonly request: WebDecision;
  readonly resolve: (value: string | undefined) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  readonly timed?: Readonly<TimedChoiceOptions>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Browser presentation only. Runtime decisions still pass through the existing app boundary. */
export class WebInteraction implements AppInteractionPort {
  constructor(private readonly decisionTimeoutMs = DECISION_TIMEOUT_MS) {}
  private entries: WebEntry[] = [];
  private readonly entryById = new Map<string, WebEntry>();
  private userMarkers: WebHistoryMarker[] = [];
  private historyEpoch = randomUUID();
  private session: UISessionInfo | null = null;
  private tasks: TaskGraphView | null = null;
  private subagentsView: readonly SubagentView[] = [];
  private activities = new Map<string, { id: string; text: string; kind?: UIActivityKind }>();
  private pendingToolEntries: string[] = [];
  private review: WebView["review"] = null;
  private decisions: PendingDecision[] = [];
  private listeners = new Set<(change: WebChange) => void>();
  private sequence = 0;
  private busy = false;
  private closed = false;
  private reasoningNumber = 0;
  private adjustmentNumber = 0;
  private currentAnswerId?: string;
  private currentReasoningId?: string;
  private currentStreamId?: string;
  private currentStreamPhase?: AssistantPhase;
  private currentTurnId?: string;
  private currentTurnStartedAt?: number;
  private externalOperation?: AbortController;
  private language: Language = "en_us";

  setLanguage(language: Language): void { this.language = language; }

  snapshot(): WebChange { return { sequence: this.sequence, view: this.view() }; }
  historyPage(options: { before?: string; after?: string; around?: string } = {}): WebHistoryPage {
    if ([options.before, options.after, options.around].filter(Boolean).length > 1) {
      throw new Error("Choose one history cursor.");
    }
    let start = Math.max(0, this.entries.length - WEB_HISTORY_PAGE_SIZE);
    let end = this.entries.length;
    if (options.before) {
      end = this.entries.findIndex(entry => entry.id === options.before);
      if (end < 0) throw new Error("History cursor is no longer available.");
      start = Math.max(0, end - WEB_HISTORY_PAGE_SIZE);
    } else if (options.after) {
      const index = this.entries.findIndex(entry => entry.id === options.after);
      if (index < 0) throw new Error("History cursor is no longer available.");
      start = index + 1;
      end = Math.min(this.entries.length, start + WEB_HISTORY_PAGE_SIZE);
    } else if (options.around) {
      const index = this.entries.findIndex(entry => entry.id === options.around);
      if (index < 0) throw new Error("History target is no longer available.");
      start = Math.max(0, index - Math.floor(WEB_HISTORY_PAGE_SIZE / 2));
      end = Math.min(this.entries.length, start + WEB_HISTORY_PAGE_SIZE);
      start = Math.max(0, end - WEB_HISTORY_PAGE_SIZE);
    }
    if (!options.after && start > 0) {
      // Keep a nearby user turn intact without allowing one huge turn to defeat paging.
      for (let index = start; index >= Math.max(0, start - 24); index -= 1) {
        if (this.entries[index]?.kind === "user") { start = index; break; }
      }
    }
    // A run of adjacent tool calls must remain one visible row, even when a
    // journal page boundary falls among status notices inside that run.
    while (start > 0 && (turnContinuesAcross(this.entries, start) || toolRunContinuesAcross(this.entries, start))) start -= 1;
    while (end < this.entries.length && (turnContinuesAcross(this.entries, end) || toolRunContinuesAcross(this.entries, end))) end += 1;
    return { entries: this.entries.slice(start, end).map(entry => ({ ...entry })),
      hasEarlier: start > 0, hasLater: end < this.entries.length };
  }
  historyState(page = this.historyPage()): WebHistoryState {
    return { epoch: this.historyEpoch, hasEarlier: page.hasEarlier,
      markers: this.userMarkers.map(marker => ({ ...marker })) };
  }
  subscribe(listener: (change: WebChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  loadHistory(entries: readonly WebEntry[]): void {
    this.entries = entries.map(entry => ({ ...entry }));
    this.pendingToolEntries = [];
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]!;
      if (entry.kind === "info" || entry.kind === "success" || entry.kind === "warning" || entry.kind === "error") continue;
      if (entry.kind === "tool" && entry.toolStatus === "running") this.pendingToolEntries.push(entry.id);
      break;
    }
    this.entryById.clear();
    for (const entry of this.entries) this.entryById.set(entry.id, entry);
    this.userMarkers = this.entries.filter(entry => entry.kind === "user").map(userMarker);
    this.historyEpoch = randomUUID();
    this.currentAnswerId = undefined;
    this.currentReasoningId = undefined;
    this.currentStreamId = undefined;
    this.currentStreamPhase = undefined;
    this.currentTurnId = undefined;
    this.currentTurnStartedAt = undefined;
    this.emit({ kind: "entries.reset", entries: this.entries });
  }
  presentUser(text: string, images: readonly ImageAttachment[] = []): void {
    this.currentTurnId = randomUUID();
    this.currentTurnStartedAt = Date.now();
    this.append("user", text, images);
  }
  resolveDecision(id: string, value: string | undefined): boolean {
    const index = this.decisions.findIndex(item => item.request.id === id);
    if (index < 0) return false;
    const pending = this.decisions[index];
    if (!pending) return false;
    if (pending.signal?.aborted && value !== undefined) return false;
    if (value !== undefined && pending.request.kind !== "secret" &&
      !(pending.request.kind === "plan" && value.startsWith("adjust:")) &&
      !pending.request.choices?.some(choice => choice.id === value && !choice.disabled)) {
      return false;
    }
    this.decisions.splice(index, 1);
    if (pending.timer) clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort!);
    pending.resolve(value);
    if (index === 0) this.armHeadDecisionTimeout();
    this.emit();
    return true;
  }
  private armHeadDecisionTimeout(): void {
    const pending = this.decisions[0];
    if (!pending?.timed || pending.timer || this.closed) return;
    const choice = pending.request.choices?.find(item => item.id === pending.timed?.idleChoiceId && !item.disabled);
    if (!choice || !Number.isSafeInteger(pending.timed.idleTimeoutMs) || pending.timed.idleTimeoutMs <= 0) return;
    pending.timer = setTimeout(() => {
      if (this.closed || pending.signal?.aborted || this.decisions[0] !== pending) return;
      this.resolveDecision(pending.request.id, choice.id);
    }, pending.timed.idleTimeoutMs);
  }
  cancelExternalOperation(): boolean {
    if (!this.externalOperation || this.externalOperation.signal.aborted) return false;
    this.externalOperation.abort();
    return true;
  }
  cancelPendingDecisions(): void {
    for (const pending of [...this.decisions]) this.resolveDecision(pending.request.id, undefined);
  }
  private view(): WebView {
    return {
      session: this.session,
      entries: this.entries,
      tasks: this.tasks,
      subagents: this.subagentsView,
      activities: [...this.activities.values()],
      review: this.review,
      decision: this.decisions[0]?.request ?? null,
      busy: this.busy,
    };
  }
  private emit(patch?: WebPatch): void {
    this.sequence += 1;
    const view = this.view();
    const change: WebChange = { sequence: this.sequence, view,
      patch: patch ?? { kind: "state", state: {
        session: view.session, tasks: view.tasks, subagents: view.subagents,
        activities: view.activities, review: view.review, decision: view.decision, busy: view.busy,
      } } };
    for (const listener of this.listeners) listener(change);
  }
  private safe(text: string): string {
    return redactSensitiveInformation(sanitizeTerminalText(text, { allowSgr: false }));
  }
  private append(kind: WebEntryKind, text: string, images?: readonly ImageAttachment[],
    toolDetails?: WebEntry["toolDetails"], toolName?: string, toolStatus?: WebEntry["toolStatus"]): string {
    const id = randomUUID();
    const entry: WebEntry = {
      id, kind, text: this.safe(text), timestamp: Date.now(),
      ...(this.currentTurnId && (kind === "user" || kind === "assistant" || kind === "thinking" || kind === "tool" || kind === "plan")
        ? { turnId: this.currentTurnId, turnStartedAt: this.currentTurnStartedAt } : {}),
      ...(images?.length ? { images: images.map(({ id, label, mediaType }) => ({ id, label, mediaType })) } : {}),
      ...(toolDetails?.length ? { toolDetails: toolDetails.map(item => ({ label: this.safe(item.label), value: this.safe(item.value) })) } : {}),
      ...(toolName ? { toolName: this.safe(toolName) } : {}),
      ...(toolStatus ? { toolStatus } : {}),
    };
    this.entries.push(entry);
    this.entryById.set(id, entry);
    if (kind === "user") this.userMarkers.push(userMarker(entry));
    this.emit({ kind: "entry.append", entry });
    return id;
  }
  private replace(id: string, text: string): void {
    const entry = this.entryById.get(id);
    if (!entry) return;
    entry.text = this.safe(text);
    this.emit({ kind: "entry.replace", entry });
  }
  private setAnswerState(id: string | undefined, state: WebEntry["answerState"]): void {
    if (!id) return;
    const entry = this.entryById.get(id);
    if (!entry || entry.kind !== "assistant" || entry.answerState === state) return;
    if (state === undefined) delete entry.answerState;
    else entry.answerState = state;
    this.emit({ kind: "entry.replace", entry });
  }
  private downgradeProvisionalAnswer(): void {
    const entry = this.currentAnswerId ? this.entryById.get(this.currentAnswerId) : undefined;
    if (entry?.answerState === "finalizing") this.setAnswerState(entry.id, "streaming");
  }
  private awaitDecision(request: WebDecision, signal?: AbortSignal,
    timed?: Readonly<TimedChoiceOptions>): Promise<string | undefined> {
    if (this.closed || signal?.aborted) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const onAbort = () => this.resolveDecision(request.id, undefined);
      this.decisions.push({ request, resolve, signal, onAbort, timed });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { this.resolveDecision(request.id, undefined); return; }
      this.armHeadDecisionTimeout();
      this.emit();
    });
  }

  write(text: string): void { this.append(this.busy ? "assistant" : "info", text); }
  info(text: string): void { this.append("info", text); }
  success(text: string): void { this.append("success", text); }
  warning(text: string): void { this.append("warning", text); }
  error(text: string): void { this.append("error", text); }
  status(_text: string): void {
    // The browser has dedicated activity, tool, task, subagent and decision
    // surfaces. Runtime progress text is transient implementation detail and
    // must not become hidden history or later leak into a command panel.
  }
  toolCompleted(toolName: string, ok: boolean, summary?: string, error?: string,
    details?: WebEntry["toolDetails"]): void {
    const text = `${ok ? "✓" : "✗"} ${toolName}${summary ? ` — ${summary}` : ""}${error ? `\n${error}` : ""}`;
    const pendingId = this.pendingToolEntries.shift();
    const pending = pendingId ? this.entryById.get(pendingId) : undefined;
    if (!pending) {
      this.append("tool", text, undefined, details, toolName, ok ? "completed" : "failed");
      return;
    }
    pending.text = this.safe(text);
    pending.toolName = this.safe(toolName);
    pending.toolStatus = ok ? "completed" : "failed";
    pending.toolDetails = details?.length
      ? details.map(item => ({ label: this.safe(item.label), value: this.safe(item.value) })) : undefined;
    this.emit({ kind: "entry.replace", entry: pending });
  }
  threadTitleChanged(title: string): void {
    if (this.session) this.emit({ kind: "thread.title", threadId: this.session.threadId, title: this.safe(title) });
  }
  fileDiff(_presentation: FileDiffPresentation): void {
    // Tool summaries remain visible; source before/after previews are not sent to the Web transcript.
  }
  taskGraph(graph: Readonly<TaskGraphView>): void {
    this.tasks = graph.status === "completed" ? null : { ...graph };
    this.emit();
  }
  showTaskGraphSnapshot(graph: Readonly<TaskGraphView>): void {
    this.append("info", `Tasks ${graph.completed}/${graph.total}\n${graph.tasks.map(task => `${task.status === "completed" ? "✓" : "○"} ${task.title} (${task.status})`).join("\n")}`);
  }
  clearTaskGraph(): void { this.tasks = null; this.emit(); }
  subagents(agents: readonly Readonly<SubagentView>[]): void {
    this.subagentsView = agents.map(agent => ({ ...agent })); this.emit();
  }
  showSubagentsSnapshot(agents: readonly Readonly<SubagentView>[]): void {
    this.append("info", agents.length
      ? `Subagents\n${agents.map(agent => `${agent.status}: ${agent.taskTitle} (${agent.id})`).join("\n")}`
      : "No subagents in this Thread.");
  }
  modelStream(event: Readonly<ProviderStreamEvent>): void {
    if (event.kind === "started") {
      this.downgradeProvisionalAnswer();
      this.currentStreamId = event.streamId;
      this.currentAnswerId = undefined;
      this.currentReasoningId = undefined;
      this.currentStreamPhase = undefined;
    } else if (event.streamId !== this.currentStreamId) {
      return;
    } else if (event.kind === "assistant_phase") {
      this.currentStreamPhase = event.phase;
      this.setAnswerState(this.currentAnswerId, event.phase === "final_answer" ? "finalizing" : "streaming");
    } else if (event.kind === "reasoning_delta") {
      if (!this.currentReasoningId) this.currentReasoningId = this.append("thinking", "");
      const entry = this.entryById.get(this.currentReasoningId);
      this.replace(this.currentReasoningId, (entry?.text ?? "") + event.text);
    } else if (event.kind === "text_delta") {
      if (!this.currentAnswerId) this.currentAnswerId = this.append("assistant", "");
      this.setAnswerState(this.currentAnswerId, this.currentStreamPhase === "final_answer" ? "finalizing" : "streaming");
      const entry = this.entryById.get(this.currentAnswerId);
      this.replace(this.currentAnswerId, (entry?.text ?? "") + event.text);
    } else if (event.kind === "tool_call_delta") {
      if (this.currentStreamPhase === "final_answer") {
        this.downgradeProvisionalAnswer();
        this.currentStreamPhase = undefined;
      }
    } else if (event.kind === "interrupted") {
      this.downgradeProvisionalAnswer();
      this.currentAnswerId = undefined;
      this.currentReasoningId = undefined;
      this.currentStreamPhase = undefined;
    }
  }
  addReasoning(text: string): number {
    const id = ++this.reasoningNumber;
    if (this.currentReasoningId) this.replace(this.currentReasoningId, text);
    else this.append("thinking", text);
    this.currentReasoningId = undefined;
    return id;
  }
  restoreReasoning(texts: readonly string[]): number {
    for (const text of texts) this.append("thinking", text);
    this.reasoningNumber += texts.length;
    return this.reasoningNumber;
  }
  showReasoning(id: number | "last"): boolean {
    const entries = this.entries.filter(entry => entry.kind === "thinking");
    return id === "last" ? entries.length > 0 : Boolean(entries[id - 1]);
  }
  showAdjustment(id: number | "last"): boolean {
    return id === "last" ? this.adjustmentNumber > 0 : id > 0 && id <= this.adjustmentNumber;
  }
  addQueuedAdjustment(sequence: number, text: string, images: readonly Readonly<ImageAttachment>[] = []): void {
    this.adjustmentNumber = Math.max(sequence, this.adjustmentNumber);
    this.append("user", text, images as ImageAttachment[]);
  }
  finalizeStreamedAnswer(text: string, timing?: Readonly<CompletedTurnTiming>): boolean {
    const completedAt = timing?.completedAt ?? Date.now();
    const answerId = this.currentAnswerId ?? this.append("assistant", text);
    const answer = this.entryById.get(answerId);
    if (answer) {
      answer.text = this.safe(text);
      const downgraded: WebEntry[] = [];
      for (const entry of this.entries) {
        if (entry.turnId === answer.turnId && entry.kind === "assistant" && entry.id !== answer.id &&
            entry.answerState === "finalizing") {
          entry.answerState = "streaming";
          downgraded.push(entry);
        }
      }
      for (const entry of downgraded) this.emit({ kind: "entry.replace", entry });
      answer.answerState = "confirmed";
      if (timing) answer.turnStartedAt = timing.startedAt;
      answer.turnCompletedAt = completedAt;
      this.emit({ kind: "entry.replace", entry: answer });
    }
    this.currentAnswerId = undefined;
    this.currentReasoningId = undefined;
    this.currentStreamPhase = undefined;
    return true;
  }
  startActivity(text: string, kind?: UIActivityKind, toolName?: string): string {
    const id = randomUUID(); this.activities.set(id, { id, text, kind }); this.emit();
    if (kind === "tool" && toolName) {
      const pending = this.entryById.get(this.pendingToolEntries[0] ?? "");
      if (pending?.toolName !== toolName || pending.toolStatus !== "running") {
        this.interruptPendingTools();
        this.pendingToolEntries.push(this.append("tool", `Calling ${toolName}`, undefined,
          undefined, toolName, "running"));
      }
    }
    return id;
  }
  stopActivity(activityId?: string): void {
    if (activityId) this.activities.delete(activityId); else this.activities.clear();
    this.emit();
  }
  startReview(): string {
    const id = randomUUID(); this.review = { id, phase: "main_brief", startedAt: Date.now() }; this.emit(); return id;
  }
  updateReview(id: string, phase: UIReviewPhase): void {
    if (this.review?.id !== id) return; this.review = { ...this.review, phase }; this.emit();
  }
  stopReview(id?: string): void {
    if (id && this.review?.id !== id) return; this.review = null; this.emit();
  }
  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    const value = await this.awaitDecision({
      id: randomUUID(), kind: "approval", title: this.safe(request.title),
      description: this.safe(`${request.description}\n${request.commandPreview ?? ""}\n${request.network ? `Network: ${request.network.effect} ${request.network.destination ?? ""}` : ""}`),
      choices: [
        { id: "reject", label: translate(this.language, "ui.reject") },
        { id: "allow_once", label: translate(this.language, "cli.allowOnce") },
        ...(canGrantCommandPrefix(request.commandPrefix)
          ? [{ id: "allow_prefix", label: translate(this.language, "cli.allowThread"), detail: this.safe(formatCommandApprovalPrefix(request.commandPrefix)) }]
          : []),
      ],
    }, request.signal, { idleTimeoutMs: this.decisionTimeoutMs, idleChoiceId: "allow_once" });
    return value === "allow_once" || value === "allow_prefix" ? value : "reject";
  }
  selectChoice(title: string, choices: readonly InteractionChoice[], initialId?: string,
    timed?: Readonly<TimedChoiceOptions>): Promise<string | undefined> {
    return this.awaitDecision({ id: randomUUID(), kind: "choice", title: this.safe(title), choices,
      ...(initialId ? { initialId } : {}) }, timed?.signal, timed);
  }
  selectProvider(choices: readonly ProviderSelectorChoice[], initialProvider: ProviderSelectorChoice["provider"]): Promise<ProviderSelectorChoice["provider"] | undefined> {
    return this.selectChoice(translate(this.language, "cli.providerSelect"), choices.map(item => ({ id: item.provider, label: item.label,
      detail: translate(this.language, item.apiKeyConfigured ? "cli.apiConfigured" : "cli.apiRequired") })), initialProvider) as Promise<ProviderSelectorChoice["provider"] | undefined>;
  }
  selectModel(providerName: string, choices: readonly ModelSelectorChoice[], initialModel?: string): Promise<string | undefined> {
    return this.selectChoice(translate(this.language, "cli.modelSelect", { provider: providerName }), choices.map(item => ({ id: item.id, label: item.label,
      detail: item.vision ? `Vision: ${JSON.stringify(item.vision)}` : undefined })), initialModel);
  }
  selectThinkingEffort(providerName: string, model: string, choices: readonly ThinkingEffortSelectorChoice[], initialEffort: ThinkingEffort): Promise<ThinkingEffort | undefined> {
    return this.selectChoice(translate(this.language, "cli.effortSelect", { provider: providerName, model }), choices.map(item => ({ id: item.id, label: item.label,
      detail: translate(this.language, item.applied ? "cli.applied" : "cli.savedNotApplied") })), initialEffort) as Promise<ThinkingEffort | undefined>;
  }
  async readSecret(prompt: string): Promise<string> {
    return await this.awaitDecision({ id: randomUUID(), kind: "secret", title: this.safe(prompt) }) ?? "";
  }
  showPlan(_plan: Readonly<PlanProposal>): void {
    // AgentRuntime already presents the complete plan as its final assistant
    // response. The browser reads the authoritative pending proposal through
    // /api/state for its review controls, so adding another transcript entry
    // here would duplicate the plan and expose its transport JSON.
  }
  async reviewPlan(options?: Readonly<PlanReviewInputOptions>): Promise<PlanReviewDecision> {
    void options;
    const value = await this.awaitDecision({ id: randomUUID(), kind: "plan", title: translate(this.language, "cli.reviewPlan"),
      choices: [{ id: "approve", label: translate(this.language, "ui.approveRun") }, { id: "reject", label: translate(this.language, "ui.reject") },
        { id: "adjust", label: translate(this.language, "ui.requestChanges") }] },
      undefined, { idleTimeoutMs: this.decisionTimeoutMs, idleChoiceId: "approve" });
    if (value?.startsWith("adjust:")) return { action: "adjust", feedback: value.slice(7) };
    return value === "approve" || value === "reject" ? { action: value } : { action: "defer" };
  }
  async withCancellableExternalOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); this.externalOperation = controller;
    try { return await operation(controller.signal); }
    finally { if (this.externalOperation === controller) this.externalOperation = undefined; }
  }
  configureStreaming(): void {}
  setContextTokensProvider(): void {}
  isInteractive(): boolean { return true; }
  beginShell(session: Readonly<UISessionInfo>): boolean { this.setSessionInfo(session); return true; }
  isInlineShell(): boolean { return true; }
  setSessionInfo(session: Readonly<UISessionInfo>): void { this.session = { ...session }; this.emit(); }
  showSessionHeader(): void {}
  readPrompt(_prompt: string, _options: RequestInputOptions): Promise<UserSubmission | null> {
    throw new Error("The Web host submits messages through the session API.");
  }
  setCurrentRequest(_text: string, _images?: readonly Readonly<ImageAttachment>[], _options?: Readonly<CurrentRequestOptions>): void {
    if (!this.currentTurnId) {
      this.currentTurnId = randomUUID();
      this.currentTurnStartedAt = Date.now();
    }
    this.busy = true; this.emit();
  }
  private interruptPendingTools(): void {
    for (const id of this.pendingToolEntries) {
      const entry = this.entryById.get(id);
      if (!entry || entry.toolStatus !== "running") continue;
      entry.toolStatus = "failed";
      entry.text = this.safe(`✗ ${entry.toolName ?? "Tool"} — interrupted`);
      this.emit({ kind: "entry.replace", entry });
    }
    this.pendingToolEntries = [];
  }
  clearCurrentRequest(): void {
    this.downgradeProvisionalAnswer();
    if (this.currentTurnId && !this.entries.some(entry => entry.turnId === this.currentTurnId && entry.turnCompletedAt !== undefined)) {
      const terminal = [...this.entries].reverse().find(entry => entry.turnId === this.currentTurnId);
      if (terminal) {
        terminal.turnCompletedAt = Date.now();
        this.emit({ kind: "entry.replace", entry: terminal });
      }
    }
    this.busy = false;
    this.activities.clear();
    this.review = null;
    this.interruptPendingTools();
    this.currentAnswerId = undefined;
    this.currentReasoningId = undefined;
    this.currentStreamId = undefined;
    this.currentStreamPhase = undefined;
    this.currentTurnId = undefined;
    this.currentTurnStartedAt = undefined;
    this.emit();
  }
  async sealCurrentRequestSteering<T>(seal: () => T | undefined | Promise<T | undefined>): Promise<T | undefined> { return seal(); }
  resetForNewThread(session: Readonly<UISessionInfo>): void {
    this.entries = []; this.tasks = null; this.subagentsView = []; this.activities.clear(); this.review = null;
    this.pendingToolEntries = [];
    this.currentAnswerId = undefined; this.currentReasoningId = undefined; this.currentStreamId = undefined; this.currentStreamPhase = undefined;
    this.currentTurnId = undefined; this.currentTurnStartedAt = undefined;
    this.entryById.clear();
    this.userMarkers = [];
    this.historyEpoch = randomUUID();
    this.session = { ...session };
    this.emit({ kind: "entries.reset", entries: [] });
    this.emit();
  }
  clearHostedSession(): void {
    this.entries = []; this.tasks = null; this.subagentsView = []; this.activities.clear(); this.review = null;
    this.pendingToolEntries = [];
    this.currentAnswerId = undefined; this.currentReasoningId = undefined; this.currentStreamId = undefined; this.currentStreamPhase = undefined;
    this.currentTurnId = undefined; this.currentTurnStartedAt = undefined;
    this.entryById.clear();
    this.userMarkers = [];
    this.historyEpoch = randomUUID();
    this.session = null; this.busy = false; this.cancelPendingDecisions();
    this.emit({ kind: "entries.reset", entries: [] });
    this.emit();
  }
  clearScreen(): void { this.entries = []; this.entryById.clear(); this.userMarkers = []; this.pendingToolEntries = []; this.currentAnswerId = undefined; this.currentReasoningId = undefined; this.currentStreamId = undefined; this.currentStreamPhase = undefined; this.currentTurnId = undefined; this.currentTurnStartedAt = undefined; this.historyEpoch = randomUUID(); this.emit({ kind: "entries.reset", entries: [] }); }
  emergencyRestore(): void { this.clearCurrentRequest(); }
  close(): void {
    this.closed = true; this.externalOperation?.abort();
    this.cancelPendingDecisions();
    this.listeners.clear();
  }
}
