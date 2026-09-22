import { z } from "zod";
import type { AgentTool, ToolContext, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import type { ThreadDocumentService } from "../resources/thread-document-service.js";
import { fetchPublic, MAX_WEBPAGE_BYTES } from "../resources/web-content.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace, toolFailure, toolSuccess } from "./base.js";
import { documentToolSchema } from "./metadata.js";

const schema = z.object({ url: z.string().url().max(4096) }).strict();

export class FetchWebpageTool implements AgentTool {
  readonly name = "fetch_webpage" as const;
  readonly mutating = false;
  readonly inputSchema = schema;
  readonly definition: ToolDefinition = { type: "function", function: { name: this.name, strict: true,
    ...documentToolSchema(this.name, { type: "object", additionalProperties: false, properties: { url: { type: "string" } }, required: ["url"] }) } };
  constructor(private readonly workspace: WorkspaceManager, private readonly documents: ThreadDocumentService) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      const parsed = schema.parse(input);
      const response = await fetchPublic(parsed.url, {
        signal: context.signal, maxBytes: Math.min(MAX_WEBPAGE_BYTES, this.documents.maxBytes),
      });
      if (!new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown"]).has(response.mediaType)) {
        throw new Error(`Unsupported Web content type: ${response.mediaType}.`);
      }
      const attachment = await this.documents.importWebpage({
        threadId: context.threadId, url: response.url, data: response.data,
        mediaType: response.mediaType, signal: context.signal,
      });
      return toolSuccess(`Saved ${response.url} as read-only Thread resource ${attachment.uri}.`, attachment);
    } catch (error) { return toolFailure(error, "Unable to fetch the Web page"); }
  }
}
