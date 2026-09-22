import { z } from "zod";
import type { AgentTool, ToolContext, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import type { ThreadResourceStore } from "../resources/thread-resource-store.js";
import { fetchPublic, htmlToMarkdown } from "../resources/web-content.js";
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
  constructor(private readonly workspace: WorkspaceManager, private readonly resources: ThreadResourceStore) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      const parsed = schema.parse(input);
      const response = await fetchPublic(parsed.url, { signal: context.signal });
      if (!new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown"]).has(response.mediaType)) {
        throw new Error(`Unsupported Web content type: ${response.mediaType}.`);
      }
      const source = response.data.toString("utf8");
      const converted = response.mediaType === "text/html" || response.mediaType === "application/xhtml+xml"
        ? htmlToMarkdown(source, response.url)
        : { title: new URL(response.url).hostname, markdown: `# ${new URL(response.url).hostname}\n\nSource: ${response.url}\n\n${source}` };
      const attachment = await this.resources.create({
        threadId: context.threadId,
        filename: `${converted.title.replace(/[\\/:*?"<>|]/gu, " ").trim().slice(0, 120) || "webpage"}.md`,
        kind: "webpage", mediaType: "text/markdown", markdown: converted.markdown,
        byteSize: response.data.byteLength, sourceUrl: response.url,
      });
      return toolSuccess(`Saved ${response.url} as read-only Thread resource ${attachment.uri}.`, attachment);
    } catch (error) { return toolFailure(error, "Unable to fetch the Web page"); }
  }
}
