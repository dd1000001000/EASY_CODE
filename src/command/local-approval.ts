import type { CommandExecutionMode } from "../core/types.js";

/** Shared by foreground and child approvals; network authority is separate. */
export function autoApproveLocal(mode: CommandExecutionMode): boolean {
  return mode === "unrestricted";
}
