import { z } from "zod";
import path from "node:path";
import type { AgentTool, ToolContext } from "../core/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { CoordinationStore } from "../coordination/store.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { documentToolSchema } from "./metadata.js";
import { toolFailure } from "./base.js";

export class FindFileEditorsTool implements AgentTool {
  readonly name = "find_file_editors";
  readonly mutating = false;
  readonly inputSchema = z.object({ path: z.string().min(1).max(4096) }).strict();
  readonly definition = { type: "function" as const, function: { name: this.name, strict: true,
    ...documentToolSchema(this.name, { type: "object", additionalProperties: false,
      properties: { path: { type: "string" } }, required: ["path"] }) } };
  constructor(private readonly workspace: WorkspaceManager, private readonly store: CoordinationStore) {}
  async execute(input: unknown, context: ToolContext) {
    try {
      const { path } = this.inputSchema.parse(input);
      const filename = await observedFilePath(this.workspace, path);
      return { ok: true, summary: "Threads that observed changes during tool execution; this does not identify who made the changes.",
        data: { path, threads: this.store.find(filename, context.threadId) } };
    } catch (error) { return toolFailure(error, "Unable to query file observers"); }
  }
}

/** Validate surviving ancestors as well as lexical containment, including deleted directories. */
async function observedFilePath(workspace: WorkspaceManager, input: string): Promise<string> {
  const guard = workspace.pathGuard;
  const filename = guard.resolveLexical(input);
  const root = guard.rootForPath?.(filename) ?? guard.root;
  let candidate = filename;
  const suffix: string[] = [];
  while (candidate !== root) {
    try {
      return path.join(await guard.resolveExisting(guard.toRelative(candidate), { allowFinalSymlink: false }), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      suffix.unshift(path.basename(candidate));
      candidate = path.dirname(candidate);
    }
  }
  return path.join(root, ...suffix);
}

export class SendThreadMessageTool implements AgentTool {
  readonly name = "send_thread_message";
  // Writes only Runtime metadata, not the workspace; usable in Plan and during command quarantine.
  readonly mutating = false;
  readonly inputSchema = z.object({ targetThreadId: z.string().regex(/^thread_[a-zA-Z0-9_-]+$/u),
    message: z.string().min(1).max(32000) }).strict();
  readonly definition = { type: "function" as const, function: { name: this.name, strict: true,
    ...documentToolSchema(this.name, { type: "object", additionalProperties: false,
      properties: { targetThreadId: { type: "string" }, message: { type: "string" } },
      required: ["targetThreadId", "message"] }) } };
  constructor(private readonly store: CoordinationStore) {}
  async execute(input: unknown, context: ToolContext) {
    try {
      const { targetThreadId, message } = this.inputSchema.parse(input);
      if (!context.toolCallId) throw new Error("Runtime tool-call identity is required.");
      const data = this.store.send(context.threadId, context.turnId, context.toolCallId, targetThreadId,
        message, context.limits ?? DEFAULT_RUNTIME_LIMITS);
      return { ok: true, summary: `Message to ${targetThreadId} queued, not yet read.`,
        data: { ...data, targetThreadId, message } };
    } catch (error) { return toolFailure(error, "Unable to send Thread message"); }
  }
}
