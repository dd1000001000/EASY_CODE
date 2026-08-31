import path from "node:path";

import { z } from "zod";

import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace, toolFailure } from "./base.js";
import { documentToolSchema } from "./metadata.js";

export const readImageInputSchema = z
  .object({
    path: z.string().min(1).max(4_096),
  })
  .strict();

export class ReadImageTool implements AgentTool {
  readonly name = "read_image" as const;
  readonly mutating = false;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      }),
    },
  };

  constructor(private readonly workspace: WorkspaceManager) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      if (!context.attachImage) {
        throw new Error("The current model cannot receive image tool results.");
      }
      const parsed = readImageInputSchema.parse(input);
      const relative = this.workspace.pathGuard.normalizeRelative(parsed.path);
      const absolutePath = await this.workspace.pathGuard.resolveExisting(relative, {
        kind: "file",
      });
      const attachment = await context.attachImage({
        absolutePath,
        sourceName: relative.split(path.sep).join("/"),
      });
      return {
        ok: true,
        summary: `Loaded ${relative} as ${attachment.label}.`,
        data: {
          path: relative,
          label: attachment.label,
          mediaType: attachment.mediaType,
          width: attachment.width,
          height: attachment.height,
          byteSize: attachment.byteSize,
          sha256: attachment.sha256,
        },
        imageAttachments: [attachment],
      };
    } catch (error) {
      return toolFailure(error, "Unable to read image");
    }
  }
}
