import type { ChatMessage, SessionState } from "../core/types.js";
import {
  MAX_IMAGES_PER_MODEL_REQUEST,
  MAX_TOTAL_IMAGE_BYTES_PER_MODEL_REQUEST,
  MAX_TOTAL_IMAGE_PIXELS_PER_MODEL_REQUEST,
} from "../images/image-store.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { loadPromptBundleCatalog } from "../prompt-bundle/index.js";

export const MAX_CONTEXT_SUMMARY_CHARS = 12_000;
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

export interface ContextBuildInput {
  systemPrompt: string;
  state: SessionState;
  maxContextChars: number;
  longTermMemories?: string[];
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
    return {
      ...message,
      content: message.content === null
        ? null
        : boundedText(message.content, contentBudget - toolCallChars),
    };
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
    state.messages.slice(compactedMessageCount),
  ));
  const persistentSummary = state.workingSummary.trim();
  return [
    ...(persistentSummary ? [summaryMessage(persistentSummary)] : []),
    ...activeMessages,
  ];
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

  applyModelCompaction(
    state: SessionState,
    summary: string,
    compactedMessageCount: number,
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

    state.workingSummary = normalized;
    state.compactedMessageCount = compactedMessageCount;
    state.updatedAt = new Date().toISOString();
    return { compactedMessageCount, summaryChars: normalized.length };
  }

  build(input: ContextBuildInput): ChatMessage[] {
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
      content: boundedText(`${input.systemPrompt}${memorySection}`, systemLimit)
    };

    const budget = Math.max(0, requestedBudget - messageChars(system));
    const compactedMessageCount = Math.min(
      Math.max(0, input.state.compactedMessageCount),
      input.state.messages.length,
    );
    const activeMessages = limitActiveImages(removeOrphanToolMessages(
      input.state.messages.slice(compactedMessageCount),
    ));
    const persistentSummary = input.state.workingSummary.trim();
    const persistentSummaryMessage = persistentSummary
      ? summaryMessage(persistentSummary)
      : undefined;
    const totalConversationChars = activeMessages.reduce(
      (total, message) => total + messageChars(message),
      persistentSummaryMessage ? messageChars(persistentSummaryMessage) : 0,
    );
    if (totalConversationChars <= budget) {
      return [
        system,
        ...(persistentSummaryMessage ? [persistentSummaryMessage] : []),
        ...activeMessages,
      ];
    }

    const summaryReserve = Math.min(8_000, Math.floor(budget * 0.3));
    const recentBudget = Math.max(0, budget - summaryReserve);
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
            used += messageChars(bounded);
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
    const combinedSummary = summaryParts.join("\n\n");

    const cleanSelected = removeOrphanToolMessages(selected);
    if (combinedSummary) {
      const compactedSummaryMessage = summaryMessage(combinedSummary);
      const remainingForSummary = Math.max(0, budget - cleanSelected.reduce(
        (total, message) => total + messageChars(message),
        0,
      ));
      const boundedSummary = boundedMessage(
        compactedSummaryMessage,
        Math.min(remainingForSummary, summaryReserve),
      );
      if (boundedSummary) cleanSelected.unshift(boundedSummary);
    }

    return [system, ...cleanSelected];
  }

  inspect(state: SessionState, maxContextChars: number): {
    messageCount: number;
    estimatedChars: number;
    budgetChars: number;
    summaryChars: number;
    compactedMessageCount: number;
    activeMessageCount: number;
    imageCount: number;
    imageBytes: number;
    estimatedVisionTokens: number;
    estimatedShortTermChars: number;
    estimatedShortTermTokens: number;
    utilization: number;
    pressure: ContextPressureLevel;
  } {
    const images = state.messages.flatMap((message) =>
      message.role === "user" ? message.images ?? [] : [],
    );
    const estimatedShortTermChars = this.estimateShortTermChars(state);
    const utilization = maxContextChars > 0
      ? estimatedShortTermChars / maxContextChars
      : 0;
    return {
      messageCount: state.messages.length,
      estimatedChars: state.messages.reduce((total, message) => total + messageChars(message), 0),
      budgetChars: maxContextChars,
      summaryChars: state.workingSummary.length,
      compactedMessageCount: state.compactedMessageCount,
      activeMessageCount: Math.max(0, state.messages.length - state.compactedMessageCount),
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
}
