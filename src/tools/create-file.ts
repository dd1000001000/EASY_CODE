import { open, readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import {
  assertMatchingWorkspace,
  assertWritableMode,
  toolFailure,
  toolSuccess,
} from "./base.js";
import {
  acquireHostFileMutationLock,
  assertHostFileMutationStillAllowed,
  prepareCreateFileToolTarget,
  recordFileToolRead,
  refreshWorkspaceForFileToolTarget,
  resolveCreateFileToolTarget,
} from "./file-access.js";

export const createFileInputSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    content: z.string().max(2 * 1024 * 1024),
    encoding: z.literal("utf-8").optional(),
  })
  .strict();

export type CreateFileInput = z.infer<typeof createFileInputSchema>;

export class CreateFileTool implements AgentTool {
  readonly name = "create_file" as const;
  readonly mutating = true;
  readonly inputSchema = createFileInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      description:
        "Create a new UTF-8 text file. The operation fails if the file already exists. Paths are workspace-relative unless the user explicitly enabled unrestricted host access.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description:
              "Workspace-relative file path, or an absolute host path only in unrestricted mode",
          },
          content: { type: "string" },
          encoding: { type: "string", enum: ["utf-8"] },
        },
        required: ["path", "content"],
      },
    },
  };

  constructor(private readonly workspace: WorkspaceManager) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    let createdTarget: string | undefined;
    let releaseHostMutation: (() => void) | undefined;
    try {
      await assertMatchingWorkspace(this.workspace, context);
      assertWritableMode(context);
      const parsed = this.inputSchema.parse(input);
      const target = await resolveCreateFileToolTarget(this.workspace, context, parsed.path);
      releaseHostMutation = await acquireHostFileMutationLock(target, context.signal);
      await prepareCreateFileToolTarget(context, target);
      const handle = await open(target.absolutePath, "wx", 0o666);
      createdTarget = target.absolutePath;
      try {
        assertHostFileMutationStillAllowed(context, target);
        await handle.writeFile(parsed.content, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }

      const hash = sha256(Buffer.from(parsed.content, "utf8"));
      const verifiedHash = sha256(await readFile(target.absolutePath));
      assertHostFileMutationStillAllowed(context, target);
      if (verifiedHash !== hash) {
        throw new Error("New file verification failed");
      }
      // The file is now a verified result. Later bookkeeping failures must not
      // erase a successfully created user-visible file.
      createdTarget = undefined;
      const timestamp = new Date().toISOString();
      recordFileToolRead(this.workspace, target, hash, context);
      if (target.workspaceRelative) {
        this.workspace.recordChange({
          path: target.workspaceRelative,
          operation: "create",
          afterHash: hash,
          source: "file_tool",
          status: "verified",
          timestamp,
        });
      }
      await refreshWorkspaceForFileToolTarget(this.workspace, target);

      return toolSuccess(`Created ${target.displayPath}`, {
        path: target.displayPath,
        contentHash: hash,
        bytesWritten: Buffer.byteLength(parsed.content, "utf8"),
      }, {
        type: "file_diff",
        operation: "create",
        path: target.displayPath,
        before: "",
        after: parsed.content,
      });
    } catch (error) {
      if (createdTarget) {
        try {
          await unlink(createdTarget);
        } catch {
          // Only clean up a target this invocation created; leave unknown files alone.
        }
      }
      return toolFailure(error, "Unable to create file");
    } finally {
      releaseHostMutation?.();
    }
  }
}
