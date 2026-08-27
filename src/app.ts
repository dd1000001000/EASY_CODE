import path from "node:path";

import chalk from "chalk";

import { Terminal, printBanner } from "./cli/terminal.js";
import {
  HELP_TEXT,
  parseModelCommand,
  parseSlashCommand,
} from "./cli/slash-command.js";
import {
  SystemKeyringCredentialStore,
  apiKeyConfigKey,
  storeVerifiedApiKey,
  type ApiKeyCredentialStore,
} from "./config/credentials.js";
import { loadEasyCodeConfig } from "./config/loader.js";
import { ContextManager } from "./context/manager.js";
import type {
  AgentMode,
  AgentRunResult,
  ApprovalPolicyName,
  ChatMessage,
  EasyCodeConfig,
  ProviderName,
  SessionState,
} from "./core/types.js";
import { MemoryManager } from "./memory/memory-manager.js";
import { redactSensitiveInformation } from "./memory/sensitive.js";
import { buildSystemPrompt } from "./prompts/builder.js";
import { createProvider } from "./providers/factory.js";
import { AgentRuntime } from "./runtime/agent.js";
import { createStorage, workspaceIdFromRoot, type EasyCodeStorage } from "./storage/database.js";
import { createDefaultTools } from "./tools/registry.js";
import { ThreadStore } from "./threads/thread-store.js";
import { WorkspaceManager } from "./workspace/manager.js";

export interface EasyCodeAppOptions {
  workspaceRoot?: string;
  provider?: ProviderName;
  model?: string;
  mode?: AgentMode;
  approvalPolicy?: ApprovalPolicyName;
  assumeYes?: boolean;
  resumeThreadId?: string;
  startupInteraction?: "none" | "select-model" | "ensure-api-key";
  terminal?: Terminal;
  /** Dependency injection for isolated tests; false disables keyring reads. */
  credentialStore?: ApiKeyCredentialStore | false;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function messagePreview(message: ChatMessage): string {
  const role = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "Tool";
  let content = message.content ?? "";
  if (!content && message.role === "assistant" && message.tool_calls?.length) {
    content = `[Tool calls: ${message.tool_calls.map((call) => call.function.name).join(", ")}]`;
  }
  const compact = redactSensitiveInformation(content.replace(/\s+/gu, " ").trim()).slice(0, 240);
  return `${role}: ${compact || "(empty)"}`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function repairInterruptedTurn(threadStore: ThreadStore, state: SessionState): boolean {
  const turnId = state.activeTurnId;
  if (!turnId) return false;
  const message: ChatMessage = {
    role: "assistant",
    content: "The previous EASY CODE process exited before this turn completed; the turn has been marked as interrupted.",
  };
  state.messages.push(message);
  threadStore.appendEvent(state.threadId, {
    turnId,
    type: "message.assistant",
    phase: "completed",
    payload: message,
  });
  threadStore.appendEvent(state.threadId, {
    turnId,
    type: "turn.completed",
    phase: "completed",
    payload: { reason: "interrupted", steps: 0, recovered: true },
  });
  state.activeTurnId = undefined;
  state.updatedAt = new Date().toISOString();
  return true;
}

export class EasyCodeApp {
  private workspace: WorkspaceManager;
  private state: SessionState;
  private readonly contextManager = new ContextManager();
  private readonly memoryManager: MemoryManager;
  private readonly threadStore: ThreadStore;
  private closed = false;
  private dirty = false;

  private constructor(
    private readonly config: EasyCodeConfig,
    private readonly storage: EasyCodeStorage,
    workspace: WorkspaceManager,
    state: SessionState,
    private readonly terminal: Terminal,
    private readonly assumeYes: boolean,
    private readonly credentialStore: ApiKeyCredentialStore | undefined,
    private readonly startupInteraction: "none" | "select-model" | "ensure-api-key",
  ) {
    this.workspace = workspace;
    this.state = state;
    this.memoryManager = new MemoryManager(storage);
    this.threadStore = new ThreadStore(storage);
  }

  static async create(options: EasyCodeAppOptions = {}): Promise<EasyCodeApp> {
    const credentialStore = options.credentialStore === false
      ? undefined
      : options.credentialStore ?? new SystemKeyringCredentialStore();
    const config = await loadEasyCodeConfig({
      workspaceRoot: options.workspaceRoot,
      credentialStore: credentialStore ?? false,
    });
    const terminal = options.terminal ?? new Terminal();
    if (options.approvalPolicy) config.approvalPolicy = options.approvalPolicy;

    let storage: EasyCodeStorage | undefined;
    try {
      storage = createStorage(config.dataDir);
      const threadStore = new ThreadStore(storage);
      const workspace = await WorkspaceManager.create(config.workspaceRoot);
      let state: SessionState;
      let shouldCheckpoint = false;

      if (options.resumeThreadId) {
        state = threadStore.recover(options.resumeThreadId);
        if (!samePath(state.workspaceRoot, workspace.root)) {
          throw new Error(
            `Thread ${state.threadId} belongs to ${state.workspaceRoot}; launch EASY CODE with that --workspace first.`,
          );
        }
        const previousMode = state.mode;
        const previousProvider = state.provider;
        const previousModel = state.model;
        state.mode = options.mode ?? state.mode;
        const selectedProvider = options.provider ?? state.provider;
        state.provider = selectedProvider;
        state.model = options.model ?? (options.provider ? config[selectedProvider].model : state.model);
        const repairedInterruptedTurn = repairInterruptedTurn(threadStore, state);
        shouldCheckpoint =
          previousMode !== state.mode ||
          previousProvider !== state.provider ||
          previousModel !== state.model ||
          repairedInterruptedTurn;
      } else {
        const selectedProvider = options.provider ?? config.provider;
        const selectedMode = options.mode ?? config.mode;
        const selectedModel = options.model ?? config[selectedProvider].model;
        state = threadStore.create({
          workspaceRoot: workspace.root,
          mode: selectedMode,
          provider: selectedProvider,
          model: selectedModel,
        });
      }

      config.workspaceRoot = workspace.root;
      config.provider = state.provider;
      config.mode = state.mode;
      config[state.provider].model = state.model;
      if (shouldCheckpoint) threadStore.save(state);
      return new EasyCodeApp(
        config,
        storage,
        workspace,
        state,
        terminal,
        options.assumeYes ?? false,
        credentialStore,
        options.startupInteraction ?? "none",
      );
    } catch (error) {
      storage?.close();
      terminal.close();
      throw error;
    }
  }

  async runInteractive(): Promise<void> {
    if (!this.terminal.isInteractive()) {
      throw new Error("Interactive mode requires a TTY; use `easy-code run \"<task>\"` for non-interactive use.");
    }
    if (!(await this.prepareInteractiveStartup())) return;
    printBanner(this.terminal);
    this.printStatus();

    while (!this.closed) {
      const response = await this.terminal.question(this.prompt());
      if (response === null) return;
      const input = response.trim();
      if (!input) continue;

      const slash = parseSlashCommand(input);
      if (slash) {
        try {
          const shouldExit = await this.handleSlashCommand(input);
          if (shouldExit) return;
        } catch (error) {
          this.terminal.error(error instanceof Error ? error.message : String(error));
        }
        continue;
      }

      try {
        await this.executePrompt(input);
      } catch (error) {
        this.terminal.error(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async runOnce(prompt: string): Promise<AgentRunResult> {
    const normalized = prompt.trim();
    if (!normalized) throw new Error("A non-empty prompt is required");
    return this.executePrompt(normalized);
  }

  async handleSlashCommand(input: string): Promise<boolean> {
    const command = parseSlashCommand(input);
    if (!command) return false;

    switch (command.name) {
      case "mode": {
        const mode = command.args[0] as AgentMode | undefined;
        if (!mode || !["plan", "auto", "code"].includes(mode)) {
          throw new Error("Usage: /mode plan|auto|code");
        }
        this.state.mode = mode;
        this.config.mode = mode;
        this.dirty = true;
        this.save();
        this.terminal.success(`Mode switched to ${mode}`);
        return false;
      }
      case "provider": {
        const provider = command.args[0] as ProviderName | undefined;
        if (
          !provider ||
          command.args.length !== 1 ||
          !["qwen", "deepseek"].includes(provider)
        ) {
          throw new Error("Usage: /provider qwen|deepseek");
        }
        this.requireProviderApiKey(provider);
        this.state.provider = provider;
        this.state.model = this.config[provider].model;
        this.config.provider = provider;
        this.dirty = true;
        this.save();
        this.terminal.success(`Provider switched to ${provider}/${this.state.model}`);
        return false;
      }
      case "model": {
        const request = parseModelCommand(command.args);
        if (request.action === "show") {
          this.printModel();
          return false;
        }

        const provider = request.provider ?? this.state.provider;
        const model = request.model;
        this.requireProviderApiKey(provider);
        this.state.provider = provider;
        this.state.model = model;
        this.config.provider = provider;
        this.config[provider].model = model;
        this.dirty = true;
        this.save();
        this.terminal.success(`Model switched to ${provider}/${model}`);
        return false;
      }
      case "status":
        this.printStatus();
        return false;
      case "workspace": {
        const action = command.args[0];
        if (action && action !== "refresh") throw new Error("Usage: /workspace [refresh]");
        const summary = action === "refresh"
          ? await this.workspace.refreshManifest()
          : this.workspace.getManifestSummary();
        this.terminal.write(`${json(summary)}\n`);
        return false;
      }
      case "changes": {
        this.syncWorkspaceState();
        const changes = this.state.changes;
        this.terminal.write(changes.length ? `${json(changes)}\n` : "This thread has no file changes.\n");
        return false;
      }
      case "tools":
        this.printTools();
        return false;
      case "permissions":
        this.printPermissions();
        return false;
      case "commands": {
        const commands = this.state.commands.slice(-20);
        this.terminal.write(commands.length ? `${json(commands)}\n` : "This thread has no command history.\n");
        return false;
      }
      case "context":
        this.terminal.write(`${json(this.contextManager.inspect(this.state, this.config.maxContextChars))}\n`);
        return false;
      case "memory":
        this.printMemory(command.args);
        return false;
      case "sessions":
        this.printSessions();
        return false;
      case "resume": {
        const threadId = command.args[0];
        if (!threadId || command.args.length !== 1) throw new Error("Usage: /resume <thread-id>");
        await this.resumeThread(threadId);
        this.terminal.success(`Resumed thread ${this.state.threadId}`);
        return false;
      }
      case "new":
        if (command.args.length) throw new Error("Usage: /new");
        await this.newThread();
        this.terminal.success(`Created thread ${this.state.threadId}`);
        return false;
      case "clear":
        if (process.stdout.isTTY) this.terminal.write("\u001Bc");
        return false;
      case "help":
        this.terminal.write(`${HELP_TEXT.trim()}\n`);
        return false;
      case "exit":
      case "quit":
        return true;
      default:
        throw new Error(`Unknown command /${command.name}; use /help to view available commands.`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.save();
    } finally {
      this.storage.close();
      this.terminal.close();
    }
  }

  private async executePrompt(userInput: string): Promise<AgentRunResult> {
    this.requireProviderApiKey(this.state.provider);
    this.dirty = true;
    const turnStartedAt = Date.now();
    const controller = new AbortController();
    let interruptCount = 0;
    const onInterrupt = (): void => {
      interruptCount += 1;
      if (interruptCount === 1) {
        this.terminal.info("Interrupting the current task...");
        controller.abort();
      } else {
        process.removeListener("SIGINT", onInterrupt);
        process.exit(130);
      }
    };
    process.on("SIGINT", onInterrupt);

    try {
      const runtime = this.createRuntime();
      const result = await runtime.run(this.state, userInput, {
        maxSteps: this.config.maxSteps,
        maxContextChars: this.config.maxContextChars,
        maxOutputChars: this.config.maxOutputChars,
        commandTimeoutMs: this.config.commandTimeoutMs,
        approvalPolicy: this.config.approvalPolicy,
        signal: controller.signal,
      });

      this.syncWorkspaceState();
      this.captureLongTermMemory(userInput, result, turnStartedAt);
      this.terminal.write(`\n${result.text.trim()}\n\n`);
      return result;
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      this.save();
    }
  }

  private createRuntime(): AgentRuntime {
    const effectiveConfig = this.effectiveConfig();
    const provider = createProvider(effectiveConfig, this.state.provider, this.state.model);
    const workspaceId = workspaceIdFromRoot(this.workspace.root);

    return new AgentRuntime({
      provider,
      tools: createDefaultTools(this.workspace),
      contextManager: new ContextManager(),
      buildSystemPrompt: async ({ mode, workspaceSummary, memories }) =>
        buildSystemPrompt({
          config: effectiveConfig,
          mode,
          workspaceSummary,
          memories,
        }),
      getWorkspaceSummary: async () => json(this.workspace.getManifestSummary()),
      searchMemories: async (query) =>
        this.memoryManager.search(workspaceId, query).map((memory) => memory.content),
      appendEvent: async (event) => {
        const { threadId, ...input } = event;
        this.threadStore.appendEvent(threadId, input);
        this.dirty = true;
      },
      recordCommand: (turnId, entry) => {
        this.threadStore.recordToolAudit(this.state.threadId, turnId, entry);
        this.dirty = true;
      },
      onToolCompleted: async (_state, _toolName, result) => {
        this.syncWorkspaceState();
        this.save();
        if (result.ok && result.presentation?.type === "file_diff") {
          try {
            this.terminal.fileDiff(result.presentation);
          } catch {
            this.terminal.info("The file was updated successfully, but the diff preview could not be rendered.");
          }
        }
      },
      requestApproval: async (request) => {
        if (this.assumeYes) {
          this.terminal.info(`Approved by --yes: ${request.title}`);
          return true;
        }
        return this.terminal.approve(request);
      },
      onStatus: (status) => this.terminal.info(status),
    });
  }

  private async prepareInteractiveStartup(): Promise<boolean> {
    if (this.startupInteraction === "none") return true;

    let provider = this.state.provider;
    if (this.startupInteraction === "select-model") {
      const selected = await this.terminal.selectStartupModel(
        (["qwen", "deepseek"] as const).map((candidate) => ({
          provider: candidate,
          model: this.config[candidate].model,
          apiKeyConfigured: Boolean(this.config[candidate].apiKey),
        })),
        provider,
      );
      if (!selected) {
        this.terminal.info("Startup model selection canceled.");
        return false;
      }
      provider = selected;
    }

    if (!this.config[provider].apiKey) {
      if (!this.credentialStore) {
        throw new Error(
          `No ${provider} API key is configured, and the system credential store is unavailable. ` +
            `Run easy-code config set ${provider}.api-key or set the corresponding environment variable.`,
        );
      }
      this.terminal.info(
        `No API key is configured for ${provider === "qwen" ? "Qwen" : "DeepSeek"}.`,
      );
      let value: string;
      try {
        value = await this.terminal.readSecret(
          `Enter the ${provider === "qwen" ? "Qwen" : "DeepSeek"} API key (input is hidden): `,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "API key input was canceled.") {
          this.terminal.info("API key input canceled.");
          return false;
        }
        throw error;
      }
      const normalized = await storeVerifiedApiKey(this.credentialStore, provider, value);
      this.config[provider].apiKey = normalized;
      this.terminal.success(
        `Saved ${apiKeyConfigKey(provider)} to the operating system credential store.`,
      );
    }

    if (
      this.startupInteraction === "select-model" &&
      (this.state.provider !== provider || this.state.model !== this.config[provider].model)
    ) {
      this.state.provider = provider;
      this.state.model = this.config[provider].model;
      this.config.provider = provider;
      this.dirty = true;
      this.save();
    }
    this.terminal.success(
      `Selected ${provider === "qwen" ? "Qwen" : "DeepSeek"} / ${this.state.model}`,
    );
    return true;
  }

  private effectiveConfig(): EasyCodeConfig {
    const config: EasyCodeConfig = {
      ...this.config,
      mode: this.state.mode,
      provider: this.state.provider,
      qwen: { ...this.config.qwen },
      deepseek: { ...this.config.deepseek },
    };
    config[this.state.provider].model = this.state.model;
    return config;
  }

  private captureLongTermMemory(
    userInput: string,
    result: AgentRunResult,
    turnStartedAt: number,
  ): void {
    try {
      const hasAssistantEvidence =
        this.workspace.getReadVersions().some(
          (version) => Date.parse(version.readAt) >= turnStartedAt,
        ) ||
        this.state.changes.some(
          (change) =>
            Date.parse(change.timestamp) >= turnStartedAt &&
            change.status === "verified",
        ) ||
        this.state.commands.some(
          (command) =>
            Date.parse(command.timestamp) >= turnStartedAt &&
            command.status === "exited" &&
            command.exitCode === 0,
        );
      this.memoryManager.captureFromTurn({
        workspaceRoot: this.workspace.root,
        threadId: this.state.threadId,
        turnId: result.turnId,
        userMessage: userInput,
        assistantMessage: result.text,
        assistantEvidence: hasAssistantEvidence,
        outcome: result.reason,
        completed: result.reason === "success" || result.reason === "planned",
      });
    } catch (error) {
      this.terminal.info(`Long-term memory extraction skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private syncWorkspaceState(): void {
    const currentVersions = new Map(
      this.workspace.getReadVersions().map((version) => [version.path, version]),
    );
    let versionsChanged = currentVersions.size !== this.state.filesRead.size;
    if (!versionsChanged) {
      for (const [filename, version] of currentVersions) {
        const previous = this.state.filesRead.get(filename);
        if (!previous || previous.hash !== version.hash || previous.readAt !== version.readAt) {
          versionsChanged = true;
          break;
        }
      }
    }
    if (versionsChanged) {
      this.state.filesRead = currentVersions;
      this.dirty = true;
    }
    const known = new Set(
      this.state.changes.map((change) =>
        [change.timestamp, change.path, change.operation, change.afterHash ?? ""].join("|"),
      ),
    );
    for (const change of this.workspace.getChangeSet()) {
      const key = [change.timestamp, change.path, change.operation, change.afterHash ?? ""].join("|");
      if (!known.has(key)) {
        this.state.changes.push(change);
        known.add(key);
        this.dirty = true;
      }
    }
  }

  private async resetWorkspace(): Promise<void> {
    this.workspace = await WorkspaceManager.create(this.config.workspaceRoot);
  }

  private async newThread(): Promise<void> {
    this.save();
    await this.resetWorkspace();
    this.state = this.threadStore.create({
      workspaceRoot: this.workspace.root,
      mode: this.state.mode,
      provider: this.state.provider,
      model: this.state.model,
    });
    this.dirty = false;
  }

  private async resumeThread(threadId: string): Promise<void> {
    if (threadId === this.state.threadId) {
      this.save();
      return;
    }
    this.save();
    const recovered = this.threadStore.recover(threadId);
    if (!samePath(recovered.workspaceRoot, this.workspace.root)) {
      throw new Error(
        `Thread ${threadId} belongs to ${recovered.workspaceRoot}; restart with --workspace for that directory.`,
      );
    }
    this.state = recovered;
    this.config.mode = recovered.mode;
    this.config.provider = recovered.provider;
    this.config[recovered.provider].model = recovered.model;
    await this.resetWorkspace();
    this.dirty = repairInterruptedTurn(this.threadStore, this.state);
    this.save();
  }

  private save(): void {
    this.syncWorkspaceState();
    if (!this.dirty) return;
    this.threadStore.save(this.state);
    this.dirty = false;
  }

  private printStatus(): void {
    const providerConfig = this.effectiveConfig()[this.state.provider];
    this.terminal.write(
      `${json({
        agent: "EASY CODE",
        thread: this.state.threadId,
        mode: this.state.mode,
        provider: this.state.provider,
        model: this.state.model,
        apiKeyConfigured: Boolean(providerConfig.apiKey),
        workspace: this.workspace.root,
        approvalPolicy: this.config.approvalPolicy,
        autoApprovePrompts: this.assumeYes,
        database: this.storage.databasePath,
      })}\n`,
    );
  }

  private printModel(): void {
    this.terminal.write(
      `${json({
        provider: this.state.provider,
        model: this.state.model,
        keyConfigured: {
          qwen: Boolean(this.config.qwen.apiKey),
          deepseek: Boolean(this.config.deepseek.apiKey),
        },
      })}\n`,
    );
  }

  private requireProviderApiKey(provider: ProviderName): void {
    if (this.config[provider].apiKey) return;
    const environment = provider === "qwen"
      ? "QWEN_API_KEY (DASHSCOPE_API_KEY is also supported)"
      : "DEEPSEEK_API_KEY";
    throw new Error(
      `No ${provider} API key is configured. Run ` +
      `easy-code config set ${provider}.api-key (saved to the system credential store), ` +
      `or set the ${environment} environment variable, then restart EASY CODE.`,
    );
  }

  private printTools(): void {
    const tools = createDefaultTools(this.workspace).map((tool) => ({
      name: tool.name,
      available: this.state.mode !== "plan" || tool.name === "read_file" || tool.name === "run_command",
      mutating: tool.mutating,
    }));
    this.terminal.write(`${json(tools)}\n`);
  }

  private printPermissions(): void {
    this.terminal.write(
      `${json({
        workspaceBoundary: this.workspace.root,
        mode: this.state.mode,
        approvalPolicy: this.config.approvalPolicy,
        autoApprovePrompts: this.assumeYes,
        osSandbox: false,
        commandBoundary:
          "structured argv; explicit one-shot shells require exact approval (or --yes); restricted environment; direct destructive/system/remote commands denied",
        npmInstall:
          "project-local registry packages at exact versions only; lifecycle scripts disabled; global installs denied",
        note: "Commands execute as the current OS user after EASY CODE policy and approval checks.",
      })}\n`,
    );
  }

  private printMemory(args: string[]): void {
    const kind = args[0];
    if (kind === "short" && args.length === 1) {
      this.syncWorkspaceState();
      this.terminal.write(
        `${json({
          goal: this.state.goal,
          constraints: this.state.constraints,
          workingSummary: redactSensitiveInformation(this.state.workingSummary),
          recentMessages: this.state.messages.slice(-8).map(messagePreview),
          filesRead: [...this.state.filesRead.values()],
          changeCount: this.state.changes.length,
          commandCount: this.state.commands.length,
        })}\n`,
      );
      return;
    }

    if (kind === "long" && args.length <= 2) {
      const memories = this.memoryManager.list(workspaceIdFromRoot(this.workspace.root), {
        limit: 500,
        status: "all",
      });
      if (args[1]) {
        const memory = memories.find((entry) => entry.id === args[1]);
        if (!memory) throw new Error(`Long-term memory not found: ${args[1]}`);
        this.terminal.write(`${json(memory)}\n`);
      } else {
        this.terminal.write(memories.length ? `${json(memories)}\n` : "This workspace has no long-term memories.\n");
      }
      return;
    }

    throw new Error("Usage: /memory short | /memory long [id]");
  }

  private printSessions(): void {
    const sessions = this.threadStore.list({
      workspaceId: workspaceIdFromRoot(this.workspace.root),
      limit: 50,
    });
    this.terminal.write(sessions.length ? `${json(sessions)}\n` : "This workspace has no previous threads.\n");
  }

  private prompt(): string {
    return chalk.bold.cyan(`EASY CODE [${this.state.mode} ${this.state.provider}/${this.state.model}] > `);
  }
}
