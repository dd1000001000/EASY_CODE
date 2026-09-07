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

export const MAX_CONTEXT_SUMMARY_CHARS = 12_000;
/**
 * Maximum projected recent conversation considered for a provider request.
 * Older evidence remains durable and is recovered through the Thread-private
 * index.
 */
export const MAX_ACTIVE_WORKING_SET_CHARS = 250_000;
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
export function activeWorkingSetCharBudget(maxContextChars: number): number {
  if (!Number.isSafeInteger(maxContextChars) || maxContextChars < 1) {
    throw new RangeError("maxContextChars must be a positive safe integer");
  }
  return Math.min(maxContextChars, MAX_ACTIVE_WORKING_SET_CHARS);
}

export interface ContextBuildInput {
  systemPrompt: string;
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
  providerMessageCount: number;
  providerMessageChars: number;
  providerToolDefinitionChars: number;
  /** Exact character estimate used for request-pressure decisions. */
  providerInputChars: number;
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

function summarizeMessages(messages: ChatMessage[]): string {
  const catalog = loadPromptBundleCatalog();
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const compact = message.content.replace(/\s+/g, " ").slice(0, 240);
      lines.push(catalog.render("context/fallback-tool-result.md", {
        content: compact,
      }).trimEnd());
      continue;
    }

    const compact = (message.content ?? "").replace(/\s+/g, " ").slice(0, 300);
    const images = message.role === "user" && message.images?.length
      ? ` [images: ${message.images.map((image) =>
          `${image.label} ${image.width}x${image.height}`).join(", ")}]`
      : "";
    if (!compact && !images) continue;
    lines.push(catalog.render("context/fallback-message.md", {
      role: message.role === "user" ? "User" : "Assistant",
      content: compact,
      images,
    }).trimEnd());
  }
  return lines.slice(-24).join("\n");
}

function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 32) return value.slice(0, Math.max(0, limit));
  const marker = `\n${loadPromptBundleCatalog().readText("context/context-truncated.md").trim()}\n`;
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available * 0.6);
  return `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`;
}

function boundedMessage(message: ChatMessage, budget: number): ChatMessage | undefined {
  const contentBudget = budget - 32;
  if (contentBudget <= 0) return undefined;
  if (message.role === "assistant") {
    const toolCallChars = message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
    if (toolCallChars >= contentBudget) {
      return {
        role: "assistant",
        content: boundedText(
          message.content ?? loadPromptBundleCatalog()
            .readText("context/tool-request-omitted.md")
            .trim(),
          contentBudget,
        ),
      };
    }
    let remaining = contentBudget - toolCallChars;
    const boundedReasoning = message.reasoning_content
      ? boundedText(message.reasoning_content, remaining)
      : message.reasoning_content;
    remaining -= boundedReasoning?.length ?? 0;
    const bounded: Extract<ChatMessage, { role: "assistant" }> = {
      ...message,
      content: message.content === null
        ? null
        : boundedText(message.content, remaining),
    };
    if (boundedReasoning === undefined) delete bounded.reasoning_content;
    else bounded.reasoning_content = boundedReasoning;
    return bounded;
  }
  if (message.role === "user" && message.images?.length) {
    return {
      role: "user",
      content: boundedText(message.content, contentBudget),
      images: message.images,
    };
  }
  return { ...message, content: boundedText(message.content, contentBudget) };
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

function shortTermMessages(state: Readonly<SessionState>): ChatMessage[] {
  const compactedMessageCount = Math.min(
    Math.max(0, state.compactedMessageCount),
    state.messages.length,
  );
  const activeMessages = limitActiveImages(removeOrphanToolMessages(
    projectModelInputMessages(state.messages.slice(compactedMessageCount)),
  ));
  const persistentSummary = state.workingSummary.trim();
  return [
    ...(persistentSummary ? [summaryMessage(persistentSummary)] : []),
    ...activeMessages,
  ];
}

interface ContextSystemBudget {
  readonly system: ChatMessage;
  readonly conversationBudget: number;
}

interface ContextConversationSelection {
  readonly messages: ChatMessage[];
  /** First original durable message represented in the raw working set. */
  readonly retrievalBoundary: number;
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
  const systemLimit = Math.max(256, requestedBudget - conversationReserve - 32);
  const system: ChatMessage = {
    role: "system",
    content: boundedText(`${input.systemPrompt}${memorySection}`, systemLimit),
  };
  const actualSystemChars = messageChars(system);
  const requestedSystemChars = input.reservedSystemPromptChars === undefined
    ? actualSystemChars
    : Math.max(actualSystemChars, Math.trunc(input.reservedSystemPromptChars));
  const maximumSystemChars = requestedBudget - conversationReserve;
  const reservedSystemChars = Math.max(
    actualSystemChars,
    Math.min(maximumSystemChars, requestedSystemChars),
  );
  return {
    system,
    conversationBudget: Math.max(0, requestedBudget - reservedSystemChars),
  };
}

function selectContextConversation(
  state: Readonly<SessionState>,
  budget: number,
): ContextConversationSelection {
  const compactedMessageCount = Math.min(
    Math.max(0, state.compactedMessageCount),
    state.messages.length,
  );
  let activeStart = compactedMessageCount;
  while (state.messages[activeStart]?.role === "tool") activeStart += 1;
  const activeMessages = limitActiveImages(projectModelInputMessages(
    state.messages.slice(activeStart),
  ));
  const persistentSummary = state.workingSummary.trim();
  const persistentSummaryMessage = persistentSummary
    ? summaryMessage(persistentSummary)
    : undefined;
  const workingSetBudget = budget > 0
    ? activeWorkingSetCharBudget(Math.trunc(budget))
    : 0;
  const totalConversationChars = activeMessages.reduce(
    (total, message) => total + messageChars(message),
    persistentSummaryMessage ? messageChars(persistentSummaryMessage) : 0,
  );
  if (totalConversationChars <= workingSetBudget) {
    return {
      messages: [
        ...(persistentSummaryMessage ? [persistentSummaryMessage] : []),
        ...activeMessages,
      ],
      retrievalBoundary: activeStart,
    };
  }

  const summaryReserve = Math.min(8_000, Math.floor(workingSetBudget * 0.3));
  const recentBudget = Math.max(0, workingSetBudget - summaryReserve);
  const selected: ChatMessage[] = [];
  let selectedStart = activeMessages.length;
  let used = 0;
  for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
    const message = activeMessages[index];
    if (!message) continue;
    const size = messageChars(message);
    if (used + size > recentBudget) {
      if (selected.length === 0) {
        const bounded = boundedMessage(message, recentBudget);
        if (bounded) {
          selected.unshift(bounded);
          selectedStart = index;
        }
      }
      break;
    }
    selected.unshift(message);
    selectedStart = index;
    used += size;
  }
  while (selected[0]?.role === "tool") {
    selected.shift();
    selectedStart += 1;
  }

  const omitted = activeMessages.slice(0, selectedStart);
  const fallbackSummary = summarizeMessages(omitted);
  const summaryParts: string[] = [];
  if (persistentSummary) {
    summaryParts.push(loadPromptBundleCatalog().render(
      "context/fallback-persistent-summary.md",
      { content: persistentSummary },
    ).trimEnd());
  }
  if (fallbackSummary) {
    summaryParts.push(loadPromptBundleCatalog().render(
      "context/fallback-overflow-summary.md",
      { content: fallbackSummary },
    ).trimEnd());
  }

  const cleanSelected = removeOrphanToolMessages(selected);
  const combinedSummary = summaryParts.join("\n\n");
  if (combinedSummary) {
    const remainingForSummary = Math.max(0, workingSetBudget - cleanSelected.reduce(
      (total, message) => total + messageChars(message),
      0,
    ));
    const boundedSummary = boundedMessage(
      summaryMessage(combinedSummary),
      Math.min(remainingForSummary, summaryReserve),
    );
    if (boundedSummary) cleanSelected.unshift(boundedSummary);
  }
  return {
    messages: cleanSelected,
    retrievalBoundary: activeStart + selectedStart,
  };
}

export class ContextManager {
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
  ): number {
    const input: ContextBuildInput = {
      systemPrompt,
      state,
      maxContextChars,
      ...(reservedSystemPromptChars === undefined
        ? {}
        : { reservedSystemPromptChars }),
    };
    const system = contextSystemBudget(input);
    return selectContextConversation(state, system.conversationBudget).retrievalBoundary;
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
    const conversation = selectContextConversation(input.state, budget.conversationBudget);
    return [budget.system, ...conversation.messages];
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
    const budgetChars = activeWorkingSetCharBudget(conversationBudget);
    const utilization = estimatedShortTermChars / budgetChars;
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
    const budgetChars = activeWorkingSetCharBudget(input.maxContextChars);
    const utilization = providerInputChars / budgetChars;
    return {
      ...this.inspect(input.state, input.maxContextChars),
      configuredBudgetChars: input.maxContextChars,
      budgetChars,
      providerMessageCount: projectedMessages.length,
      providerMessageChars,
      providerToolDefinitionChars,
      providerInputChars,
      utilization,
      pressure: contextPressureLevel(utilization),
    };
  }
}
