import { z } from "zod";
import type { AgentTool, ToolContext, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import { fetchPublic, parseSearchHtml } from "../resources/web-content.js";
import { assertMatchingWorkspace, toolFailure, toolSuccess } from "./base.js";
import { documentToolSchema } from "./metadata.js";
import type { WorkspaceManager } from "../workspace/manager.js";

const schema = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(10).optional() }).strict();

export class WebSearchTool implements AgentTool {
  readonly name = "web_search" as const;
  readonly mutating = false;
  readonly inputSchema = schema;
  readonly definition: ToolDefinition = { type: "function", function: { name: this.name, strict: true,
    ...documentToolSchema(this.name, { type: "object", additionalProperties: false, properties: {
      query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 },
    }, required: ["query"] }) } };
  constructor(private readonly workspace: WorkspaceManager) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      const parsed = schema.parse(input);
      const limit = parsed.limit ?? 5;
      const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(parsed.query)}`;
      const response = await fetchPublic(endpoint, { signal: context.signal, accept: "text/html", maxBytes: 2 * 1024 * 1024 });
      if (response.mediaType !== "text/html") throw new Error(`Unexpected search response type: ${response.mediaType}.`);
      const results = parseSearchHtml(response.data.toString("utf8"), limit);
      if (!results.length) throw new Error("The search provider returned no usable results for this query.");
      return toolSuccess(`Found ${results.length} Web result${results.length === 1 ? "" : "s"} for ${parsed.query}.`, { query: parsed.query, results });
    } catch (error) { return toolFailure(error, "Unable to search the Web"); }
  }
}
