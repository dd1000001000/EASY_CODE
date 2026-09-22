import { z } from "zod";
import type { AgentTool, ToolContext, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import { SkillStore } from "../skills/store.js";
import type { SkillScope } from "../skills/store.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace, assertWritableMode, toolFailure, toolSuccess } from "./base.js";
import { documentToolSchema } from "./metadata.js";

const scopeSchema = z.enum(["global", "project"]);
const nameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const versionSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const relativeFileSchema = z.string().min(1);
const skillFileSchema = z.object({ path: relativeFileSchema, content: z.string() }).strict();
const changeSchema = z.object({
  operation: z.enum(["upsert", "remove"]),
  path: relativeFileSchema,
  content: z.string().optional(),
}).strict();

export const listSkillsInputSchema = z.object({}).strict();
export const readSkillInputSchema = z.object({
  scope: scopeSchema, name: nameSchema, path: relativeFileSchema.optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
}).strict();
export const createSkillInputSchema = z.object({
  scope: scopeSchema, name: nameSchema, description: z.string().min(1),
  instructions: z.string().min(1), files: z.array(skillFileSchema).optional(),
}).strict();
export const modifySkillInputSchema = z.object({
  scope: scopeSchema, name: nameSchema, expectedVersion: versionSchema,
  skillMarkdown: z.string().optional(), files: z.array(changeSchema).optional(),
}).strict();
export const deleteSkillInputSchema = z.object({
  scope: scopeSchema, name: nameSchema, expectedVersion: versionSchema,
}).strict();

const scopeProperty = { type: "string", enum: ["global", "project"] };
const nameProperty = { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" };
const versionProperty = { type: "string", pattern: "^[a-f0-9]{64}$" };
const fileProperty = {
  type: "object", additionalProperties: false,
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
};

function definition(name: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return { type: "function", function: { name, strict: false,
    ...documentToolSchema(name, { type: "object", additionalProperties: false, properties, required }),
  } };
}

abstract class SkillTool {
  constructor(protected readonly workspace: WorkspaceManager, protected readonly store: SkillStore) {}

  protected async assertAccess(context: ToolContext, mutating: boolean): Promise<void> {
    await assertMatchingWorkspace(this.workspace, context);
    if (mutating) {
      assertWritableMode(context);
      if (context.agentRole && context.agentRole !== "main_agent") {
        throw new Error("Only the main agent may change Skill resources");
      }
    }
  }

  protected approvalFor(input: unknown, operation: string) {
    const value = input as { scope?: SkillScope; name?: string };
    const scope = value?.scope ?? "unknown";
    const name = value?.name ?? "unknown";
    return { name: `${operation}:${scope}:${name}`, label: `${operation} ${scope}/${name}`,
      description: `Operate only on the ${scope} Skill ${name}` };
  }
}

export class ListSkillsTool extends SkillTool implements AgentTool {
  readonly name = "list_skills" as const;
  readonly mutating = false;
  readonly inputSchema = listSkillsInputSchema;
  readonly definition = definition(this.name, {}, []);

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await this.assertAccess(context, false);
      this.inputSchema.parse(input);
      return toolSuccess("Listed global and project Skills", await this.store.list());
    } catch (error) { return toolFailure(error, "Unable to list Skills"); }
  }
}

export class ReadSkillTool extends SkillTool implements AgentTool {
  readonly name = "read_skill" as const;
  readonly mutating = false;
  readonly inputSchema = readSkillInputSchema;
  readonly definition = definition(this.name, {
    scope: scopeProperty, name: nameProperty, path: { type: "string" },
    startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 },
  }, ["scope", "name"]);
  readonly approvalTarget = (input: unknown) => this.approvalFor(input, "read_skill");

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await this.assertAccess(context, false);
      const request = this.inputSchema.parse(input);
      const result = await this.store.read(request.scope, request.name, request.path);
      const lines = result.content.split(/\r\n|\n|\r/u);
      const startLine = request.startLine ?? 1;
      if (startLine > lines.length) throw new Error("startLine is beyond the Skill file");
      const maxLines = context.limits?.maxReadLines ?? 500;
      const endLine = Math.min(request.endLine ?? lines.length, startLine + maxLines - 1, lines.length);
      if (endLine < startLine) throw new Error("endLine must not precede startLine");
      return toolSuccess(`Read ${request.scope}/${request.name}/${result.relativePath} lines ${startLine}-${endLine}`, {
        ...result, content: lines.slice(startLine - 1, endLine).join("\n"),
        startLine, endLine, totalLines: lines.length,
        nextStartLine: endLine < lines.length ? endLine + 1 : null,
      });
    } catch (error) { return toolFailure(error, "Unable to read Skill"); }
  }
}

export class CreateSkillTool extends SkillTool implements AgentTool {
  readonly name = "create_skill" as const;
  readonly mutating = true;
  readonly inputSchema = createSkillInputSchema;
  readonly definition = definition(this.name, {
    scope: scopeProperty, name: nameProperty, description: { type: "string" },
    instructions: { type: "string" }, files: { type: "array", items: fileProperty },
  }, ["scope", "name", "description", "instructions"]);
  readonly approvalTarget = (input: unknown) => this.approvalFor(input, "create_skill");

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await this.assertAccess(context, true);
      const request = this.inputSchema.parse(input);
      const result = await this.store.create(request.scope, request.name, request.description,
        request.instructions, request.files, context.signal);
      return toolSuccess(`Created ${request.scope} Skill ${request.name}`, {
        scope: result.scope, name: result.name, directory: result.directory,
        version: result.version, files: result.files,
      });
    } catch (error) { return toolFailure(error, "Unable to create Skill"); }
  }
}

export class ModifySkillTool extends SkillTool implements AgentTool {
  readonly name = "modify_skill" as const;
  readonly mutating = true;
  readonly inputSchema = modifySkillInputSchema;
  readonly definition = definition(this.name, {
    scope: scopeProperty, name: nameProperty, expectedVersion: versionProperty,
    skillMarkdown: { type: "string" },
    files: { type: "array", items: { type: "object", additionalProperties: false,
      properties: { operation: { type: "string", enum: ["upsert", "remove"] },
        path: { type: "string" }, content: { type: "string" } },
      required: ["operation", "path"] } },
  }, ["scope", "name", "expectedVersion"]);
  readonly approvalTarget = (input: unknown) => this.approvalFor(input, "modify_skill");

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await this.assertAccess(context, true);
      const request = this.inputSchema.parse(input);
      const result = await this.store.modify(request.scope, request.name, request.expectedVersion,
        request.skillMarkdown, request.files, context.signal);
      return toolSuccess(`Modified ${request.scope} Skill ${request.name}`, {
        scope: result.scope, name: result.name, directory: result.directory,
        version: result.version, files: result.files,
      });
    } catch (error) { return toolFailure(error, "Unable to modify Skill"); }
  }
}

export class DeleteSkillTool extends SkillTool implements AgentTool {
  readonly name = "delete_skill" as const;
  readonly mutating = true;
  readonly inputSchema = deleteSkillInputSchema;
  readonly definition = definition(this.name, {
    scope: scopeProperty, name: nameProperty, expectedVersion: versionProperty,
  }, ["scope", "name", "expectedVersion"]);
  readonly approvalTarget = (input: unknown) => this.approvalFor(input, "delete_skill");

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await this.assertAccess(context, true);
      const request = this.inputSchema.parse(input);
      const result = await this.store.delete(request.scope, request.name, request.expectedVersion, context.signal);
      return toolSuccess(`Archived ${request.scope} Skill ${request.name}`, result);
    } catch (error) { return toolFailure(error, "Unable to delete Skill"); }
  }
}
