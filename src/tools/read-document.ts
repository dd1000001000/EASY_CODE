import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool, ToolContext, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import type { ThreadDocumentService } from "../resources/index.js";
import { sha256 } from "../utils/hash.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace, toolFailure, toolSuccess } from "./base.js";
import { recordFileToolRead, resolveExistingFileToolTarget } from "./file-access.js";
import { documentToolSchema } from "./metadata.js";

export const readDocumentInputSchema = z.object({
  path: z.string().min(1).max(4_096),
}).strict();

/** Converts one workspace document into an immutable, Thread-owned Markdown snapshot. */
export class ReadDocumentTool implements AgentTool {
  readonly name = "read_document" as const;
  readonly mutating = false;
  readonly inputSchema = readDocumentInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" } },
        required: ["path"],
      }),
    },
  };

  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly documents: ThreadDocumentService,
  ) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      const parsed = readDocumentInputSchema.parse(input);
      const target = await resolveExistingFileToolTarget(this.workspace, context, parsed.path, { kind: "file" });
      const info = await stat(target.absolutePath);
      if (!info.isFile() || info.size > this.documents.maxBytes) {
        throw new Error(`Document exceeds the configured ${this.documents.maxBytes}-byte limit.`);
      }
      const data = await readFile(target.absolutePath, { signal: context.signal });
      if (data.byteLength > this.documents.maxBytes) {
        throw new Error(`Document exceeds the configured ${this.documents.maxBytes}-byte limit.`);
      }
      const attachment = await this.documents.import({
        threadId: context.threadId,
        data,
        filename: target.displayPath,
        signal: context.signal,
      });
      recordFileToolRead(this.workspace, target, sha256(data), context);
      return toolSuccess(
        `Converted ${target.displayPath} to read-only Thread resource ${attachment.uri}.`,
        { path: target.displayPath, ...attachment, readOnly: true },
      );
    } catch (error) {
      return toolFailure(error, "Unable to read document");
    }
  }
}
