import type { ChatMessage, SessionState, ToolDefinition } from "../core/types.js";
import {
  MAX_IMAGES_PER_MODEL_REQUEST,
  MAX_TOTAL_IMAGE_BYTES_PER_MODEL_REQUEST,
  MAX_TOTAL_IMAGE_PIXELS_PER_MODEL_REQUEST,
} from "../images/image-store.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { loadPromptBundleCatalog } from "../prompt-bundle/index.js";
import { sha256 } from "../utils/hash.js";
import { projectModelInputMessages } from "./micro-compaction.js";
import { runtimeContinuityMessage } from "./runtime-state.js";
import { reconciliationPending } from "./reconciliation.js";
import { pressureProjectedMessages } from "./pressure-projection.js";
import { requestTokens, tokenBudget, type TokenBudget } from "./token-budget.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";

export const MAX_CONTEXT_SUMMARY_CHARS = 12_000;
/**
 * Maximum projected recent conversation considered for a provider request.
 * Older evidence remains durable and is recovered through the Thread-private
 * index.
 */
export const MAX_ACTIVE_WORKING_SET_CHARS = DEFAULT_RUNTIME_LIMITS.maxActiveContextChars;
export const CONTEXT_COMPACTION_SUGGEST_RATIO = 0.6;
export const CONTEXT_COMPACTION_REQUIRE_RATIO = 0.8;
export const CONTEXT_COMPACTION_FORCE_RATIO = 0.9;

export type ContextPressureLevel = "normal" | "suggest" | "require" | "force";

export function contextPressureLevel(utilization: number): ContextPressureLevel {
  const normalized = Number.isNaN(utilization) ? 0 : Math.max(0, utilization);
  if (normalized >= CONTEXT_COMPACTION_FORCE_RATIO) return "force";
  if (normalized >= CONTEXT_COMPACTION_REQUIRE_RATIO) return "require";
  if (normalized >= CONTEXT_COMPACTION_SUGGEST_RATIO) return "suggest";
  return "normal";
}

/**
 * Effective capacity of the projected active conversation. Provider context
 * may be larger, but the local working set is deliberately capped so older
 * evidence can move to the Thread-private retrieval layer.
 */
export function activeWorkingSetCharBudget(maxContextChars: number, activeLimit = MAX_ACTIVE_WORKING_SET_CHARS): number {
  if (!Number.isSafeInteger(maxContextChars) || maxContextChars < 1) {
    throw new RangeError("maxContextChars must be a positive safe integer");
  }
  return Math.min(maxContextChars, activeLimit);
}

export interface ContextBuildInput {
  systemPrompt: string;
  /** Changing retrieval/checkpoint data belongs after the stable history. */
  runtimeContext?: string;
  state: Readonly<SessionState>;
  maxContextChars: number;
  longTermMemories?: string[];
  /**
   * Optional fixed system-message occupancy used while retrieved evidence is
   * being selected. The final build uses the same reservation, so retrieval
   * and raw-message selection cannot leave a gap or duplicate a boundary row.
   */
  reservedSystemPromptChars?: number;
}

export interface ContextInspectionBuildBudget {
  /** Exact system prompt that will be sent for this request. */
  systemPrompt: string;
  /** The same optional reservation passed to build(). */
  reservedSystemPromptChars?: number;
}

export interface ContextInspection {
  messageCount: number;
  /** Full canonical Thread history, including content omitted from model input. */
  durableHistoryChars: number;
  /** Canonical, uncompacted messages after the durable compaction boundary. */
  durableActiveChars: number;
  /** Provider projection before the rolling working-set selector is applied. */
  projectedActiveChars: number;
  /** Backwards-compatible alias for durableHistoryChars. */
  estimatedChars: number;
  configuredBudgetChars: number;
  budgetChars: number;
  summaryChars: number;
  compactedMessageCount: number;
  activeMessageCount: number;
  imageCount: number;
  imageBytes: number;
  estimatedVisionTokens: number;
  /** Backwards-compatible alias for projectedActiveChars. */
  estimatedShortTermChars: number;
  estimatedShortTermTokens: number;
  utilization: number;
  pressure: ContextPressureLevel;
}

export interface ProviderRequestContextInspection extends ContextInspection {
  estimatedInputTokens?: number;
  inputTokenCapacity?: number;
  outputTokenReserve?: number;
  providerMessageCount: number;
  providerMessageChars: number;
  providerToolDefinitionChars: number;
  /** Exact character estimate used for request-pressure decisions. */
  providerInputChars: number;
  /** Local prefix diagnostics, not a claim of provider cache hits. */
  hasPrefixBaseline?: boolean;
  unchangedPrefixChars?: number;
  previousSerializedChars?: number;
}

export interface ProviderRequestInspectionInput {
  state: SessionState;
  maxContextChars: number;
  /** Final messages prepared for the provider, including the system message. */
  messages: readonly ChatMessage[];
  /** Final tool definitions exposed on the same provider request. */
  tools?: readonly ToolDefinition[];
}

function messageChars(message: ChatMessage): number {
  let size = message.content?.length ?? 0;
  if (message.role === "assistant" && message.tool_calls) {
    size += JSON.stringify(message.tool_calls).length;
  }
  if (message.role === "assistant" && message.reasoning_content) {
    size += message.reasoning_content.length;
  }
  return size + 32;
}

/** Shared request estimator used by ContextManager, Runtime telemetry, and tests. */
export function estimateMessagesChars(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + messageChars(message), 0);
}

/** Account for the provider-visible JSON schema surface beside chat messages. */
export function estimateToolDefinitionsChars(
  tools: readonly ToolDefinition[] | undefined,
): number {
  return tools?.length ? JSON.stringify(tools).length + 16 : 0;
}

/** Tokenizer-independent estimate suitable for a mixed English/CJK CLI counter. */
export function estimateTextTokens(value: string): number {
  let asciiCharacters = 0;
  let nonAsciiCodePoints = 0;
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) asciiCharacters += 1;
    else nonAsciiCodePoints += 1;
  }
  return Math.ceil(asciiCharacters / 4) + nonAsciiCodePoints;
}

function estimateMessageTextTokens(message: ChatMessage): number {
  let tokens = 8;
  if (message.content) tokens += estimateTextTokens(message.content);
  if (message.role === "assistant" && message.tool_calls) {
    tokens += estimateTextTokens(JSON.stringify(message.tool_calls));
  }
  if (message.role === "assistant" && message.reasoning_content) {
    tokens += estimateTextTokens(message.reasoning_content);
  }
  return tokens;
}

function estimateVisionTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => {
    if (message.role !== "user") return total;
    return total + (message.images ?? []).reduce(
      (imageTotal, image) =>
        imageTotal + Math.ceil(image.width / 32) * Math.ceil(image.height / 32) + 2,
      0,
    );
  }, 0);
}


function limitActiveImages(
  messages: readonly ChatMessage[],
  maximumImages = MAX_IMAGES_PER_MODEL_REQUEST,
): ChatMessage[] {
  let remainingCount = maximumImages;
  let remainingBytes = MAX_TOTAL_IMAGE_BYTES_PER_MODEL_REQUEST;
  let remainingPixels = MAX_TOTAL_IMAGE_PIXELS_PER_MODEL_REQUEST;
  let exhausted = false;
  const result = [...messages];
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index];
    if (!message || message.role !== "user" || !message.images?.length) continue;
    const images: typeof message.images = [];
    if (!exhausted) {
      for (let imageIndex = message.images.length - 1; imageIndex >= 0; imageIndex -= 1) {
        const image = message.images[imageIndex];
        if (!image) continue;
        const pixels = image.width * image.height;
        if (
          remainingCount < 1 ||
          image.byteSize > remainingBytes ||
          pixels > remainingPixels
        ) {
          exhausted = true;
          break;
        }
        images.unshift(image);
        remainingCount -= 1;
        remainingBytes -= image.byteSize;
        remainingPixels -= pixels;
      }
    }
    const omitted = message.images.length - images.length;
    const marker = omitted
      ? `\n${loadPromptBundleCatalog().render("context/older-images-omitted.md", {
          count: omitted,
        }).trim()}`
      : "";
    result[index] = {
      role: "user",
      content: `${message.content}${marker}`,
      ...(images.length ? { images } : {}),
    };
  }
  return result;
}

function removeOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const result = [...messages];
  while (result[0]?.role === "tool") result.shift();
  return result;
}

function summaryMessage(content: string): ChatMessage {
  return {
    role: "user",
    content: loadPromptBundleCatalog().render("context/summary.md", {
      content,
    }).trimEnd(),
  };
}

export function shortTermMessages(state: Readonly<SessionState>): ChatMessage[] {
  const compactedMessageCount = Math.min(
    Math.max(0, state.compactedMessageCount),
    state.messages.length,
  );
  const activeMessages = limitActiveImages(removeOrphanToolMessages(
    projectModelInputMessages(pressureProjectedMessages(state).slice(compactedMessageCount)),
  ));
  const persistentSummary = state.workingSummary.trim();
  return [
    ...(state.pressureRecovery?.serverReset?.requirementIndices.map(i => state.messages[i]!).filter(Boolean) ?? []),
    ...(persistentSummary ? [summaryMessage(persistentSummary)] : []),
    ...activeMessages,
  ];
}

interface ContextSystemBudget {
  readonly system: ChatMessage;
  readonly conversationBudget: number;
}

function contextSystemBudget(input: ContextBuildInput): ContextSystemBudget {
  const memorySection = input.longTermMemories?.length
    ? `\n\n${loadPromptBundleCatalog().render("context/long-term-memory.md", {
        content: input.longTermMemories.map((memory) => `- ${memory}`).join("\n"),
      }).trimEnd()}`
    : "";
  if (!Number.isInteger(input.maxContextChars) || input.maxContextChars < 1_024) {
    throw new Error("maxContextChars must be an integer of at least 1024");
  }
  const requestedBudget = input.maxContextChars;
  const conversationReserve = Math.min(4_096, Math.max(512, Math.floor(requestedBudget / 4)));
  const systemContent = `${input.systemPrompt}${memorySection}`;
  const system: ChatMessage = {
    role: "system",
    content: systemContent,
  };
  const actualSystemChars = messageChars(system);
  const requestedSystemChars = input.reservedSystemPromptChars === undefined
    ? actualSystemChars
    : Math.max(actualSystemChars, Math.trunc(input.reservedSystemPromptChars));
  const latestUser = [...input.state.messages].reverse().find((message) => message.role === "user");
  const protectedReserve = estimateMessagesChars([
    ...(latestUser ? [latestUser] : []),
    ...(input.state.workingSummary ? [summaryMessage(input.state.workingSummary)] : []),
    ...[runtimeContinuityMessage(input.state), input.runtimeContext ?? ""].filter(Boolean)
      .map((content): ChatMessage => ({ role: "user", content })),
  ]) + 384;
  // Artificial retrieval/tool headroom may shrink; actual instructions and
  // protected evidence may not. Pressure enforcement still counts real tools.
  const maximumSystemChars = Math.max(actualSystemChars,
    requestedBudget - Math.max(conversationReserve, protectedReserve));
  const reservedSystemChars = Math.max(
    actualSystemChars,
    Math.min(maximumSystemChars, requestedSystemChars),
  );
  return {
    system,
    conversationBudget: Math.max(0, requestedBudget - reservedSystemChars),
  };
}

export class ContextManager {
  private limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS;
  private capacity: TokenBudget | undefined;
  estimateRequestTokens = requestTokens;
  configureTokenBudget(window: number | undefined, limits?: Readonly<import("../config/runtime-limits.js").RuntimeLimits>): void {
    this.limits = limits ?? DEFAULT_RUNTIME_LIMITS;
    this.capacity = window === undefined ? undefined : tokenBudget(window, limits);
  }
  get tokenCapacity(): TokenBudget | undefined { return this.capacity; }
  get runtimeLimits(): Readonly<RuntimeLimits> { return this.limits; }
  activeCharBudget(maxContextChars: number): number {
    return activeWorkingSetCharBudget(maxContextChars, this.limits.maxActiveContextChars);
  }
  /** Character budget used by automatic context-pressure thresholds. */
  estimateShortTermChars(state: Readonly<SessionState>): number {
    return shortTermMessages(state).reduce(
      (total, message) => total + messageChars(message),
      0,
    );
  }

  /** Estimate the persisted summary plus currently active thread messages. */
  estimateShortTermTokens(state: Readonly<SessionState>): number {
    const messages = shortTermMessages(state);
    return messages.reduce(
      (total, message) => total + estimateMessageTextTokens(message),
      estimateVisionTokens(messages),
    );
  }

  /**
   * Returns the first durable message index omitted from the rolling working
   * set. Retrieval must use this exact boundary so it never duplicates recent
   * messages that are already represented in the provider projection.
   */
  retrievalBoundary(
    state: Readonly<SessionState>,
    maxContextChars: number,
    systemPrompt = "",
    reservedSystemPromptChars?: number,
    runtimeContext = "",
  ): number {
    return state.compactedMessageCount;
  }

  applyModelCompaction(
    state: SessionState,
    summary: string,
    compactedMessageCount: number,
    contextState?: {
      intentLedger: NonNullable<SessionState["contextIntentLedger"]>;
      metadata: NonNullable<SessionState["contextCompactionMetadata"]>;
    },
  ): { compactedMessageCount: number; summaryChars: number } {
    const normalized = redactSensitiveInformation(summary.trim());
    if (!normalized) throw new Error("Context summary must not be empty");
    if (normalized.length > MAX_CONTEXT_SUMMARY_CHARS) {
      throw new Error(`Context summary exceeds ${MAX_CONTEXT_SUMMARY_CHARS} characters`);
    }
    if (
      !Number.isInteger(compactedMessageCount) ||
      compactedMessageCount < state.compactedMessageCount ||
      compactedMessageCount > state.messages.length
    ) {
      throw new Error("Context compaction boundary is invalid");
    }
    if (
      contextState &&
      (
        contextState.metadata.formatVersion !== 2 ||
        contextState.metadata.sourceStartMessageIndex !==
          state.compactedMessageCount ||
        contextState.metadata.compactedMessageCount !== compactedMessageCount ||
        contextState.metadata.sourceEndMessageIndex > compactedMessageCount ||
        contextState.metadata.sourceStartMessageIndex >
          contextState.metadata.sourceEndMessageIndex ||
        !/^sha256:[a-f0-9]{64}$/u.test(contextState.metadata.sourceHistoryHash)
      )
    ) {
      throw new Error("Context compaction provenance is invalid");
    }
    if (contextState) {
      const sourceHistoryHash = `sha256:${sha256(JSON.stringify(
        state.messages.slice(0, contextState.metadata.sourceEndMessageIndex),
      ))}`;
      if (sourceHistoryHash !== contextState.metadata.sourceHistoryHash) {
        throw new Error("Context compaction source history changed before commit");
      }
    }

    state.workingSummary = normalized;
    state.compactedMessageCount = compactedMessageCount;
    if (contextState) {
      state.contextIntentLedger = {
        latestRequest: { ...contextState.intentLedger.latestRequest },
        activeConstraints: contextState.intentLedger.activeConstraints.map((item) => ({
          ...item,
        })),
        userCorrections: contextState.intentLedger.userCorrections.map((item) => ({
          ...item,
        })),
        supersededRequests: contextState.intentLedger.supersededRequests.map((item) => ({
          ...item,
        })),
      };
      state.contextCompactionMetadata = { ...contextState.metadata };
    } else {
      delete state.contextIntentLedger;
      delete state.contextCompactionMetadata;
    }
    state.updatedAt = new Date().toISOString();
    return { compactedMessageCount, summaryChars: normalized.length };
  }

  build(input: ContextBuildInput): ChatMessage[] {
    const budget = contextSystemBudget(input);
    const continuity = runtimeContinuityMessage(input.state);
    const tail: ChatMessage[] = [continuity, reconciliationPending(input.state) ? "" : input.runtimeContext ?? ""].filter(Boolean)
      .map((content) => ({ role: "user", content }));
    // History is retired only by a committed Runtime maintenance event.
    // Pressure inspection and the provider guard handle oversized requests;
    // never make them appear to fit by silently omitting the active chain.
    return [budget.system, ...shortTermMessages(input.state), ...tail];
  }

  inspect(
    state: SessionState,
    maxContextChars: number,
    buildBudget?: ContextInspectionBuildBudget,
  ): ContextInspection {
    const images = state.messages.flatMap((message) =>
      message.role === "user" ? message.images ?? [] : [],
    );
    const estimatedShortTermChars = this.estimateShortTermChars(state);
    const compactedMessageCount = Math.min(
      Math.max(0, state.compactedMessageCount),
      state.messages.length,
    );
    const durableHistoryChars = estimateMessagesChars(state.messages);
    const durableActiveChars = estimateMessagesChars(
      state.messages.slice(compactedMessageCount),
    );
    const conversationBudget = buildBudget
      ? contextSystemBudget({
          systemPrompt: buildBudget.systemPrompt,
          state,
          maxContextChars,
          ...(buildBudget.reservedSystemPromptChars === undefined
            ? {}
            : { reservedSystemPromptChars: buildBudget.reservedSystemPromptChars }),
        }).conversationBudget
      : maxContextChars;
    // This is the projection-level diagnostic used outside a concrete request.
    // Runtime enforcement uses inspectProviderRequest() after final messages
    // and tool schemas have been assembled.
    const budgetChars = this.activeCharBudget(conversationBudget);
    const utilization = this.capacity ? this.estimateRequestTokens(shortTermMessages(state)) / this.capacity.inputCapacity
      : estimatedShortTermChars / budgetChars;
    return {
      messageCount: state.messages.length,
      durableHistoryChars,
      durableActiveChars,
      projectedActiveChars: estimatedShortTermChars,
      estimatedChars: durableHistoryChars,
      configuredBudgetChars: maxContextChars,
      budgetChars,
      summaryChars: state.workingSummary.length,
      compactedMessageCount,
      activeMessageCount: Math.max(0, state.messages.length - compactedMessageCount),
      imageCount: images.length,
      imageBytes: images.reduce((total, image) => total + image.byteSize, 0),
      estimatedVisionTokens: images.reduce(
        (total, image) =>
          total + Math.ceil(image.width / 32) * Math.ceil(image.height / 32) + 2,
        0,
      ),
      estimatedShortTermChars,
      estimatedShortTermTokens: this.estimateShortTermTokens(state),
      utilization,
      pressure: contextPressureLevel(utilization),
    };
  }

  /**
   * Inspect the same projected messages and tool schemas that are about to be
   * sent to a provider. The fixed retrieval reserve is intentionally absent:
   * it controls selection headroom, not bytes in this concrete request.
   */
  inspectProviderRequest(
    input: ProviderRequestInspectionInput,
  ): ProviderRequestContextInspection {
    const projectedMessages = projectModelInputMessages(input.messages);
    const providerMessageChars = estimateMessagesChars(projectedMessages);
    const providerToolDefinitionChars = estimateToolDefinitionsChars(input.tools);
    const providerInputChars = providerMessageChars + providerToolDefinitionChars;
    const budgetChars = this.activeCharBudget(input.maxContextChars);
    // Measure the actual request once. Retention policy belongs to Runtime;
    // never secretly add a second projection or count the same overhead twice.
    const estimatedInputTokens = this.estimateRequestTokens(projectedMessages, input.tools);
    const utilization = this.capacity ? estimatedInputTokens / this.capacity.inputCapacity
      : providerInputChars / Math.floor(budgetChars *
        (1 - this.limits.contextToolReserveRatio - this.limits.contextSafetyReserveRatio));
    return {
      ...this.inspect(input.state, input.maxContextChars),
      configuredBudgetChars: input.maxContextChars,
      budgetChars,
      providerMessageCount: projectedMessages.length,
      providerMessageChars,
      providerToolDefinitionChars,
      providerInputChars,
      estimatedInputTokens,
      ...(this.capacity ? { inputTokenCapacity: this.capacity.inputCapacity,
        outputTokenReserve: this.capacity.outputReserve } : {}),
      utilization,
      pressure: contextPressureLevel(utilization),
    };
  }
}
