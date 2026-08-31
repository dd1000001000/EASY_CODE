import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
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
  getFileToolReadVersion,
  invalidateFileToolReadVersion,
  refreshWorkspaceForFileToolTarget,
  resolveExistingFileToolTarget,
  type FileToolTarget,
} from "./file-access.js";
import { documentToolSchema } from "./metadata.js";

export const deleteFileInputSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    expectedHash: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  })
  .strict();

export type DeleteFileInput = z.infer<typeof deleteFileInputSchema>;

/** Deletes only the exact regular-file version previously returned by read_file. */
export class DeleteFileTool implements AgentTool {
  readonly name = "delete_file" as const;
  readonly mutating = true;
  readonly inputSchema = deleteFileInputSchema;
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
          expectedHash: {
            type: "string",
            pattern: "^[a-fA-F0-9]{64}$",
          },
        },
        required: ["path", "expectedHash"],
      }),
    },
  };

  constructor(private readonly workspace: WorkspaceManager) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    let target: FileToolTarget | undefined;
    let expectedHash: string | undefined;
    let releaseHostMutation: (() => void) | undefined;
    try {
      await assertMatchingWorkspace(this.workspace, context);
      assertWritableMode(context);
      const parsed = this.inputSchema.parse(input);
      target = await resolveExistingFileToolTarget(this.workspace, context, parsed.path, {
        kind: "file",
        allowFinalSymlink: false,
      });
      releaseHostMutation = await acquireHostFileMutationLock(target, context.signal);
      assertHostFileMutationStillAllowed(context, target);
      expectedHash = parsed.expectedHash.toLowerCase();

      const readVersion = getFileToolReadVersion(this.workspace, target, context);
      if (!readVersion) {
        throw new Error("File must be successfully read before it can be deleted");
      }
      if (readVersion.hash.toLowerCase() !== expectedHash) {
        throw new Error("expectedHash does not match the last successfully read version");
      }

      const filename = target.absolutePath;
      const originalBuffer = await readFile(filename);
      if (originalBuffer.includes(0)) {
        throw new Error("Binary files are not supported");
      }
      const currentHash = sha256(originalBuffer);
      if (currentHash !== expectedHash) {
        this.recordConflict(target, expectedHash, currentHash);
        throw new Error("File changed after it was read; read it again before deleting");
      }

      if (context.signal?.aborted) {
        throw new Error("File deletion was canceled before the file was changed");
      }

      // Re-resolve the lexical path immediately before deletion. This catches
      // an ancestor or final target replaced by a symlink/junction after the
      // first resolution. Comparing a second full-file hash catches content
      // changes made while this operation was being prepared. Node does not
      // expose a portable atomic compare-and-unlink primitive, so this is the
      // same best-effort compare-before-mutation boundary used by update_file.
      const confirmedTarget = await resolveExistingFileToolTarget(this.workspace, context, parsed.path, {
        kind: "file",
        allowFinalSymlink: false,
      });
      const confirmedFilename = confirmedTarget.absolutePath;
      if (!samePath(filename, confirmedFilename)) {
        throw new Error("File path changed while deletion was being prepared");
      }
      const confirmedHash = sha256(await readFile(confirmedFilename));
      if (confirmedHash !== expectedHash) {
        this.recordConflict(target, expectedHash, confirmedHash);
        throw new Error("File changed while deletion was being prepared");
      }

      assertHostFileMutationStillAllowed(context, target);
      await unlink(confirmedFilename);

      invalidateFileToolReadVersion(this.workspace, target);
      if (target.workspaceRelative) {
        this.workspace.recordChange({
          path: target.workspaceRelative,
          operation: "delete",
          beforeHash: currentHash,
          source: "file_tool",
          status: "verified",
          timestamp: new Date().toISOString(),
        });
      }
      await refreshWorkspaceForFileToolTarget(this.workspace, target);

      return toolSuccess(
        `Deleted ${target.displayPath}`,
        {
          path: target.displayPath,
          beforeHash: currentHash,
          bytesDeleted: originalBuffer.length,
        },
        {
          type: "file_diff",
          operation: "delete",
          path: target.displayPath,
          before: originalBuffer.toString("utf8"),
          after: "",
        },
      );
    } catch (error) {
      return toolFailure(error, "Unable to delete file");
    } finally {
      releaseHostMutation?.();
    }
  }

  private recordConflict(target: FileToolTarget, expectedHash: string, actualHash: string): void {
    if (!target.workspaceRelative) return;
    this.workspace.recordChange({
      path: target.workspaceRelative,
      operation: "delete",
      beforeHash: expectedHash,
      afterHash: actualHash,
      source: "file_tool",
      status: "conflict",
      timestamp: new Date().toISOString(),
    });
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
