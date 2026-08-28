import type { ApprovalDecision } from "../core/types.js";
import {
  renderMenu,
  selectMenuIndex,
  type MenuSelectorOptions,
} from "./menu-selector.js";

const APPROVAL_DECISIONS = [
  "allow_once",
  "allow_prefix",
  "reject",
] as const satisfies readonly ApprovalDecision[];

export type ApprovalSelectorOptions = MenuSelectorOptions;

export function renderApprovalSelector(
  commandPrefix: string,
  selectedIndex: number,
  color = true,
): string[] {
  return renderMenu(
    "Approve command execution",
    [
      "Yes, allow execute one time",
      `Yes, don't ask me again with prefix ${JSON.stringify([commandPrefix])}`,
      "Reject",
    ],
    selectedIndex,
    color,
    512,
  );
}

/** Cancellation always maps to reject so terminal failures never grant access. */
export async function selectApproval(
  commandPrefix: string,
  options: ApprovalSelectorOptions,
): Promise<ApprovalDecision> {
  const index = await selectMenuIndex(
    APPROVAL_DECISIONS.length,
    0,
    (selectedIndex) =>
      renderApprovalSelector(commandPrefix, selectedIndex, options.color ?? true),
    options,
    "No approval choices are available.",
  );
  return index === undefined
    ? "reject"
    : APPROVAL_DECISIONS[index] ?? "reject";
}
