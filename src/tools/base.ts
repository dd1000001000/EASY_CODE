import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolExecutionResult } from "../core/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";

export function toolFailure(error: unknown, summary = "Tool execution failed"): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, summary, error: message };
}

export function toolSuccess(summary: string, data?: unknown): ToolExecutionResult {
  return data === undefined ? { ok: true, summary } : { ok: true, summary, data };
}

export async function assertMatchingWorkspace(
  manager: WorkspaceManager,
  context: ToolContext,
): Promise<void> {
  const contextRoot = path.normalize(await realpath(path.resolve(context.workspaceRoot)));
  const expected = process.platform === "win32" ? manager.root.toLowerCase() : manager.root;
  const actual = process.platform === "win32" ? contextRoot.toLowerCase() : contextRoot;
  if (expected !== actual) {
    throw new Error("Tool context does not match the bound workspace");
  }
}

export function assertWritableMode(context: ToolContext): void {
  if (context.mode === "plan") {
    throw new Error("File mutation is disabled in plan mode");
  }
}

