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
      description:
        "Delete a previously read regular workspace file only if its current SHA-256 hash still matches expectedHash.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          expectedHash: {
            type: "string",
            pattern: "^[a-fA-F0-9]{64}$",
            description: "Full-file SHA-256 hash returned by read_file",
          },
        },
        required: ["path", "expectedHash"],
      },
    },
  };

  constructor(private readonly workspace: WorkspaceManager) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    let relative: string | undefined;
    let expectedHash: string | undefined;
    try {
      await assertMatchingWorkspace(this.workspace, context);
      assertWritableMode(context);
      const parsed = this.inputSchema.parse(input);
      relative = this.workspace.pathGuard.normalizeRelative(parsed.path);
      expectedHash = parsed.expectedHash.toLowerCase();

      const readVersion = this.workspace.getReadVersion(relative);
      if (!readVersion) {
        throw new Error("File must be successfully read before it can be deleted");
      }
      if (readVersion.hash.toLowerCase() !== expectedHash) {
        throw new Error("expectedHash does not match the last successfully read version");
      }

      const filename = await this.workspace.pathGuard.resolveExisting(relative, {
        kind: "file",
        allowFinalSymlink: false,
      });
      const originalBuffer = await readFile(filename);
      if (originalBuffer.includes(0)) {
        throw new Error("Binary files are not supported");
      }
      const currentHash = sha256(originalBuffer);
      if (currentHash !== expectedHash) {
        this.recordConflict(relative, expectedHash, currentHash);
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
      const confirmedFilename = await this.workspace.pathGuard.resolveExisting(relative, {
        kind: "file",
        allowFinalSymlink: false,
      });
      if (!samePath(filename, confirmedFilename)) {
        throw new Error("File path changed while deletion was being prepared");
      }
      const confirmedHash = sha256(await readFile(confirmedFilename));
      if (confirmedHash !== expectedHash) {
        this.recordConflict(relative, expectedHash, confirmedHash);
        throw new Error("File changed while deletion was being prepared");
      }

      await unlink(confirmedFilename);

      this.workspace.invalidateReadVersion(relative);
      this.workspace.recordChange({
        path: relative,
        operation: "delete",
        beforeHash: currentHash,
        source: "file_tool",
        status: "verified",
        timestamp: new Date().toISOString(),
      });
      await this.workspace.refreshManifest();

      return toolSuccess(
        `Deleted ${relative}`,
        {
          path: relative,
          beforeHash: currentHash,
          bytesDeleted: originalBuffer.length,
        },
        {
          type: "file_diff",
          operation: "delete",
          path: relative,
          before: originalBuffer.toString("utf8"),
          after: "",
        },
      );
    } catch (error) {
      return toolFailure(error, "Unable to delete file");
    }
  }

  private recordConflict(pathname: string, expectedHash: string, actualHash: string): void {
    this.workspace.recordChange({
      path: pathname,
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
