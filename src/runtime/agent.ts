import type {
  AgentMode,
  AgentRunResult,
  AgentTool,
  ApprovalHandler,
  ChatMessage,
  CommandAuditEntry,
  EventRecord,
  ModelProvider,
  SessionState,
  ToolExecutionResult,
  ToolName
} from "../core/types.js";
import { ContextManager } from "../context/manager.js";
import { createId } from "../utils/ids.js";
import { jsonForModel, safeJsonParse } from "../utils/json.js";
import { determineAutoRoute } from "./auto-router.js";

export interface AgentRuntimeDependencies {
  provider: ModelProvider;
  tools: AgentTool[];
  contextManager: ContextManager;
  buildSystemPrompt: (input: {
    mode: AgentMode;
    workspaceSummary: string;
    memories: string[];
  }) => Promise<string>;
  getWorkspaceSummary: () => Promise<string>;
  searchMemories: (query: string) => Promise<string[]>;
  appendEvent: (event: Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp">) => Promise<void>;
  requestApproval: ApprovalHandler;
  recordCommand?: (turnId: string, entry: CommandAuditEntry) => void;
  onToolCompleted?: (
    state: SessionState,
    toolName: string,
    result: ToolExecutionResult
  ) => Promise<void>;
  onText?: (text: string) => void;
  onStatus?: (text: string) => void;
}

export interface AgentRunOptions {
  maxSteps: number;
  maxContextChars: number;
  maxOutputChars: number;
  commandTimeoutMs: number;
  approvalPolicy: "safe" | "ask" | "never";
  signal?: AbortSignal;
}

function availableTools(tools: AgentTool[], mode: AgentMode): AgentTool[] {
  if (mode !== "plan") return tools;
  return tools.filter((tool) => tool.name === "read_file" || tool.name === "run_command");
}

function resultForModel(result: ToolExecutionResult): string {
  return jsonForModel({
    ok: result.ok,
    summary: result.summary,
    data: result.data,
    error: result.error
  });
}

export class AgentRuntime {
  constructor(private readonly dependencies: AgentRuntimeDependencies) {}

  async run(
    state: SessionState,
    userInput: string,
    options: AgentRunOptions
  ): Promise<AgentRunResult> {
    const turnId = createId("turn");
    state.activeTurnId = turnId;
    state.goal = userInput;
    state.updatedAt = new Date().toISOString();
    state.messages.push({ role: "user", content: userInput });

    try {
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "message.user",
      phase: "completed",
      payload: { content: userInput }
    });

    let effectiveMode: AgentMode = state.mode;
    let autoReason = "";
    if (state.mode === "auto") {
      this.dependencies.onStatus?.("Auto mode is choosing how to handle this request...");
      const route = await determineAutoRoute(this.dependencies.provider, userInput, options.signal);
      effectiveMode = route.route === "plan_only" ? "plan" : "code";
      autoReason = route.reason;
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "mode.auto_route",
        phase: "completed",
        payload: route
      });
      this.dependencies.onStatus?.(`Auto mode: ${route.route} — ${route.reason}`);
    }

    const memories = await this.dependencies.searchMemories(userInput);
    const toolMap = new Map<ToolName, AgentTool>();
    for (const tool of availableTools(this.dependencies.tools, effectiveMode)) {
      toolMap.set(tool.name, tool);
    }

    for (let step = 1; step <= options.maxSteps; step += 1) {
      if (options.signal?.aborted) {
        return this.finish(state, turnId, "The task was interrupted by the user.", "interrupted", step - 1);
      }

      const workspaceSummary = await this.dependencies.getWorkspaceSummary();
      const systemPrompt = await this.dependencies.buildSystemPrompt({
        mode: effectiveMode,
        workspaceSummary,
        memories
      });
      const messages = this.dependencies.contextManager.build({
        systemPrompt,
        state,
        maxContextChars: options.maxContextChars
      });

      const enabledTools = [...toolMap.values()];
      this.dependencies.onStatus?.(
        `Step ${step}/${options.maxSteps}: requesting ${this.dependencies.provider.model}`
      );

      let response;
      try {
        response = await this.dependencies.provider.complete({
          messages,
          tools: enabledTools.map((tool) => tool.definition),
          signal: options.signal
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `step_${step}`,
          type: "model.error",
          phase: "failed",
          payload: { message }
        });
        const interrupted = Boolean(options.signal?.aborted);
        return this.finish(
          state,
          turnId,
          interrupted ? "The task was interrupted by the user." : `Model request failed: ${message}`,
          interrupted ? "interrupted" : "failed",
          step
        );
      }

      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response.message.content,
        tool_calls: response.message.tool_calls,
        reasoning_content: response.message.reasoning_content
      };
      state.messages.push(assistantMessage);
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        stepId: `step_${step}`,
        type: "message.assistant",
        phase: "completed",
        payload: assistantMessage
      });

      const calls = response.message.tool_calls ?? [];
      if (calls.length === 0) {
        const text =
          response.message.content?.trim() ||
          "The task ended, but the model did not provide an explanation.";
        this.dependencies.onText?.(text);
        const reason = effectiveMode === "plan" ? "planned" : "success";
        const prefix = state.mode === "auto" && autoReason ? `Auto decision: ${autoReason}\n\n` : "";
        return this.finish(state, turnId, `${prefix}${text}`, reason, step);
      }

      for (const call of calls) {
        const toolName = call.function.name as ToolName;
        const tool = toolMap.get(toolName);
        let result: ToolExecutionResult;

        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `step_${step}`,
          type: "tool.call",
          phase: "requested",
          payload: call
        });

        if (!tool) {
          result = {
            ok: false,
            summary: `Tool ${call.function.name} is not available in the current mode.`,
            error: "tool_not_available"
          };
        } else {
          try {
            const input = safeJsonParse(call.function.arguments);
            this.dependencies.onStatus?.(`Tool: ${tool.name}`);
            result = await tool.execute(input, {
              workspaceRoot: state.workspaceRoot,
              mode: effectiveMode,
              threadId: state.threadId,
              turnId,
              approvalPolicy: options.approvalPolicy,
              requestApproval: this.dependencies.requestApproval,
              signal: options.signal,
              commandTimeoutMs: options.commandTimeoutMs,
              maxOutputChars: options.maxOutputChars,
              recordCommand: (entry) => {
                state.commands.push(entry);
                this.dependencies.recordCommand?.(turnId, entry);
              }
            });
          } catch (error) {
            result = {
              ok: false,
              summary: `Tool ${call.function.name} failed.`,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }

        const toolMessage: ChatMessage = {
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: resultForModel(result).slice(0, options.maxOutputChars)
        };
        state.messages.push(toolMessage);
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `step_${step}`,
          type: "tool.result",
          phase: result.ok ? "completed" : "failed",
          payload: { callId: call.id, tool: call.function.name, message: toolMessage }
        });
        await this.dependencies.onToolCompleted?.(state, call.function.name, result);
      }
    }

    return this.finish(
      state,
      turnId,
      `Reached the maximum of ${options.maxSteps} steps before the task could be confirmed complete.`,
      "limit_reached",
      options.maxSteps
    );
    } catch (error) {
      const interrupted = Boolean(options.signal?.aborted);
      const message = error instanceof Error ? error.message : String(error);
      const result: AgentRunResult = {
        text: interrupted ? "The task was interrupted by the user." : `Agent run failed: ${message}`,
        reason: interrupted ? "interrupted" : "failed",
        steps: 0,
        threadId: state.threadId,
        turnId
      };
      if (state.activeTurnId === turnId) {
        try {
          return await this.finish(
            state,
            turnId,
            result.text,
            result.reason,
            result.steps
          );
        } catch {
          state.activeTurnId = undefined;
          state.updatedAt = new Date().toISOString();
        }
      }
      return result;
    }
  }

  private async finish(
    state: SessionState,
    turnId: string,
    text: string,
    reason: AgentRunResult["reason"],
    steps: number
  ): Promise<AgentRunResult> {
    state.activeTurnId = undefined;
    state.updatedAt = new Date().toISOString();
    const lastMessage = state.messages[state.messages.length - 1];
    if (
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      Boolean(lastMessage.tool_calls?.length) ||
      !lastMessage.content?.trim()
    ) {
      const syntheticMessage: ChatMessage = { role: "assistant", content: text };
      state.messages.push(syntheticMessage);
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "message.assistant",
        phase: "completed",
        payload: syntheticMessage
      });
    }
    const result = { text, reason, steps, threadId: state.threadId, turnId };
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "turn.completed",
      phase: "completed",
      payload: { reason, steps }
    });
    return result;
  }
}
