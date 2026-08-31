import { randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
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
  recordFileToolRead,
  refreshWorkspaceForFileToolTarget,
  resolveExistingFileToolTarget,
  type FileToolTarget,
} from "./file-access.js";
import { documentToolSchema } from "./metadata.js";

export const textEditSchema = z
  .object({
    oldText: z.string().min(1).max(1024 * 1024),
    newText: z.string().max(1024 * 1024),
    replaceAll: z.boolean().optional(),
  })
  .strict();

export const updateFileInputSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    expectedHash: z.string().regex(/^[a-fA-F0-9]{64}$/u),
    edits: z.array(textEditSchema).min(1).max(100),
  })
  .strict();

export type UpdateFileInput = z.infer<typeof updateFileInputSchema>;

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(search, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + search.length;
  }
}

export class UpdateFileTool implements AgentTool {
  readonly name = "update_file" as const;
  readonly mutating = true;
  readonly inputSchema = updateFileInputSchema;
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
          expectedHash: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
          edits: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                oldText: { type: "string", minLength: 1 },
                newText: { type: "string" },
                replaceAll: { type: "boolean" },
              },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "expectedHash", "edits"],
      }),
    },
  };

  constructor(private readonly workspace: WorkspaceManager) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    let temporaryPath: string | undefined;
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
        throw new Error("File must be successfully read before it can be updated");
      }
      if (readVersion.hash.toLowerCase() !== expectedHash) {
        throw new Error("expectedHash does not match the last successfully read version");
      }

      const filename = target.absolutePath;
      const originalBuffer = await readFile(filename);
      if (originalBuffer.includes(0)) throw new Error("Binary files are not supported");
      const currentHash = sha256(originalBuffer);
      if (currentHash !== expectedHash) {
        this.recordConflict(target, expectedHash, currentHash);
        throw new Error("File changed after it was read; read it again before updating");
      }

      const original = originalBuffer.toString("utf8");
      let updated = original;
      for (const [index, edit] of parsed.edits.entries()) {
        const occurrences = countOccurrences(updated, edit.oldText);
        if (occurrences === 0) {
          throw new Error(`Edit ${index + 1} oldText was not found`);
        }
        if (!edit.replaceAll && occurrences !== 1) {
          throw new Error(
            `Edit ${index + 1} oldText matched ${occurrences} locations; set replaceAll or provide unique context`,
          );
        }
        updated = edit.replaceAll
          ? updated.split(edit.oldText).join(edit.newText)
          : updated.replace(edit.oldText, edit.newText);
      }

      const updatedBuffer = Buffer.from(updated, "utf8");
      const afterHash = sha256(updatedBuffer);
      if (afterHash === currentHash) {
        throw new Error("Edits did not change the file");
      }

      const originalInfo = await stat(filename);
      assertHostFileMutationStillAllowed(context, target);
      temporaryPath = path.join(
        path.dirname(filename),
        `.${path.basename(filename)}.easy-code-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
      );
      const handle = await open(temporaryPath, "wx", originalInfo.mode);
      try {
        await handle.writeFile(updatedBuffer);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporaryPath, originalInfo.mode);

      // Best-effort compare immediately before atomic replacement. A true
      // compare-and-swap requires platform-specific filesystem support.
      const beforeRenameHash = sha256(await readFile(filename));
      if (beforeRenameHash !== expectedHash) {
        this.recordConflict(target, expectedHash, beforeRenameHash);
        throw new Error("File changed while the update was being prepared");
      }

      assertHostFileMutationStillAllowed(context, target);
      await rename(temporaryPath, filename);
      temporaryPath = undefined;
      const verifiedHash = sha256(await readFile(filename));
      if (verifiedHash !== afterHash) {
        throw new Error("Atomic update verification failed");
      }

      const timestamp = new Date().toISOString();
      recordFileToolRead(this.workspace, target, afterHash, context);
      if (target.workspaceRelative) {
        this.workspace.recordChange({
          path: target.workspaceRelative,
          operation: "update",
          beforeHash: currentHash,
          afterHash,
          source: "file_tool",
          status: "verified",
          timestamp,
        });
      }
      await refreshWorkspaceForFileToolTarget(this.workspace, target);

      return toolSuccess(`Updated ${target.displayPath}`, {
        path: target.displayPath,
        beforeHash: currentHash,
        contentHash: afterHash,
        editsApplied: parsed.edits.length,
        bytesWritten: updatedBuffer.length,
      }, {
        type: "file_diff",
        operation: "update",
        path: target.displayPath,
        before: original,
        after: updated,
      });
    } catch (error) {
      if (temporaryPath) {
        try {
          await unlink(temporaryPath);
        } catch {
          // A verified EASY CODE temp path is the only cleanup target.
        }
      }
      return toolFailure(error, "Unable to update file");
    } finally {
      releaseHostMutation?.();
    }
  }

  private recordConflict(target: FileToolTarget, expectedHash: string, actualHash: string): void {
    if (!target.workspaceRelative) return;
    this.workspace.recordChange({
      path: target.workspaceRelative,
      operation: "update",
      beforeHash: expectedHash,
      afterHash: actualHash,
      source: "file_tool",
      status: "conflict",
      timestamp: new Date().toISOString(),
    });
  }
}
