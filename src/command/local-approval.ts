import type { ApprovalRequest, CommandExecutionMode } from "../core/types.js";

/** Shared by foreground and child approvals; network authority is separate. */
export function autoApproveLocal(mode: CommandExecutionMode, risk: ApprovalRequest["risk"]): boolean {
  void risk;
  return mode === "unrestricted";
}
