import type { ApprovalRequest, CommandExecutionMode, ToolContext } from "../core/types.js";

/** One policy shared by command Runtime, file-download tool and approval UI. */
export function autoApproveNetwork(mode: CommandExecutionMode | undefined, effect: NonNullable<ApprovalRequest["network"]>["effect"]): boolean {
  void effect;
  return mode === "unrestricted";
}

export async function requestNetworkApproval(context: ToolContext, request: ApprovalRequest): Promise<boolean> {
  if (!request.network || context.signal?.aborted) return false;
  if (context.commandExecutionMode === "unrestricted" && !(context.isUnrestrictedHostAccessActive?.() ?? true)) return false;
  if (autoApproveNetwork(context.commandExecutionMode, request.network.effect)) return true;
  // Even with prompts disabled, the app can consume a previously granted prefix.
  return context.requestApproval({ ...request, allowPrompt: context.approvalPolicy !== "never", signal: context.signal });
}
