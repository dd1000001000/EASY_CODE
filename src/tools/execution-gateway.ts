import type { AgentTool, ToolContext, ToolExecutionResult, ToolName } from "../core/types.js";
import type { ToolCatalogBinding, ToolCatalogSnapshot } from "./catalog.js";
import { toolRequiresApproval } from "./capabilities.js";
import { prepareToolInput } from "./errors.js";
import { normalizeToolContentResult } from "./content.js";

export interface PreparedToolInvocation {
  readonly tool: AgentTool;
  readonly input: unknown;
  readonly binding?: ToolCatalogBinding;
}

export interface ToolExecutionAuthorizationRequest {
  readonly tool: AgentTool;
  readonly input: unknown;
  readonly binding?: ToolCatalogBinding;
  readonly context: ToolContext;
}

export type ToolExecutionAuthorizer = (
  request: Readonly<ToolExecutionAuthorizationRequest>,
) => Promise<boolean>;

/** Name-agnostic lookup, validation, and invocation boundary for Runtime tools. */
export class ToolExecutionGateway {
  private readonly tools = new Map<ToolName, AgentTool>();

  constructor(
    private readonly snapshot: Readonly<ToolCatalogSnapshot>,
    private readonly authorize?: ToolExecutionAuthorizer,
  ) {
    for (const tool of snapshot.tools) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  get catalog(): Readonly<ToolCatalogSnapshot> {
    return this.snapshot;
  }

  get(name: ToolName): AgentTool | undefined {
    return this.tools.get(name);
  }

  prepare(name: ToolName, argumentsJson: string): PreparedToolInvocation | undefined {
    const tool = this.get(name);
    if (!tool) return undefined;
    return {
      tool,
      input: prepareToolInput(tool, argumentsJson),
      binding: this.snapshot.bindings.get(name),
    };
  }

  async invoke(
    invocation: Readonly<PreparedToolInvocation>,
    context: ToolContext,
    activity?: (name: ToolName, execute: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> {
    if (toolRequiresApproval(invocation.tool)) {
      if (!this.authorize) {
        throw new Error(`External tool ${invocation.tool.name} requires a Runtime authorization bridge`);
      }
      const allowed = await this.authorize({
        tool: invocation.tool,
        input: invocation.input,
        binding: invocation.binding,
        context,
      });
      if (!allowed) throw new Error(`External tool ${invocation.tool.name} was not authorized`);
    }
    const execute = () => invocation.tool.execute(invocation.input, context);
    const result = activity ? await activity(invocation.tool.name, execute) : await execute();
    return normalizeToolContentResult(result, context.maxOutputChars);
  }
}
