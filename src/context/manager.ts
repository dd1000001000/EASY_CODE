import type { ChatMessage, SessionState } from "../core/types.js";

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
  return size + 32;
}

function summarizeMessages(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const compact = message.content.replace(/\s+/g, " ").slice(0, 240);
      lines.push(`- Tool result: ${compact}`);
      continue;
    }

    const compact = (message.content ?? "").replace(/\s+/g, " ").slice(0, 300);
    if (!compact) continue;
    lines.push(`- ${message.role === "user" ? "User" : "Assistant"}: ${compact}`);
  }
  return lines.slice(-24).join("\n");
}

function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 32) return value.slice(0, Math.max(0, limit));
  const marker = "\n…[context truncated]…\n";
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
          message.content ?? "[Earlier tool request omitted because of the context limit]",
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
  return { ...message, content: boundedText(message.content, contentBudget) };
}

function removeOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const result = [...messages];
  while (result[0]?.role === "tool") result.shift();
  return result;
}

export class ContextManager {
  build(input: ContextBuildInput): ChatMessage[] {
    const memorySection = input.longTermMemories?.length
      ? `\n\n<automatic_long_term_memory>\n${input.longTermMemories
          .map((memory) => `- ${memory}`)
          .join("\n")}\n</automatic_long_term_memory>`
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
    const totalConversationChars = input.state.messages.reduce(
      (total, message) => total + messageChars(message),
      0,
    );
    if (totalConversationChars <= budget) {
      input.state.workingSummary = "";
      return [system, ...removeOrphanToolMessages(input.state.messages)];
    }

    const summaryReserve = Math.min(8_000, Math.floor(budget * 0.3));
    const recentBudget = Math.max(0, budget - summaryReserve);
    const selected: ChatMessage[] = [];
    let used = 0;

    for (let index = input.state.messages.length - 1; index >= 0; index -= 1) {
      const message = input.state.messages[index];
      if (!message) continue;
      const size = messageChars(message);
      if (used + size > recentBudget) {
        if (selected.length === 0) {
          const bounded = boundedMessage(message, recentBudget);
          if (bounded) {
            selected.unshift(bounded);
            used += messageChars(bounded);
          }
        }
        break;
      }
      selected.unshift(message);
      used += size;
    }

    const omitted = input.state.messages.slice(0, input.state.messages.length - selected.length);
    const summaryContentBudget = Math.max(0, summaryReserve - 32);
    input.state.workingSummary = boundedText(
      summarizeMessages(omitted),
      summaryContentBudget,
    );

    const cleanSelected = removeOrphanToolMessages(selected);
    if (input.state.workingSummary) {
      const summaryMessage: ChatMessage = {
        role: "user",
        content:
          "The following is an automatically generated summary of the earlier EASY CODE conversation. " +
          "Use it only as context; prioritize the latest user messages, files, and command results:\n" +
          input.state.workingSummary
      };
      const remainingForSummary = Math.max(0, budget - cleanSelected.reduce(
        (total, message) => total + messageChars(message),
        0,
      ));
      const boundedSummary = boundedMessage(summaryMessage, remainingForSummary);
      if (boundedSummary) cleanSelected.unshift(boundedSummary);
    }

    return [system, ...cleanSelected];
  }

  inspect(state: SessionState, maxContextChars: number): {
    messageCount: number;
    estimatedChars: number;
    budgetChars: number;
    summaryChars: number;
  } {
    return {
      messageCount: state.messages.length,
      estimatedChars: state.messages.reduce((total, message) => total + messageChars(message), 0),
      budgetChars: maxContextChars,
      summaryChars: state.workingSummary.length
    };
  }
}
