import chalk from "chalk";
import { helpText, parseModelCommand, parseSlashCommand } from "../cli/slash-command.js";
import { printBanner } from "../cli/terminal.js";
import { formatTokenCount } from "../cli/token-count.js";
import { ContextManager } from "../context/manager.js";
import type {
  AgentMode,
  AgentRunResult,
  CommandExecutionMode,
  EasyCodeConfig,
  ImageAttachment,
  PlanProposal,
  ProviderName,
  SessionState,
} from "../core/types.js";
import { languageName, translate } from "../i18n/catalog.js";
import { executeLanguageCommand, readLanguage } from "../i18n/language.js";
import { ImageStore, nextThreadImageNumber, type ClipboardImageReader } from "../images/index.js";
import { MCP_SERVER_ACTION_IDS } from "../mcp/menu.js";
import { PROVIDER_CATALOG, providerLabel, requireCatalogModel } from "../models/catalog.js";
import { thinkingEffortIsApplied } from "../models/thinking.js";
import { type ThreadResourceAttachment } from "../resources/index.js";
import { type ProviderContextSnapshot } from "../runtime/agent.js";
import { runSandboxStartupGuide, type SandboxStartupService } from "../sandbox/startup.js";
import { type EasyCodeStorage } from "../storage/database.js";
import { SubagentCoordinator } from "../subagents/coordinator.js";
import { ThreadStore } from "../threads/thread-store.js";
import type { UISessionInfo } from "../ui/contracts.js";
import type { AppInteractionPort, PlanReviewDecision, UserSubmission } from "../ui/interaction-port.js";
import { InfoCommands } from "./info-commands.js";
import { ModelSelection } from "./model-selection.js";
import { SubagentHost } from "./subagent-host.js";
import { json, stripImageMarkers, stripPasteFailureMarkers } from "./text.js";

/** Live state and callbacks supplied by EasyCodeApp. */
export interface AppShellCommandsContext {
  readonly activeContextCharLimit: () => number;
  readonly announceResumeRecovery: () => void;
  readonly assertNoRunningCommands: (action: string) => void;
  readonly captureClipboardImage: (
    index: number,
    currentImages?: readonly ImageAttachment[],
    signal?: AbortSignal,
  ) => Promise<ImageAttachment>;
  readonly clearPendingImages: () => Promise<void>;
  readonly clipboardImageReader: ClipboardImageReader;
  readonly closed: boolean;
  commandExecutionMode: CommandExecutionMode;
  readonly compactCurrentSession: () => Promise<void>;
  readonly compacting: boolean;
  readonly config: EasyCodeConfig;
  readonly contextManager: ContextManager;
  dirty: boolean;
  readonly discardImages: (images: readonly ImageAttachment[]) => Promise<void>;
  readonly hasRunningCommands: () => boolean;
  hostAccessEpoch: number;
  readonly imageStore: ImageStore;
  readonly infoCommands: InfoCommands;
  readonly lastProviderContext: ProviderContextSnapshot | undefined;
  readonly modelSelection: ModelSelection;
  readonly newThread: () => Promise<void>;
  pendingImages: ImageAttachment[];
  readonly pendingPlan: () => PlanProposal | undefined;
  readonly processPendingPlanReview: (showPlan: boolean, suppliedDecision?: PlanReviewDecision) => Promise<boolean>;
  readonly queueImagePath: (rawPath: string, announce: boolean) => Promise<ImageAttachment>;
  readonly requireCurrentModelVision: () => void;
  readonly resumeThread: (threadId: string) => Promise<void>;
  sandboxSetupDeferred: boolean;
  readonly sandboxStartupService: SandboxStartupService | undefined;
  readonly save: () => void;
  readonly selectResumeThread: () => Promise<string | undefined>;
  readonly showMcpServers: (requested?: { serverId: string; action: string }) => Promise<void>;
  readonly startMemoryMaintenance: () => void;
  readonly startupInteraction: "none" | "select-model" | "ensure-api-key";
  readonly state: SessionState;
  readonly storage: EasyCodeStorage;
  readonly subagentCoordinator: SubagentCoordinator;
  readonly subagentHost: SubagentHost;
  readonly submitUserMessage: (
    text: string,
    images?: readonly ImageAttachment[],
    resources?: readonly ThreadResourceAttachment[],
  ) => Promise<AgentRunResult>;
  readonly syncTerminalView: (announceHeader?: boolean) => void;
  readonly terminal: AppInteractionPort;
  readonly terminalSessionInfo: () => UISessionInfo;
  readonly threadStore: ThreadStore;
  readonly trustedOuterSandbox: "harbor" | undefined;
  readonly uninstallRequested: boolean;
  readonly updateWorkspaceCommand: (rawArgs: string) => Promise<void>;
}

export class AppShellCommands {
  constructor(private readonly ctx: AppShellCommandsContext) {}

  async runInteractive(): Promise<void> {
    if (!this.ctx.terminal.isInteractive()) {
      throw new Error('Interactive mode requires a TTY; use `easy-code run "<task>"` for non-interactive use.');
    }
    // Start the retained shell before startup selection so the initial
    // provider/model/effort flow uses the same modal overlays as /model.
    this.ctx.terminal.beginShell(this.ctx.terminalSessionInfo());
    if (this.ctx.sandboxStartupService) {
      this.ctx.sandboxSetupDeferred = false;
      if (
        !(await runSandboxStartupGuide(this.ctx.sandboxStartupService, this.ctx.terminal, true, () => {
          this.ctx.sandboxSetupDeferred = true;
        }))
      )
        return;
    }
    if (!(await this.prepareInteractiveStartup())) return;
    this.ctx.syncTerminalView();
    printBanner(this.ctx.terminal, readLanguage(this.ctx.storage));
    if (!this.ctx.terminal.isInlineShell()) this.ctx.infoCommands.printStatus();
    this.ctx.announceResumeRecovery();
    this.ctx.startMemoryMaintenance();

    while (!this.ctx.closed && !this.ctx.uninstallRequested) {
      this.ctx.syncTerminalView();
      if (this.ctx.state.planReview) {
        try {
          if (!(await this.ctx.processPendingPlanReview(true))) return;
        } catch (error) {
          this.ctx.terminal.error(error instanceof Error ? error.message : String(error));
          // A failed adjustment leaves the previous proposal pending, so keep
          // the review gate active instead of accepting an unrelated prompt.
          if (this.ctx.state.planReview) continue;
        }
      }

      const promptImages: ImageAttachment[] = [];
      let promptOpen = true;
      let response: UserSubmission | null;
      try {
        response = await this.ctx.terminal.readPrompt(this.prompt(), {
          initialImageCount: nextThreadImageNumber(this.ctx.state.messages, this.ctx.pendingImages) - 1,
          captureImage: async (index, signal) => {
            const attachment = await this.ctx.captureClipboardImage(
              index,
              [...this.ctx.pendingImages, ...promptImages],
              signal,
            );
            if (!promptOpen) {
              await this.ctx.imageStore.remove(this.ctx.state.threadId, attachment).catch(() => undefined);
              throw new Error("The prompt was closed before the clipboard image finished loading.");
            }
            promptImages.push(attachment);
            return attachment;
          },
          captureText: async (signal) => this.ctx.clipboardImageReader.readText?.(signal),
        });
      } catch (error) {
        await this.ctx.discardImages(promptImages);
        throw error;
      } finally {
        promptOpen = false;
      }
      if (response === null) {
        await this.ctx.discardImages(promptImages);
        await this.ctx.clearPendingImages();
        return;
      }
      const referencedImageIds = new Set(response.images.map((image) => image.id));
      await this.ctx.discardImages(promptImages.filter((image) => !referencedImageIds.has(image.id)));
      for (const error of response.pasteErrors) {
        this.ctx.terminal.error(`Image paste failed: ${error}`);
      }
      const input = stripPasteFailureMarkers(response.text);
      const images = [...this.ctx.pendingImages, ...response.images];
      if (!input && images.length === 0) continue;

      // Image markers are removed only while recognizing slash commands. They
      // remain in normal prompts so the provider can preserve the user's
      // intended ordering when several screenshots are referenced.
      const commandInput = stripImageMarkers(input, response.images);
      const slash = parseSlashCommand(commandInput);
      if (slash) {
        if (response.images.length) {
          this.ctx.pendingImages.push(...response.images);
          this.ctx.terminal.info(`Queued ${response.images.map((image) => image.label).join(", ")} for the next task.`);
        }
        try {
          const shouldExit = await this.handleSlashCommand(commandInput);
          if (shouldExit) return;
        } catch (error) {
          this.ctx.terminal.error(error instanceof Error ? error.message : String(error));
        }
        continue;
      }

      let result: AgentRunResult;
      try {
        result = await this.ctx.submitUserMessage(input || "Analyze the attached image(s).", images);
        this.ctx.pendingImages = [];
      } catch (error) {
        this.ctx.pendingImages = images;
        this.ctx.terminal.error(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (result.planProposal) {
        try {
          if (!(await this.ctx.processPendingPlanReview(false))) return;
        } catch (error) {
          this.ctx.terminal.error(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  async handleSlashCommand(input: string): Promise<boolean> {
    const command = parseSlashCommand(input);
    if (!command) return false;
    if (this.ctx.compacting) throw new Error("Wait for context compaction to finish before using commands.");

    switch (command.name) {
      case "compact":
        if (command.args.length) throw new Error("Usage: /compact");
        await this.ctx.compactCurrentSession();
        return false;
      case "language": {
        const result = executeLanguageCommand(this.ctx.storage, command.args);
        this.ctx.terminal.setLanguage?.(result.language);
        this.ctx.terminal.success(
          translate(result.language, command.args.length ? "language.changed" : "language.current", {
            language: languageName(result.language),
          }),
        );
        return false;
      }
      case "mode": {
        this.ctx.subagentHost.assertNoRunningSubagents("switch modes");
        const mode = command.args[0] as AgentMode | undefined;
        if (!mode || !["plan", "auto", "code"].includes(mode)) {
          throw new Error("Usage: /mode plan|auto|code");
        }
        if (mode !== this.ctx.state.mode && this.ctx.pendingPlan()) {
          throw new Error("Resolve the pending plan review before switching modes.");
        }
        if (
          mode !== this.ctx.state.mode &&
          this.ctx.state.taskGraph &&
          this.ctx.state.taskGraph.status !== "completed"
        ) {
          throw new Error("Finish or resolve the active task DAG before switching modes.");
        }
        this.ctx.state.mode = mode;
        this.ctx.config.mode = mode;
        this.ctx.dirty = true;
        this.ctx.save();
        this.ctx.terminal.setSessionInfo(this.ctx.terminalSessionInfo());
        const language = readLanguage(this.ctx.storage);
        this.ctx.terminal.success(
          translate(language, "cli.modeSwitched", {
            mode:
              language === "zh_cn"
                ? translate(language, mode === "plan" ? "ui.modePlan" : mode === "code" ? "ui.modeCode" : "ui.modeAuto")
                : mode,
          }),
        );
        return false;
      }
      case "provider": {
        this.ctx.subagentHost.assertNoRunningSubagents("switch providers");
        const provider = command.args[0] as ProviderName | undefined;
        const supportedProviders = PROVIDER_CATALOG.map((entry) => entry.provider);
        if (!provider || command.args.length !== 1 || !supportedProviders.includes(provider)) {
          throw new Error(`Usage: /provider ${supportedProviders.join("|")}`);
        }
        this.ctx.modelSelection.requireProviderApiKey(provider);
        const model = requireCatalogModel(provider, this.ctx.config.providers[provider]!.model).id;
        this.ctx.modelSelection.commitModelSelection(provider, model, "Provider switched to");
        return false;
      }
      case "model": {
        this.ctx.subagentHost.assertNoRunningSubagents("switch models or thinking effort");
        const request = parseModelCommand(command.args);
        if (request.action === "select") {
          await this.ctx.modelSelection.selectModelFromPicker(true);
          return false;
        }

        const provider = request.provider ?? this.ctx.state.provider;
        const model = requireCatalogModel(provider, request.model).id;
        this.ctx.modelSelection.requireProviderApiKey(provider);
        this.ctx.modelSelection.commitModelSelection(provider, model, "Model switched to", request.thinkingEffort);
        return false;
      }
      case "orchestration": {
        await this.updateOrchestration(command.args);
        return false;
      }
      case "approval":
        if (
          command.args.length > 1 ||
          (command.args[0] && !["manual", "auto_approve", "unrestricted"].includes(command.args[0]))
        )
          throw new Error("Usage: /approval [manual|auto_approve|unrestricted]");
        this.ctx.assertNoRunningCommands("change command execution mode");
        await this.selectCommandExecutionMode(true, command.args[0] as CommandExecutionMode | undefined);
        return false;
      case "status":
        this.ctx.infoCommands.printStatus();
        return false;
      case "workspace": {
        await this.ctx.updateWorkspaceCommand(command.rawArgs);
        return false;
      }
      case "image": {
        if (!command.rawArgs) throw new Error("Usage: /image <path|clipboard|clear>");
        if (command.rawArgs.toLowerCase() === "clear") {
          const count = this.ctx.pendingImages.length;
          await this.ctx.clearPendingImages();
          this.ctx.terminal.success(translate(readLanguage(this.ctx.storage), "cli.imagesCleared", { count }));
          return false;
        }
        this.ctx.requireCurrentModelVision();
        if (command.rawArgs.toLowerCase() === "clipboard") {
          const attachment = await this.ctx.captureClipboardImage(
            nextThreadImageNumber(this.ctx.state.messages, this.ctx.pendingImages),
          );
          this.ctx.pendingImages.push(attachment);
          this.ctx.terminal.success(
            translate(readLanguage(this.ctx.storage), "cli.imageQueued", { label: attachment.label }),
          );
          return false;
        }
        await this.ctx.queueImagePath(command.rawArgs, true);
        return false;
      }
      case "tools":
        await this.ctx.infoCommands.printTools();
        return false;
      case "skills":
        if (command.args.length) throw new Error("Usage: /skills");
        await this.ctx.infoCommands.showSkills();
        return false;
      case "mcp":
        if (command.args.length !== 0 && command.args.length !== 2)
          throw new Error(`Usage: /mcp [server-id ${MCP_SERVER_ACTION_IDS.join("|")}]`);
        if (
          command.args.length === 2 &&
          (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(command.args[0]!) ||
            !(MCP_SERVER_ACTION_IDS as readonly string[]).includes(command.args[1]!))
        )
          throw new Error("Invalid MCP server or action.");
        await this.ctx.showMcpServers(
          command.args.length === 2 ? { serverId: command.args[0]!, action: command.args[1]! } : undefined,
        );
        return false;
      case "permissions":
        this.ctx.infoCommands.updatePermissions(command.args);
        return false;
      case "context":
        this.ctx.terminal.write(
          `${json({
            configuredWindowTokens: this.ctx.config.limits.maxContextTokens,
            effectiveTokenBudget: this.ctx.contextManager.tokenCapacity ?? null,
            thresholds: {
              reference: this.ctx.config.limits.contextReferenceTriggerRatio,
              summary: this.ctx.config.limits.contextCompactionTriggerRatio,
              force: this.ctx.config.limits.contextForceRatio,
              target: this.ctx.config.limits.contextCompactionTargetRatio,
            },
            ...this.ctx.contextManager.inspect(this.ctx.state, this.ctx.activeContextCharLimit()),
            lastProviderRequest:
              this.ctx.lastProviderContext?.threadId === this.ctx.state.threadId ? this.ctx.lastProviderContext : null,
            note: "Durable history remains complete locally. projectedActiveChars and lastProviderRequest reflect the lightweight provider projection; null means this process has not sent a request for the current Thread yet.",
          })}\n`,
        );
        return false;
      case "usage": {
        if (command.args.length) throw new Error("Usage: /usage");
        this.ctx.terminal.write(
          `${json({
            threadId: this.ctx.state.threadId,
            ...this.ctx.threadStore.modelUsageSummary(this.ctx.state.threadId),
            note: "Totals include completed provider responses reported by this EASY CODE version. Failed requests and providers that omit usage cannot be assigned exact tokens.",
          })}\n`,
        );
        return false;
      }
      case "memory":
        this.ctx.infoCommands.printMemory(command.args);
        return false;
      case "sessions":
        this.ctx.infoCommands.printSessions();
        return false;
      case "resume": {
        if (command.args.length > 1) throw new Error("Usage: /resume [thread-id]");
        const threadId = command.args[0] ?? (await this.ctx.selectResumeThread());
        if (!threadId) {
          this.ctx.terminal.info(translate(readLanguage(this.ctx.storage), "cli.resumeCanceled"));
          return false;
        }
        if (!command.args.length) return this.handleSlashCommand(`/resume ${threadId}`);
        await this.ctx.clearPendingImages();
        await this.ctx.resumeThread(threadId);
        this.ctx.syncTerminalView(true);
        this.ctx.announceResumeRecovery();
        return false;
      }
      case "new":
        if (command.args.length) throw new Error("Usage: /new");
        await this.ctx.clearPendingImages();
        await this.ctx.newThread();
        this.ctx.terminal.resetForNewThread(this.ctx.terminalSessionInfo());
        this.ctx.syncTerminalView();
        this.ctx.terminal.success(
          translate(readLanguage(this.ctx.storage), "cli.createdThread", { id: this.ctx.state.threadId }),
        );
        return false;
      case "clear":
        this.ctx.terminal.clearScreen();
        return false;
      case "help":
        this.ctx.terminal.write(`${helpText(readLanguage(this.ctx.storage)).trim()}\n`);
        return false;
      case "exit":
        await this.ctx.clearPendingImages();
        return true;
    }
  }

  private async prepareInteractiveStartup(): Promise<boolean> {
    if (this.ctx.startupInteraction === "none") return true;

    let selection = {
      provider: this.ctx.state.provider,
      model: this.ctx.state.model,
      thinkingEffort: this.ctx.state.thinkingEffort,
    };
    if (this.ctx.startupInteraction === "select-model") {
      const selected = await this.ctx.modelSelection.selectProviderAndModel();
      if (!selected) {
        this.ctx.terminal.info(translate(readLanguage(this.ctx.storage), "cli.startupModelCanceled"));
        return false;
      }
      selection = selected;
    }

    if (!(await this.ctx.modelSelection.ensureProviderApiKey(selection.provider))) return false;

    if (this.ctx.startupInteraction === "select-model") {
      this.ctx.modelSelection.commitModelSelection(
        selection.provider,
        selection.model,
        "Selected",
        selection.thinkingEffort,
      );
    } else {
      const applied = thinkingEffortIsApplied(selection.provider, selection.model, selection.thinkingEffort);
      const language = readLanguage(this.ctx.storage);
      this.ctx.terminal.success(
        translate(language, "cli.selectedModel", {
          provider: providerLabel(selection.provider),
          model: selection.model,
          effort: selection.thinkingEffort,
          suffix: applied ? "" : translate(language, "cli.notAppliedSuffix"),
        }),
      );
    }
    return true;
  }

  async selectCommandExecutionMode(announceCancellation = true, requested?: CommandExecutionMode): Promise<void> {
    const language = readLanguage(this.ctx.storage);
    const selected =
      requested ??
      ((await this.ctx.terminal.selectChoice(
        translate(language, "cli.selectApproval"),
        [
          {
            id: "manual",
            label: translate(language, "ui.manualApproval"),
            detail: translate(language, "cli.manualApprovalDetail"),
          },
          {
            id: "auto_approve",
            label: translate(language, "cli.autoApprove"),
            detail: translate(language, "cli.autoApproveDetail"),
          },
          {
            id: "unrestricted",
            label: translate(language, "ui.fullAccess"),
            detail: translate(language, "cli.fullAccessDetail"),
          },
        ],
        this.ctx.commandExecutionMode,
      )) as CommandExecutionMode | undefined);
    if (!selected) {
      if (announceCancellation) this.ctx.terminal.info(translate(language, "cli.approvalCanceled"));
      return;
    }
    if (!requested) {
      await this.handleSlashCommand(`/approval ${selected}`);
      return;
    }

    if (this.ctx.trustedOuterSandbox === "harbor") {
      this.ctx.terminal.info(translate(language, "cli.benchmarkPermissions"));
      return;
    }
    if (selected === "manual" && this.hasActiveOrchestration()) {
      this.ctx.terminal.info(translate(language, "cli.activeOrchestration"));
      return;
    }

    if (selected === "unrestricted") {
      this.ctx.terminal.warning(translate(language, "cli.fullAccessWarning"));
      const confirmed = await this.ctx.terminal.selectChoice(
        translate(language, "cli.fullAccessQuestion"),
        [
          {
            id: "cancel",
            label: translate(language, "cli.fullAccessNo"),
            detail: translate(language, "cli.fullAccessNoDetail"),
          },
          {
            id: "confirm",
            label: translate(language, "cli.fullAccessYes"),
            detail: translate(language, "cli.fullAccessYesDetail"),
          },
        ],
        "cancel",
      );
      if (confirmed !== "confirm") {
        if (announceCancellation) this.ctx.terminal.info(translate(language, "cli.fullAccessCanceled"));
        return;
      }
    }

    const previousMode = this.ctx.commandExecutionMode;
    // No await between recheck and commit: dispatch sees either old or new state.
    if (selected === "manual" && this.hasActiveOrchestration()) {
      this.ctx.terminal.info(translate(language, "cli.activeOrchestration"));
      return;
    }
    if ((previousMode === "unrestricted") !== (selected === "unrestricted")) {
      this.ctx.hostAccessEpoch += 1;
    }
    this.ctx.threadStore.appendEvent(this.ctx.state.threadId, {
      type: "approval.mode_changed",
      payload: {
        previousMode,
        selected,
        orchestrationEnabled: selected === "manual" ? false : this.ctx.state.orchestrationEnabled,
      },
    });
    this.ctx.commandExecutionMode = selected;
    if (selected === "manual") this.ctx.state.orchestrationEnabled = false;
    this.ctx.dirty = true;
    this.ctx.save();
    // An explicit interactive selection supersedes a startup --approval=ask|never
    // posture for this process. Mandatory boundaries apply in every mode.
    this.ctx.config.approvalPolicy = "safe";
    if (selected !== "manual") this.ctx.subagentCoordinator.activatePrepared(this.ctx.state.threadId);
    // The session card is durable scrollback. Re-announcing it for an
    // in-process policy change leaves both the previous and new cards visible.
    // Update only the redrawable live UI; its danger footer reflects the new
    // posture immediately without duplicating the EASY CODE title.
    this.ctx.syncTerminalView();
    if (selected === "manual") {
      this.ctx.terminal.success(
        translate(language, previousMode === "unrestricted" ? "cli.manualRestored" : "cli.manualEnabled"),
      );
    } else if (selected === "auto_approve") {
      this.ctx.terminal.success(
        translate(language, previousMode === "unrestricted" ? "cli.autoRestored" : "cli.autoEnabled"),
      );
    } else {
      this.ctx.terminal.warning(translate(language, "cli.fullAccessEnabled"));
    }
  }

  async updateOrchestration(args: readonly string[] = [], reportCancel = true): Promise<void> {
    const language = readLanguage(this.ctx.storage);
    if (args.length > 1 || (args[0] && !["on", "off"].includes(args[0]))) {
      throw new Error("Usage: /orchestration [on|off]");
    }
    const selected =
      args[0] ??
      (await this.ctx.terminal.selectChoice(
        translate(language, "cli.orchestrationTitle"),
        [
          {
            id: "off",
            label: translate(language, "cli.orchestrationOff"),
            detail: translate(language, "cli.orchestrationOffDetail"),
          },
          {
            id: "on",
            label: translate(language, "cli.orchestrationOn"),
            detail: translate(language, "cli.orchestrationOnDetail"),
          },
        ],
        this.orchestrationEnabled() ? "on" : "off",
      ));
    if (!selected) {
      if (reportCancel) this.ctx.terminal.info(translate(language, "cli.orchestrationCanceled"));
      return;
    }
    if (!args.length) {
      await this.handleSlashCommand(`/orchestration ${selected}`);
      return;
    }
    if (selected === "on" && this.ctx.commandExecutionMode === "manual") {
      const confirmed = await this.ctx.terminal.selectChoice(
        translate(language, "cli.orchestrationQuestion"),
        [
          {
            id: "cancel",
            label: translate(language, "ui.cancel"),
            detail: translate(language, "cli.orchestrationKeep"),
          },
          {
            id: "enable",
            label: translate(language, "cli.orchestrationBoth"),
            detail: translate(language, "cli.orchestrationBothDetail"),
          },
        ],
        "cancel",
      );
      if (confirmed !== "enable") return;
    }
    const nextMode =
      selected === "on" && this.ctx.commandExecutionMode === "manual" ? "auto_approve" : this.ctx.commandExecutionMode;
    this.ctx.threadStore.appendEvent(this.ctx.state.threadId, {
      type: "approval.mode_changed",
      payload: {
        previousMode: this.ctx.commandExecutionMode,
        selected: nextMode,
        orchestrationEnabled: selected === "on",
      },
    });
    if (nextMode !== this.ctx.commandExecutionMode) this.ctx.config.approvalPolicy = "safe";
    this.ctx.commandExecutionMode = nextMode;
    this.ctx.state.orchestrationEnabled = selected === "on";
    this.ctx.dirty = true;
    this.ctx.save();
    if (this.ctx.commandExecutionMode !== "manual")
      this.ctx.subagentCoordinator.activatePrepared(this.ctx.state.threadId);
    this.ctx.syncTerminalView();
    this.ctx.terminal.success(
      translate(language, "cli.orchestrationChanged", {
        state: translate(language, selected === "on" ? "cli.on" : "cli.off"),
      }),
    );
  }

  orchestrationEnabled(): boolean {
    return this.ctx.commandExecutionMode !== "manual" && this.ctx.state.orchestrationEnabled;
  }

  hasActiveOrchestration(): boolean {
    return (
      Boolean(this.ctx.state.taskGraph && this.ctx.state.taskGraph.status !== "completed") ||
      this.ctx.subagentCoordinator.hasUnfinished(this.ctx.state.threadId) ||
      this.ctx.subagentCoordinator.hasOutstanding(this.ctx.state.threadId) ||
      this.ctx.hasRunningCommands()
    );
  }

  private prompt(): string {
    const shortTermTokens = this.ctx.contextManager.estimateShortTermTokens(this.ctx.state);
    const text =
      `${this.ctx.commandExecutionMode === "unrestricted" ? "! EASY CODE FULL ACCESS " : "EASY CODE "}` +
      `[${this.ctx.state.mode} ${this.ctx.state.provider}/${this.ctx.state.model} ` +
      `thinking:${this.ctx.state.thinkingEffort} approval:${this.ctx.commandExecutionMode === "auto_approve" ? "agent" : this.ctx.commandExecutionMode} env:${this.ctx.trustedOuterSandbox ? "container/offline" : this.ctx.commandExecutionMode === "unrestricted" ? "host" : "sandbox"} DAG/agents:${this.orchestrationEnabled() ? "on" : "off"} context:${formatTokenCount(shortTermTokens)}] > `;
    return this.ctx.commandExecutionMode === "unrestricted" ? chalk.bold.red(text) : chalk.bold.cyan(text);
  }

  effectiveConfig(): EasyCodeConfig {
    const config: EasyCodeConfig = {
      ...this.ctx.config,
      mode: this.ctx.state.mode,
      thinkingEffort: this.ctx.state.thinkingEffort,
      provider: this.ctx.state.provider,
      providers: Object.fromEntries(
        Object.entries(this.ctx.config.providers).map(([provider, providerConfig]) => [
          provider,
          { ...providerConfig },
        ]),
      ),
    };
    config.providers[this.ctx.state.provider]!.model = this.ctx.state.model;
    return config;
  }
}
