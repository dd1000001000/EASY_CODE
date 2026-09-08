import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ToolContext,
  ToolExecutionResult,
  ToolPresentation,
} from "../core/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { describeToolFailure } from "./errors.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";

export function toolFailure(error: unknown, summary = "Tool execution failed"): ToolExecutionResult {
  const failure = describeToolFailure(error);
  const message = failure.kind === "validation" && failure.execution === "not_started"
    ? failure.issues.map((issue) => `${issue.path}: ${issue.message}${issue.expected ? ` Expected ${issue.expected}.` : ""}`).join("\n")
    : error instanceof Error ? error.message : String(error);
  return { ok: false, summary, error: redactSensitiveInformation(message), failure };
}

export function toolSuccess(
  summary: string,
  data?: unknown,
  presentation?: ToolPresentation,
): ToolExecutionResult {
  return {
    ok: true,
    summary,
    ...(data === undefined ? {} : { data }),
    ...(presentation === undefined ? {} : { presentation }),
  };
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
