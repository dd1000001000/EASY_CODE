import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace, toolFailure, toolSuccess } from "./base.js";

export const readFileInputSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  })
  .strict();

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

export interface ReadFileOutput {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  encoding: "utf-8";
  newline: "lf" | "crlf" | "cr" | "none" | "mixed";
  contentHash: string;
  truncated: boolean;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LINES_PER_READ = 500;

function detectNewline(text: string): ReadFileOutput["newline"] {
  const crlf = (text.match(/\r\n/gu) ?? []).length;
  const withoutCrlf = text.replace(/\r\n/gu, "");
  const lf = (withoutCrlf.match(/\n/gu) ?? []).length;
  const cr = (withoutCrlf.match(/\r/gu) ?? []).length;
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  if (kinds > 1) return "mixed";
  if (crlf > 0) return "crlf";
  if (lf > 0) return "lf";
  if (cr > 0) return "cr";
  return "none";
}

export class ReadFileTool implements AgentTool {
  readonly name = "read_file" as const;
  readonly mutating = false;
  readonly inputSchema = readFileInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      description:
        "Read a UTF-8 text file inside the workspace by a 1-based line range and return its full-file SHA-256 version hash.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        required: ["path"],
      },
    },
  };

  constructor(private readonly workspace: WorkspaceManager) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      const parsed = this.inputSchema.parse(input);
      const relative = this.workspace.pathGuard.normalizeRelative(parsed.path);
      const filename = await this.workspace.pathGuard.resolveExisting(relative, {
        kind: "file",
        allowFinalSymlink: true,
      });
      const buffer = await readFile(filename);
      if (buffer.length > MAX_FILE_BYTES) {
        throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte read limit`);
      }
      if (buffer.includes(0)) {
        throw new Error("Binary files are not supported");
      }

      const text = buffer.toString("utf8");
      const lines = text.split(/\r\n|\n|\r/u);
      const totalLines = lines.length;
      const startLine = parsed.startLine ?? 1;
      if (startLine > totalLines) {
        throw new Error(`startLine ${startLine} is beyond the file's ${totalLines} lines`);
      }
      const requestedEnd = parsed.endLine ?? totalLines;
      if (requestedEnd < startLine) {
        throw new Error("endLine must be greater than or equal to startLine");
      }
      const endLine = Math.min(requestedEnd, totalLines, startLine + MAX_LINES_PER_READ - 1);
      const contentHash = sha256(buffer);
      this.workspace.recordRead(relative, contentHash);

      const output: ReadFileOutput = {
        path: relative,
        content: lines.slice(startLine - 1, endLine).join("\n"),
        startLine,
        endLine,
        totalLines,
        encoding: "utf-8",
        newline: detectNewline(text),
        contentHash,
        truncated: endLine < requestedEnd || endLine < totalLines,
      };
      return toolSuccess(`Read ${relative} lines ${startLine}-${endLine}`, output);
    } catch (error) {
      return toolFailure(error, "Unable to read file");
    }
  }
}

