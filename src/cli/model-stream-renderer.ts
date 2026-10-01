import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import type { ProviderStreamEvent } from "../core/types.js";
import type { UITranscriptEntry } from "../ui/contracts.js";
import {
  prepareReasoningText,
  renderReasoningMarker,
  type ReasoningBlock,
  type ReasoningRegistry,
} from "./reasoning.js";
import { formatAssistantText } from "./transcript-format.js";

/** What the stream renderer needs from the Terminal that owns the transcript document. */
export interface ModelStreamHost {
  readonly reasoning: ReasoningRegistry;
  isClosed(): boolean;
  /** Streaming renders only into the managed inline document of an interactive shell. */
  canStreamIntoDocument(): boolean;
  hasDisclosureDocument(): boolean;
  activeActivityId(): string | undefined;
  /** Show streamed tool-argument progress as the label of the active activity. */
  showToolArgumentProgress(text: string): void;
  colorEnabled(): boolean;
  safeInline(value: string, maximum: number): string;
  safeStreamText(value: string): string;
  commitTranscript(entry: Readonly<UITranscriptEntry>): void;
  replaceTranscriptEntry(id: string, entry: Readonly<UITranscriptEntry>): void;
  retainCurrentTurnDisclosure(entry: Readonly<UITranscriptEntry>, reasoning: Readonly<ReasoningBlock>): void;
  retainReasoningDisclosure(entryId: string, block: Readonly<ReasoningBlock>): void;
  refreshDisclosureViewer(nodesChanged: boolean): void;
  failTerminalUi(stage: string, value: unknown): void;
}

interface ActiveModelStream {
  readonly streamId: string;
  /** Activity that owned this provider request when streaming began. */
  readonly activityId?: string;
  reasoningText: string;
  answerText: string;
  reasoningId?: number;
  reasoningEntryId?: string;
  answerEntryId?: string;
  toolCallSeen: boolean;
  readonly toolCalls: Map<number, { name: string; argumentChars: number }>;
  toolProgressDirty: boolean;
  completed: boolean;
  sequence: number;
  pendingReasoning: string[];
  pendingText: string[];
  finalDisplay: boolean;
  renderedReasoning?: string;
  renderedAnswer?: string;
  reasoningSourceChars: number;
  reasoningLastDeltaAtMs?: number;
  renderedReasoningProgressKey?: string;
}

/**
 * Projects transient provider deltas into stable, in-place transcript nodes. Provider deltas are a
 * replaceable projection; only the Runtime's assembled messages are durable, so a completed stream
 * leaves candidates that the final reasoning and answer are reconciled against.
 */
export class ModelStreamRenderer {
  private readonly streams = new Map<string, ActiveModelStream>();
  private flushTimer?: NodeJS.Timeout;
  private flushIntervalMs = DEFAULT_RUNTIME_LIMITS.streamFlushIntervalMs;
  private previewMaxChars = DEFAULT_RUNTIME_LIMITS.streamPreviewMaxChars;
  private batchRendering = false;
  private documentDirty = false;
  private answerCandidate?: Readonly<{
    streamId: string;
    entryId: string;
    text: string;
  }>;
  private reasoningCandidate?: Readonly<{
    streamId: string;
    id: number;
    text: string;
  }>;

  constructor(private readonly host: ModelStreamHost) {}

  configure(limits: { streamFlushIntervalMs: number; streamPreviewMaxChars: number }): void {
    this.flushIntervalMs = limits.streamFlushIntervalMs;
    this.previewMaxChars = limits.streamPreviewMaxChars;
  }

  get previewLimitChars(): number {
    return this.previewMaxChars;
  }

  /** Drop in-flight streams and any pending flush. */
  reset(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.streams.clear();
  }

  /** Drop in-flight streams and the candidates that final messages would be reconciled against. */
  forget(): void {
    this.reset();
    this.answerCandidate = undefined;
    this.reasoningCandidate = undefined;
  }

  /** While a flush renders many nodes, defer disclosure repaints until it ends. Returns whether deferred. */
  deferDocumentRefresh(nodesChanged: boolean): boolean {
    if (!this.batchRendering) return false;
    this.documentDirty ||= nodesChanged;
    return true;
  }

  /** The live stream still writing into a Thinking block, if any. */
  activeReasoningStream(
    blockId: number,
  ): Readonly<{ reasoningSourceChars: number; reasoningLastDeltaAtMs?: number }> | undefined {
    return [...this.streams.values()].find((state) => !state.completed && state.reasoningId === blockId);
  }

  /** The Thinking block already streamed for this final reasoning text, consumed once. */
  consumeStreamedReasoning(text: string): number | undefined {
    const streamed = this.reasoningCandidate;
    if (streamed && prepareReasoningText(text).text === streamed.text) {
      this.reasoningCandidate = undefined;
      return streamed.id;
    }
    return undefined;
  }

  onEvent(event: Readonly<ProviderStreamEvent>): void {
    if (this.host.isClosed()) return;
    if (event.kind === "started") {
      this.flush();
      this.apply(event);
      return;
    }
    const state = this.streams.get(event.streamId);
    if (!state || state.completed || event.sequence <= state.sequence) return;
    state.sequence = event.sequence;
    // Assistant phase is a Web presentation hint. CLI transcript behavior stays unchanged.
    if (event.kind === "assistant_phase") return;
    if (event.kind === "reasoning_delta" || event.kind === "text_delta") {
      if (event.kind === "reasoning_delta") {
        state.reasoningSourceChars += countCodePoints(event.text);
        state.reasoningLastDeltaAtMs = Date.now();
      }
      (event.kind === "reasoning_delta" ? state.pendingReasoning : state.pendingText).push(event.text);
      this.scheduleFlush();
      return;
    }
    if (event.kind === "tool_call_delta") {
      this.apply(event);
      this.scheduleFlush();
      return;
    }
    this.flush(event.kind === "completed" ? event.streamId : undefined);
    this.apply(event);
  }

  /** Reconcile the streamed final node with the Runtime's assembled result. */
  finalizeAnswer(text: string): boolean {
    const candidate = this.answerCandidate;
    this.answerCandidate = undefined;
    if (!candidate || !this.host.hasDisclosureDocument()) return false;
    const complete = this.host.safeStreamText(text).trim();
    if (!complete) return false;
    this.host.replaceTranscriptEntry(candidate.entryId, {
      kind: "assistant",
      id: candidate.entryId,
      text: `\n${formatAssistantText(complete, this.host.colorEnabled())}\n\n`,
    });
    this.streams.delete(candidate.streamId);
    return true;
  }

  refreshLiveReasoningProgress(nowMs = Date.now()): void {
    for (const state of this.streams.values()) {
      this.renderLiveReasoningProgress(state, nowMs);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      try {
        this.flush();
      } catch (error) {
        this.forget();
        this.host.failTerminalUi("stream renderer", error);
      }
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  private flush(finalStreamId?: string): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.batchRendering = true;
    try {
      for (const state of this.streams.values()) {
        if (state.completed) continue;
        state.finalDisplay = state.streamId === finalStreamId;
        for (const kind of ["reasoning_delta", "text_delta"] as const) {
          const pending = kind === "reasoning_delta" ? state.pendingReasoning : state.pendingText;
          const retained = kind === "reasoning_delta" ? state.reasoningText : state.answerText;
          if (!pending.length && !(state.finalDisplay && retained)) continue;
          const text = pending.join("");
          pending.length = 0;
          this.apply({ kind, streamId: state.streamId, sequence: state.sequence, text });
        }
        if (state.toolProgressDirty) this.renderToolProgress(state);
      }
    } finally {
      this.batchRendering = false;
      if (this.documentDirty) {
        this.documentDirty = false;
        this.host.refreshDisclosureViewer(true);
      }
    }
  }

  private renderToolProgress(state: ActiveModelStream): void {
    state.toolProgressDirty = false;
    const calls = [...state.toolCalls.entries()].sort(([left], [right]) => left - right);
    const activeActivityId = this.host.activeActivityId();
    if (!calls.length || !activeActivityId || state.activityId !== activeActivityId) return;
    const parts = calls.slice(0, 2).map(([index, call]) => {
      const name = this.host.safeInline(call.name || "tool", 48);
      const size =
        call.argumentChars < 1024
          ? `${call.argumentChars} chars`
          : `${(call.argumentChars / 1024).toFixed(call.argumentChars < 10 * 1024 ? 1 : 0)} KiB`;
      return `${name} #${index + 1} · ${size}`;
    });
    const remaining = calls.length - parts.length;
    this.host.showToolArgumentProgress(
      `Preparing ${parts.join("; ")}${remaining > 0 ? `; +${remaining} more` : ""} arguments`,
    );
  }

  private liveStreamText(value: string, final: boolean, includeLimitNotice = true): string {
    if (final) return this.host.safeStreamText(value);
    const prefix = value.slice(0, this.previewMaxChars);
    // Hold the unfinished lexical token (including credentials, data URLs and
    // terminal escape fragments) until a whitespace boundary is available.
    const boundary = Math.max(
      prefix.lastIndexOf(" "),
      prefix.lastIndexOf("\n"),
      prefix.lastIndexOf("\t"),
      ...["。", "，", "！", "？", "；"].map((mark) => prefix.lastIndexOf(mark)),
    );
    const safe = this.host.safeStreamText(prefix.slice(0, Math.max(0, boundary + 1)));
    return includeLimitNotice && value.length > this.previewMaxChars
      ? `${safe}\n[Live preview limited; complete output will appear when the response finishes.]`
      : safe;
  }

  /**
   * Update only the small Thinking marker after its body reaches the live
   * preview cap. The complete provider text remains assembled in the stream
   * state for final reconciliation, but is not repeatedly sanitized or
   * projected into the terminal document.
   */
  private renderLiveReasoningProgress(state: ActiveModelStream, nowMs = Date.now()): void {
    if (
      state.completed ||
      state.finalDisplay ||
      state.reasoningSourceChars <= this.previewMaxChars ||
      state.reasoningLastDeltaAtMs === undefined ||
      !state.reasoningId ||
      !state.reasoningEntryId
    )
      return;
    const ageBucket = Math.floor(Math.max(0, nowMs - state.reasoningLastDeltaAtMs) / 100);
    const progressKey = `${state.reasoningSourceChars}:${ageBucket}`;
    if (state.renderedReasoningProgressKey === progressKey) return;
    const block = this.host.reasoning.get(state.reasoningId);
    if (!block) return;
    state.renderedReasoningProgressKey = progressKey;
    this.host.retainReasoningDisclosure(state.reasoningEntryId, block);
    this.host.replaceTranscriptEntry(state.reasoningEntryId, {
      kind: "raw",
      id: state.reasoningEntryId,
      text: renderReasoningMarker(block, {
        color: this.host.colorEnabled(),
        live: {
          sourceChars: state.reasoningSourceChars,
          previewLimitChars: this.previewMaxChars,
          lastDeltaAtMs: state.reasoningLastDeltaAtMs,
          nowMs,
        },
      }),
      reasoning: block.text,
    });
  }

  /** The Thinking marker for a streaming block: live progress until the stream is final. */
  private reasoningMarker(block: Readonly<ReasoningBlock>, state: ActiveModelStream): string {
    return renderReasoningMarker(block, {
      color: this.host.colorEnabled(),
      ...(state.finalDisplay || state.reasoningLastDeltaAtMs === undefined
        ? {}
        : {
            live: {
              sourceChars: state.reasoningSourceChars,
              previewLimitChars: this.previewMaxChars,
              lastDeltaAtMs: state.reasoningLastDeltaAtMs,
            },
          }),
    });
  }

  private apply(event: Readonly<ProviderStreamEvent>): void {
    // Small/non-TTY terminals retain the existing atomic final-answer path.
    // Streaming is enabled only when the managed document can replace nodes
    // without corrupting ordinary terminal scrollback.
    if (!this.host.canStreamIntoDocument()) return;

    if (event.kind === "started") {
      for (const [streamId, state] of this.streams) {
        if (state.completed) this.streams.delete(streamId);
      }
      this.answerCandidate = undefined;
      const activityId = this.host.activeActivityId();
      this.streams.set(event.streamId, {
        streamId: event.streamId,
        ...(activityId ? { activityId } : {}),
        reasoningText: "",
        answerText: "",
        toolCallSeen: false,
        toolCalls: new Map(),
        toolProgressDirty: false,
        completed: false,
        sequence: event.sequence,
        pendingReasoning: [],
        pendingText: [],
        finalDisplay: false,
        reasoningSourceChars: 0,
      });
      return;
    }

    const state = this.streams.get(event.streamId);
    if (!state || event.sequence <= 1) return;

    if (event.kind === "reasoning_delta") {
      this.applyReasoningDelta(state, event.text);
      return;
    }

    if (event.kind === "text_delta") {
      const previewWasFull = state.answerText.length > this.previewMaxChars;
      state.answerText += event.text;
      if (previewWasFull && state.renderedAnswer && !state.finalDisplay) return;
      const safe = this.liveStreamText(state.answerText, state.finalDisplay);
      if (!safe || safe === state.renderedAnswer) return;
      state.renderedAnswer = safe;
      if (!state.answerEntryId) {
        state.answerEntryId = `model_stream_${event.streamId}_answer`;
        this.host.commitTranscript({
          kind: "assistant",
          id: state.answerEntryId,
          text: `\n${formatAssistantText(safe, this.host.colorEnabled())}`,
        });
      } else {
        this.host.replaceTranscriptEntry(state.answerEntryId, {
          kind: "assistant",
          id: state.answerEntryId,
          text: `\n${formatAssistantText(safe, this.host.colorEnabled())}`,
        });
      }
      return;
    }

    if (event.kind === "tool_call_delta") {
      state.toolCallSeen = true;
      const current = state.toolCalls.get(event.index) ?? { name: "", argumentChars: 0 };
      if (event.name) current.name += event.name;
      if (event.arguments) current.argumentChars += event.arguments.length;
      state.toolCalls.set(event.index, current);
      state.toolProgressDirty = true;
      return;
    }

    if (event.kind === "completed") {
      state.completed = true;
      if (state.reasoningId) {
        const block = this.host.reasoning.get(state.reasoningId);
        if (block) {
          this.reasoningCandidate = {
            streamId: event.streamId,
            id: block.id,
            text: block.text,
          };
        }
      }
      if (!state.toolCallSeen && state.answerEntryId && ["stop", null, undefined].includes(event.finishReason)) {
        this.answerCandidate = {
          streamId: event.streamId,
          entryId: state.answerEntryId,
          text: this.host.safeStreamText(state.answerText),
        };
      }
      return;
    }

    if (event.kind === "interrupted") this.applyInterrupted(state, event.streamId);
  }

  private applyReasoningDelta(state: ActiveModelStream, text: string): void {
    const previewWasFull = state.reasoningText.length > this.previewMaxChars;
    state.reasoningText += text;
    if (previewWasFull && state.reasoningId && !state.finalDisplay) {
      this.renderLiveReasoningProgress(state);
      return;
    }
    const safeReasoning = state.finalDisplay
      ? this.liveStreamText(state.reasoningText, true)
      : this.liveStreamText(state.reasoningText, false, false);
    if (!safeReasoning && state.reasoningSourceChars <= this.previewMaxChars) return;
    if (safeReasoning === state.renderedReasoning && state.reasoningId) {
      this.renderLiveReasoningProgress(state);
      return;
    }
    state.renderedReasoning = safeReasoning;
    if (!state.reasoningId) {
      const block = this.host.reasoning.add(safeReasoning);
      const entryId = `thinking_${block.id}`;
      state.reasoningId = block.id;
      state.reasoningEntryId = entryId;
      this.host.retainCurrentTurnDisclosure(
        {
          kind: "raw",
          id: entryId,
          text: this.reasoningMarker(block, state),
          reasoning: block.text,
        },
        block,
      );
      return;
    }
    const block = this.host.reasoning.replace(state.reasoningId, safeReasoning);
    if (block && state.reasoningEntryId) {
      this.host.retainReasoningDisclosure(state.reasoningEntryId, block);
      this.host.replaceTranscriptEntry(state.reasoningEntryId, {
        kind: "raw",
        id: state.reasoningEntryId,
        text: this.reasoningMarker(block, state),
        reasoning: block.text,
      });
    }
  }

  private applyInterrupted(state: ActiveModelStream, streamId: string): void {
    const interrupted = state.toolCallSeen
      ? "[Interrupted model response; streamed tool arguments were incomplete and were not executed.]"
      : "[Interrupted model response; not a completed answer.]";
    if (state.reasoningId && state.reasoningEntryId) {
      const block = this.host.reasoning.replace(state.reasoningId, this.host.safeStreamText(state.reasoningText));
      if (block)
        this.host.replaceTranscriptEntry(state.reasoningEntryId, {
          kind: "raw",
          id: state.reasoningEntryId,
          text: `${renderReasoningMarker(block, { color: this.host.colorEnabled() })} [interrupted]`,
          reasoning: block.text,
        });
    }
    if (state.answerEntryId) {
      this.host.replaceTranscriptEntry(state.answerEntryId, {
        kind: "assistant",
        id: state.answerEntryId,
        text: `\n${formatAssistantText(`${state.renderedAnswer ?? ""}\n${interrupted}`, this.host.colorEnabled())}\n`,
      });
    } else {
      this.host.commitTranscript({
        kind: "raw",
        id: `model_stream_${streamId}_interrupted`,
        text: `${interrupted}\n`,
      });
    }
    state.completed = true;
    this.streams.delete(streamId);
    if (this.answerCandidate?.streamId === streamId) {
      this.answerCandidate = undefined;
    }
    if (this.reasoningCandidate?.streamId === streamId) {
      this.reasoningCandidate = undefined;
    }
  }
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}
