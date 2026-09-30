/** Informational slash commands: /status, /agents, /tools, /skills, /permissions, /memory, /sessions. */

import { TaskBudget } from "../runtime/task-budget.js";
import type { AppInteractionPort } from "../ui/interaction-port.js";
import { SkillStore } from "../skills/store.js";
import { sanitizeTerminalText } from "../ui/render/layout.js";
import { formatCommandApprovalPrefix } from "../command/approval.js";
import type { CommandExecutionMode, EasyCodeConfig, ImageAttachment, SessionState } from "../core/types.js";
import { MemoryManager, projectMemoryIdFromRoot } from "../memory/memory-manager.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { modelSupportsVision } from "../models/catalog.js";
import { thinkingEffortIsApplied } from "../models/thinking.js";
import { workspaceIdFromRoot, type EasyCodeStorage } from "../storage/database.js";
import { SubagentCoordinator } from "../subagents/coordinator.js";
import { isToolAvailable, toolMetadata } from "../tools/capabilities.js";
import { type ToolCatalogSnapshot } from "../tools/catalog.js";
import { ThreadStore, type ThreadSummary } from "../threads/thread-store.js";
import { taskGraphView } from "../tasks/task-graph.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { json, messagePreview } from "./text.js";

/** What InfoCommands needs from its host; live values are forwarded through getters. */
export interface InfoCommandsContext {
  readonly activeContextCharLimit: () => number;
  readonly assertNoRunningCommands: (action: string) => void;
  readonly commandExecutionMode: CommandExecutionMode;
  readonly config: EasyCodeConfig;
  dirty: boolean;
  readonly effectiveConfig: () => EasyCodeConfig;
  readonly mainToolCatalogSnapshot: () => Promise<Readonly<ToolCatalogSnapshot>>;
  readonly maxModelRequests: number | undefined;
  readonly memoryManager: MemoryManager;
  readonly orchestrationEnabled: () => boolean;
  readonly pendingImages: ImageAttachment[];
  readonly resumableThreads: () => ThreadSummary[];
  readonly state: SessionState;
  readonly storage: EasyCodeStorage;
  readonly subagentCoordinator: SubagentCoordinator;
  readonly syncWorkspaceState: () => void;
  readonly taskBudgets: Map<string, TaskBudget>;
  readonly terminal: AppInteractionPort;
  readonly threadStore: ThreadStore;
  readonly trustedOuterSandbox: "harbor" | undefined;
  readonly workspace: WorkspaceManager;
}

export class InfoCommands {
  constructor(private readonly ctx: InfoCommandsContext) {}

  printStatus(): void {
    const providerConfig = this.ctx.effectiveConfig().providers[this.ctx.state.provider];
    if (!providerConfig) throw new Error(`Provider ${this.ctx.state.provider} is not configured`);
    const { steps: legacySteps, maxModelRequests: legacyMaxModelRequests, ...activeLimits } = this.ctx.config.limits;
    void legacySteps;
    void legacyMaxModelRequests;
    this.ctx.terminal.write(
      `${json({
        agent: "EASY CODE",
        thread: this.ctx.state.threadId,
        mode: this.ctx.state.mode,
        provider: this.ctx.state.provider,
        model: this.ctx.state.model,
        thinkingEffort: this.ctx.state.thinkingEffort,
        thinkingApplied: thinkingEffortIsApplied(
          this.ctx.state.provider,
          this.ctx.state.model,
          this.ctx.state.thinkingEffort,
        ),
        limits: activeLimits,
        orchestrationEnabled: this.ctx.orchestrationEnabled(),
        reviewerEnabled: true,
        taskBudget: this.ctx.taskBudgets.get(this.ctx.state.threadId)?.snapshot(),
        modelRequestLimit: this.ctx.maxModelRequests ?? null,
        contextCharLimit: this.ctx.activeContextCharLimit(),
        vision: modelSupportsVision(this.ctx.state.provider, this.ctx.state.model),
        pendingImages: this.ctx.pendingImages.map((image) => image.label),
        taskDag: this.ctx.state.taskGraph
          ? (() => {
              const view = taskGraphView(this.ctx.state.taskGraph as NonNullable<SessionState["taskGraph"]>);
              return {
                id: view.id,
                status: view.status,
                progress: `${view.completed}/${view.total}`,
                currentTask: view.currentTask,
                startableTasks: view.startableTasks,
              };
            })()
          : null,
        subagents: this.ctx.subagentCoordinator.snapshot(this.ctx.state.threadId),
        subagentConcurrency: {
          active: this.ctx.subagentCoordinator
            .snapshot(this.ctx.state.threadId)
            .filter((agent) => agent.status === "running" || agent.status === "stopping").length,
          limit: this.ctx.config.limits.maxConcurrentSubagents[this.ctx.state.thinkingEffort],
        },
        planReview: this.ctx.state.planReview
          ? {
              id: this.ctx.state.planReview.proposal.id,
              revision: this.ctx.state.planReview.proposal.revision,
              title: this.ctx.state.planReview.proposal.title,
              status: this.ctx.state.planReview.status,
            }
          : null,
        apiKeyConfigured: Boolean(providerConfig.apiKey),
        workspace: this.ctx.workspace.root,
        approvalPolicy: this.ctx.config.approvalPolicy,
        commandExecutionMode: this.ctx.commandExecutionMode,
        independentApprovalAgent: this.ctx.commandExecutionMode === "auto_approve",
        unrestrictedCommands: this.ctx.commandExecutionMode === "unrestricted",
        database: this.ctx.storage.databasePath,
      })}\n`,
    );
  }

  printSubagents(): void {
    const taskGraph = this.ctx.state.taskGraph ? taskGraphView(this.ctx.state.taskGraph) : undefined;
    const agents = this.ctx.subagentCoordinator.snapshot(this.ctx.state.threadId);
    const concurrencyLimit = this.ctx.config.limits.maxConcurrentSubagents[this.ctx.state.thinkingEffort];
    this.ctx.terminal.subagents(
      agents.filter((agent) => agent.status === "running" || agent.status === "stopping"),
      taskGraph,
      concurrencyLimit,
    );
  }

  async printTools(): Promise<void> {
    const catalog = await this.ctx.mainToolCatalogSnapshot();
    const tools = catalog.tools.map((tool) => {
      const availableForMode = isToolAvailable(tool, {
        mode: this.ctx.state.mode,
        role: "main_agent",
        orchestrationAvailable: this.ctx.state.orchestrationEnabled !== false,
        visionAvailable: modelSupportsVision(this.ctx.state.provider, this.ctx.state.model),
      });
      return {
        id: toolMetadata(tool).identity.id,
        source: toolMetadata(tool).identity.sourceId,
        name: tool.name,
        description: tool.definition.function.description,
        available: availableForMode,
        mutating: tool.mutating,
        effects: toolMetadata(tool).effects,
      };
    });
    this.ctx.terminal.write(`${json(tools)}\n`);
  }

  async showSkills(): Promise<void> {
    const listing = await SkillStore.forProject(
      this.ctx.workspace.root,
      this.ctx.config.dataDir,
      this.ctx.state.projectId ?? workspaceIdFromRoot(this.ctx.workspace.root),
    ).list();
    const safeLine = (value: string): string => sanitizeTerminalText(value, { allowSgr: false }).replace(/\s+/gu, " ");
    for (const [title, directory, skills] of [
      ["Global Skills", listing.globalDirectory, listing.global],
      ["Project Skills", listing.projectDirectory, listing.project],
    ] as const) {
      this.ctx.terminal.write(`${title} (${safeLine(directory)})\n`);
      if (skills.length === 0) this.ctx.terminal.write("  (none)\n");
      for (const skill of skills) this.ctx.terminal.write(`  ${skill.name} — ${safeLine(skill.description)}\n`);
    }
    for (const warning of listing.warnings) this.ctx.terminal.warning(`Skill skipped: ${safeLine(warning)}`);
  }

  private printPermissions(): void {
    this.ctx.terminal.write(
      `${json({
        logicalWorkspace: this.ctx.workspace.root,
        mode: this.ctx.state.mode,
        approvalPolicy: this.ctx.config.approvalPolicy,
        commandExecutionMode: this.ctx.commandExecutionMode,
        independentApprovalAgent: this.ctx.commandExecutionMode === "auto_approve",
        fullAccess: this.ctx.commandExecutionMode === "unrestricted",
        threadExecutableGrants: this.ctx.state.commandApprovalPrefixes.map((prefix, index) => ({
          index: index + 1,
          prefix: formatCommandApprovalPrefix(prefix),
        })),
        osSandbox: {
          enabled: Boolean(this.ctx.trustedOuterSandbox) || this.ctx.commandExecutionMode !== "unrestricted",
          failClosed: true,
          backend:
            this.ctx.trustedOuterSandbox === "harbor"
              ? "benchmark-container"
              : this.ctx.commandExecutionMode === "unrestricted"
                ? "host-unrestricted"
                : "native",
          filesystem: this.ctx.trustedOuterSandbox === "harbor" ? "container" : "host",
          network: this.ctx.trustedOuterSandbox
            ? "offline worker: no external networking"
            : this.ctx.commandExecutionMode === "unrestricted"
              ? "host network, no approval"
              : "per-command approval and network gate; explicit host escalation uses host networking",
          setup: "easy-code sandbox doctor | easy-code sandbox setup",
        },
        commandBoundary:
          "structured argv; Plan discourages direct editing, not command writes; normal CLI commands use the platform-native OS sandbox; explicit host scope requires approval; full access is unsandboxed; Benchmark keeps its offline Harbor container bridge",
        npmInstall:
          "normal command approvals apply; requested scripts/flags are preserved; Benchmark dependencies must be preinstalled or available offline",
        subagents:
          "main agent only; Code mode; DAG-bound or standalone isolated tasks; parent effort limits none/low=2, medium=4, high=8; no nested children; shared mutations serialized",
        note: "File tools remain workspace-scoped in every mode. Failed isolation never falls back to host execution.",
      })}\n`,
    );
  }

  updatePermissions(args: string[]): void {
    if (!args.length) {
      this.printPermissions();
      return;
    }
    if (args[0] !== "revoke" || args.length !== 2 || !/^[1-9]\d*$/u.test(args[1]!))
      throw new Error("Usage: /permissions [revoke <index>]");
    this.ctx.assertNoRunningCommands("revoke a command prefix");
    const prefix = this.ctx.state.commandApprovalPrefixes[Number(args[1]) - 1];
    if (!prefix) throw new Error("Permission index does not exist; use /permissions");
    this.ctx.threadStore.recordCommandApprovalPrefixRevocation(
      this.ctx.state.threadId,
      prefix,
      this.ctx.state.activeTurnId,
    );
    this.ctx.state.commandApprovalPrefixes = this.ctx.state.commandApprovalPrefixes.filter((p) => p !== prefix);
    this.ctx.dirty = true;
    this.ctx.terminal.info(
      `Revoked: ${formatCommandApprovalPrefix(prefix)}. This removes the saved grant; dangerous mode remains no-prompt.`,
    );
  }

  printMemory(args: string[]): void {
    const kind = args[0];
    if (kind === "short" && args.length <= 2) {
      const rawLimit = args[1];
      if (rawLimit !== undefined && !/^[1-9]\d*$/u.test(rawLimit)) {
        throw new Error("Usage: /memory short [limit] (limit must be an integer from 1 to 500)");
      }
      const limit = rawLimit === undefined ? 8 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new Error("Usage: /memory short [limit] (limit must be an integer from 1 to 500)");
      }
      this.ctx.syncWorkspaceState();
      const compactedMessageCount = Math.min(
        Math.max(0, this.ctx.state.compactedMessageCount),
        this.ctx.state.messages.length,
      );
      const activeMessages = this.ctx.state.messages.slice(compactedMessageCount);
      const recentMessagePreviews = activeMessages.slice(-limit).map(messagePreview);
      this.ctx.terminal.write(
        `${json({
          latestRequest: this.ctx.state.goal ?? null,
          constraints: this.ctx.state.constraints,
          workingSummary: redactSensitiveInformation(this.ctx.state.workingSummary),
          compactedMessageCount: this.ctx.state.compactedMessageCount,
          showingLast: recentMessagePreviews.length,
          totalActive: activeMessages.length,
          recentMessagePreviews,
          filesRead: [...this.ctx.state.filesRead.values()],
          changeCount: this.ctx.state.changes.length,
          commandCount: this.ctx.state.commands.length,
        })}\n`,
      );
      return;
    }

    if (kind === "long" && args.length <= 3) {
      const projectId = this.ctx.state.projectId ?? projectMemoryIdFromRoot(this.ctx.workspace.root);
      const scope = args[1] === "global" || args[1] === "project" || args[1] === "all" ? args[1] : "all";
      const id = scope === "all" && args[1] !== "all" ? args[1] : args[2];
      const memories = this.ctx.memoryManager.listScoped(projectId, scope, {
        limit: 500,
        status: "all",
      });
      if (id) {
        const memory = memories.find((entry) => entry.id === id);
        if (!memory) throw new Error(`Long-term memory not found: ${id}`);
        this.ctx.terminal.write(`${json(memory)}\n`);
      } else {
        this.ctx.terminal.write(
          memories.length
            ? `${json({
                global: memories.filter((memory) => memory.scope === "global"),
                project: memories.filter((memory) => memory.scope === "project"),
              })}\n`
            : "No long-term memories in the selected scope.\n",
        );
      }
      return;
    }

    throw new Error("Usage: /memory short [limit] | /memory long [global|project] [id] (read-only)");
  }

  printSessions(): void {
    const sessions = this.ctx.resumableThreads();
    this.ctx.terminal.write(sessions.length ? `${json(sessions)}\n` : "This workspace has no previous threads.\n");
  }
}
