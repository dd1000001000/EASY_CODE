import type { ApprovalRequest, CommandExecutionMode } from "../core/types.js";

/** Shared by foreground and child approvals; network authority is separate. */
export function autoApproveLocal(mode: CommandExecutionMode, risk: ApprovalRequest["risk"]): boolean {
  return mode === "unrestricted" || mode === "auto_approve" && ["read", "workspace", "install"].includes(risk);
}
