import type { MessageKey } from "../i18n/catalog.js";
import type { ContextUsageCategory, ContextUsageReport } from "./contracts.js";

export type ContextUsageRowId = ContextUsageCategory | "reserved" | "free";

export interface ContextUsageRow {
  readonly id: ContextUsageRowId;
  readonly label: MessageKey;
  readonly tokens: number;
  /** Share of the whole window. */
  readonly ratio: number;
}

const CATEGORY_LABELS: readonly (readonly [ContextUsageCategory, MessageKey])[] = [
  ["messages", "ui.contextMessages"],
  ["systemPrompt", "ui.contextSystemPrompt"],
  ["systemTools", "ui.contextSystemTools"],
  ["mcpTools", "ui.contextMcpTools"],
  ["skills", "ui.contextSkills"],
  ["instructions", "ui.contextInstructions"],
  ["memory", "ui.contextMemory"],
  ["runtimeContext", "ui.contextRuntimeContext"],
];

/**
 * The rows shown for a report: each part in use (messages always, empty
 * parts left out), then the reserve and the free space, so the rows add up
 * to the window.
 */
export function contextUsageRows(report: Readonly<ContextUsageReport>): {
  readonly used: number;
  readonly rows: readonly ContextUsageRow[];
} {
  const window = Math.max(1, report.windowTokens);
  const used = CATEGORY_LABELS.reduce((sum, [id]) => sum + report.categories[id], 0);
  const free = Math.max(0, report.windowTokens - used - report.reservedTokens);
  const rows: ContextUsageRow[] = CATEGORY_LABELS.filter(([id]) => id === "messages" || report.categories[id] > 0).map(
    ([id, label]) => ({ id, label, tokens: report.categories[id], ratio: report.categories[id] / window }),
  );
  rows.push(
    {
      id: "reserved",
      label: "ui.contextReserved",
      tokens: report.reservedTokens,
      ratio: report.reservedTokens / window,
    },
    { id: "free", label: "ui.contextFree", tokens: free, ratio: free / window },
  );
  return { used, rows };
}

/** A share as a percentage with one decimal, never rounding a non-zero share to 0. */
export function formatShare(ratio: number): string {
  const percent = Math.max(0, ratio) * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(1)}%`;
}
