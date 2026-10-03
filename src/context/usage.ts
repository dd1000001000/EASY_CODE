import type { ChatMessage, SessionState, ToolDefinition } from "../core/types.js";
import { systemPromptSections, type SystemPromptPart } from "../prompts/builder.js";
import type { ContextUsageCategory, ContextUsageCounts, ContextUsageReport } from "../ui/contracts.js";
import type { ContextManager } from "./manager.js";
import { estimatedTokens, messageTokens } from "./token-budget.js";

const SYSTEM_CATEGORY: Readonly<Record<SystemPromptPart, ContextUsageCategory>> = {
  policy: "systemPrompt",
  instructions: "instructions",
  skills: "skills",
  memory: "memory",
};

function noUsage(): Record<ContextUsageCategory, number> {
  return {
    messages: 0,
    systemPrompt: 0,
    instructions: 0,
    skills: 0,
    memory: 0,
    runtimeContext: 0,
    systemTools: 0,
    mcpTools: 0,
  };
}

export interface ContextUsageInput {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly { readonly definition: ToolDefinition; readonly mcp: boolean }[];
  /** The Runtime context message sent after the conversation, and the memory text inside it. */
  readonly runtimeContext?: string;
  readonly runtimeMemory?: string;
}

/** Split a system message's tokens over its sections in proportion to their text. */
function addSystem(counts: Record<ContextUsageCategory, number>, text: string, tokens: number): void {
  const known = systemPromptSections(text);
  if (!known) {
    counts.systemPrompt += tokens;
    return;
  }
  const shares = known.sections.map(
    (section) => [SYSTEM_CATEGORY[section.part], estimatedTokens(section.text)] as const,
  );
  // The context manager appends only long-term memory after the built prompt.
  const all = known.rest ? [...shares, ["memory", estimatedTokens(known.rest)] as const] : shares;
  const total = all.reduce((sum, [, weight]) => sum + weight, 0);
  let assigned = 0;
  for (const [category, weight] of all) {
    const share = total ? Math.floor((tokens * weight) / total) : 0;
    counts[category] += share;
    assigned += share;
  }
  counts.systemPrompt += tokens - assigned;
}

/** Tokens each part of one request takes, with the estimate that enforces the window. */
export function measureContextUsage(input: ContextUsageInput): ContextUsageCounts {
  const counts = noUsage();
  for (const message of input.messages) {
    const tokens = messageTokens(message);
    if (message.role === "system") {
      addSystem(counts, message.content ?? "", tokens);
    } else if (input.runtimeContext && message.role === "user" && message.content === input.runtimeContext) {
      const memory = Math.min(tokens, input.runtimeMemory ? estimatedTokens(input.runtimeMemory) : 0);
      counts.memory += memory;
      counts.runtimeContext += tokens - memory;
    } else {
      counts.messages += tokens;
    }
  }
  const builtIn = input.tools.filter((tool) => !tool.mcp).map((tool) => tool.definition);
  const mcp = input.tools.filter((tool) => tool.mcp).map((tool) => tool.definition);
  if (builtIn.length) counts.systemTools = estimatedTokens(JSON.stringify(builtIn));
  if (mcp.length) counts.mcpTools = estimatedTokens(JSON.stringify(mcp));
  return counts;
}

/**
 * How the conversation uses the current window, or undefined when context is
 * measured in characters. Messages are counted as they stand, so new input and
 * compaction show at once; the other parts come from the latest request.
 */
export function contextUsageReport(
  manager: ContextManager,
  state: Readonly<SessionState>,
): ContextUsageReport | undefined {
  const budget = manager.tokenCapacity;
  if (!budget) return undefined;
  const measured = manager.measuredUsage(state.threadId);
  return {
    windowTokens: budget.window,
    categories: { ...(measured ?? noUsage()), messages: manager.conversationTokens(state) },
    reservedTokens: budget.outputReserve + budget.toolReserve + budget.safetyReserve,
    compactionTokens: Math.floor(budget.inputCapacity * manager.runtimeLimits.contextCompactionTriggerRatio),
    measured: measured !== undefined,
  };
}

export function contextUsedTokens(report: Readonly<ContextUsageReport>): number {
  return Object.values(report.categories).reduce((sum, tokens) => sum + tokens, 0);
}

/** Tokens the conversation takes of the window, or of its messages when context is measured in characters. */
export function contextTokensInUse(manager: ContextManager, state: Readonly<SessionState>): number {
  const report = contextUsageReport(manager, state);
  return report ? contextUsedTokens(report) : manager.estimateShortTermTokens(state);
}
