import path from "node:path";

import chalk from "chalk";

import { Terminal, printBanner } from "./cli/terminal.js";
import type { PromptSubmission } from "./cli/prompt-input.js";
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
  ImageAttachment,
  ProviderName,
  SessionState,
  ThinkingEffort,
} from "./core/types.js";
import { THINKING_EFFORTS } from "./core/types.js";
import {
  ImageStore,
  MAX_IMAGES_PER_MODEL_REQUEST,
  SystemClipboardImageReader,
  assertThreadImageNumberAvailable,
  nextThreadImageNumber,
  prepareDataDirectoryOutsideWorkspace,
  validateImageAttachmentCollection,
  type ClipboardImageReader,
} from "./images/index.js";
import { LocalEmbeddingModel } from "./memory/embedding-model.js";
import { MemoryManager } from "./memory/memory-manager.js";
import { redactSensitiveInformation } from "./memory/sensitive.js";
import { MemoryVectorIndex } from "./memory/vector-index.js";
import {
  DEFAULT_MODEL_IDS,
  PROVIDER_CATALOG,
  modelsForProvider,
  providerLabel,
  requireCatalogModel,
  requireVisionModel,
  resolveCatalogModel,
  modelSupportsVision,
  validateProviderImageAttachments,
} from "./models/catalog.js";
import {
  thinkingEffortIsApplied,
  thinkingEffortStepLimit,
} from "./models/thinking.js";
import { buildSystemPrompt } from "./prompts/builder.js";
import { createProvider } from "./providers/factory.js";
import { AgentRuntime } from "./runtime/agent.js";
import { createStorage, workspaceIdFromRoot, type EasyCodeStorage } from "./storage/database.js";
import { createDefaultTools } from "./tools/registry.js";
import { ThreadStore, type ThreadLease } from "./threads/thread-store.js";
import { taskGraphView } from "./tasks/task-graph.js";
import { WorkspaceManager } from "./workspace/manager.js";

export interface EasyCodeAppOptions {
  workspaceRoot?: string;
  provider?: ProviderName;
  model?: string;
  mode?: AgentMode;
  approvalPolicy?: ApprovalPolicyName;
  thinkingEffort?: ThinkingEffort;
  assumeYes?: boolean;
  resumeThreadId?: string;
  startupInteraction?: "none" | "select-model" | "ensure-api-key";
  terminal?: Terminal;
  /** Dependency injection for isolated tests; false disables keyring reads. */
  credentialStore?: ApiKeyCredentialStore | false;
  /** Images queued before the first prompt; the option may be repeated by the CLI. */
  imagePaths?: readonly string[];
  /** Dependency injection for clipboard tests. */
  clipboardImageReader?: ClipboardImageReader;
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
  const labels = message.role === "user" && message.images?.length
    ? ` [${message.images.map((image) => image.label).join(", ")}]`
    : "";
  return `${role}: ${compact || "(empty)"}${labels}`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function stripPasteFailureMarkers(value: string): string {
  return value.replace(/\s*\[Image paste failed\]\s*/gu, " ").trim();
}

function stripImageMarkers(
  value: string,
  images: readonly ImageAttachment[],
): string {
  let result = value;
  for (const image of images) {
    result = result.replaceAll(`[${image.label}]`, " ");
  }
  return stripPasteFailureMarkers(result).replace(/\s+/gu, " ").trim();
}

export function repairInterruptedTurn(threadStore: ThreadStore, state: SessionState): boolean {
  const turnId = state.activeTurnId;
  if (!turnId) return false;

  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const candidate = state.messages[index];
    if (candidate?.role !== "assistant" || !candidate.tool_calls?.length) continue;
    const completedCallIds = new Set(
      state.messages
        .slice(index + 1)
        .filter((message): message is Extract<ChatMessage, { role: "tool" }> =>
          message.role === "tool")
        .map((message) => message.tool_call_id),
    );
    for (const call of candidate.tool_calls) {
      if (completedCallIds.has(call.id)) continue;
      const toolMessage: Extract<ChatMessage, { role: "tool" }> = {
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify({
          ok: false,
          summary: "Tool execution was interrupted before a result was recorded.",
          error: "interrupted",
        }),
      };
      state.messages.push(toolMessage);
      threadStore.appendEvent(state.threadId, {
        turnId,
        type: "tool.result",
        phase: "interrupted",
        payload: { callId: call.id, tool: call.function.name, message: toolMessage },
      });
    }
    break;
  }

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
  private threadLease: ThreadLease | undefined;
  private readonly imageStore: ImageStore;
  private pendingImages: ImageAttachment[] = [];
  private closed = false;
  private dirty = false;

  private constructor(
    private readonly config: EasyCodeConfig,
    private readonly storage: EasyCodeStorage,
    workspace: WorkspaceManager,
    state: SessionState,
    threadLease: ThreadLease,
    private readonly terminal: Terminal,
    private readonly assumeYes: boolean,
    private readonly credentialStore: ApiKeyCredentialStore | undefined,
    private readonly startupInteraction: "none" | "select-model" | "ensure-api-key",
    private readonly clipboardImageReader: ClipboardImageReader,
  ) {
    this.workspace = workspace;
    this.state = state;
    this.threadLease = threadLease;
    // The postinstall hook and runtime intentionally share the same stable
    // per-user model cache, independent of workspace/user config layering.
    const embeddingModel = new LocalEmbeddingModel();
    const vectorIndex = new MemoryVectorIndex(storage, embeddingModel);
    let reportedVectorFailure = false;
    this.memoryManager = new MemoryManager(storage, {
      vectorIndex,
      onVectorError: (error) => {
        if (reportedVectorFailure) return;
        reportedVectorFailure = true;
        const detail = error instanceof Error ? error.message : String(error);
        terminal.info(
          `Semantic memory search is unavailable (${detail}). ` +
          "EASY CODE is using lexical fallback; reinstall without --ignore-scripts to repair the local embedding model.",
        );
      },
    });
    this.threadStore = new ThreadStore(storage);
    this.imageStore = new ImageStore(config.dataDir);
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
    let threadStore: ThreadStore | undefined;
    let threadLease: ThreadLease | undefined;
    try {
      const workspace = await WorkspaceManager.create(config.workspaceRoot);
      config.dataDir = await prepareDataDirectoryOutsideWorkspace(
        config.dataDir,
        workspace.root,
      );
      storage = createStorage(config.dataDir);
      threadStore = new ThreadStore(storage);
      let state: SessionState;
      let shouldCheckpoint = false;

      if (options.resumeThreadId) {
        threadLease = threadStore.acquireThreadLease(options.resumeThreadId);
        state = threadStore.recover(options.resumeThreadId);
        if (!samePath(state.workspaceRoot, workspace.root)) {
          throw new Error(
            `Thread ${state.threadId} belongs to ${state.workspaceRoot}; launch EASY CODE with that --workspace first.`,
          );
        }
        const previousMode = state.mode;
        const previousProvider = state.provider;
        const previousModel = state.model;
        const previousThinkingEffort = state.thinkingEffort;
        const resumedMode = options.mode ?? state.mode;
        if (
          resumedMode === "plan" &&
          state.taskGraph &&
          state.taskGraph.status !== "completed"
        ) {
          throw new Error(
            "Cannot resume an active or blocked task DAG in Plan mode. Use Code/Auto mode until it is completed.",
          );
        }
        state.mode = resumedMode;
        state.thinkingEffort = options.thinkingEffort ?? state.thinkingEffort;
        const selectedProvider = options.provider ?? state.provider;
        state.provider = selectedProvider;
        state.model = options.model
          ? requireCatalogModel(selectedProvider, options.model).id
          : options.provider
            ? config[selectedProvider].model
            : state.model;
        const repairedInterruptedTurn = repairInterruptedTurn(threadStore, state);
        shouldCheckpoint =
          previousMode !== state.mode ||
          previousProvider !== state.provider ||
          previousModel !== state.model ||
          previousThinkingEffort !== state.thinkingEffort ||
          repairedInterruptedTurn;
      } else {
        const selectedProvider = options.provider ?? config.provider;
        const selectedMode = options.mode ?? config.mode;
        const selectedModel = options.model
          ? requireCatalogModel(selectedProvider, options.model).id
          : config[selectedProvider].model;
        state = threadStore.create({
          workspaceRoot: workspace.root,
          mode: selectedMode,
          provider: selectedProvider,
          model: selectedModel,
          thinkingEffort: options.thinkingEffort ?? config.thinkingEffort,
        });
        threadLease = threadStore.acquireThreadLease(state.threadId);
      }

      config.workspaceRoot = workspace.root;
      config.provider = state.provider;
      config.mode = state.mode;
      config.thinkingEffort = state.thinkingEffort;
      config[state.provider].model = state.model;
      if (shouldCheckpoint) threadStore.save(state);
      const app = new EasyCodeApp(
        config,
        storage,
        workspace,
        state,
        threadLease,
        terminal,
        options.assumeYes ?? false,
        credentialStore,
        options.startupInteraction ?? "none",
        options.clipboardImageReader ?? new SystemClipboardImageReader({
          currentDirectory: workspace.root,
        }),
      );
      try {
        await app.imageStore.initialize();
        for (const imagePath of options.imagePaths ?? []) {
          await app.queueImagePath(imagePath, false);
        }
      } catch (error) {
        await app.clearPendingImages();
        await app.imageStore.shutdown().catch(() => undefined);
        throw error;
      }
      return app;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (threadLease && threadStore) {
        try {
          threadStore.releaseThreadLease(threadLease);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        storage?.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        terminal.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "EASY CODE creation failed and resource cleanup also failed",
        );
      }
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
      const promptImages: ImageAttachment[] = [];
      let promptOpen = true;
      let response: PromptSubmission | null;
      try {
        response = await this.terminal.readPrompt(this.prompt(), {
          initialImageCount:
            nextThreadImageNumber(this.state.messages, this.pendingImages) - 1,
          captureImage: async (index, signal) => {
            const attachment = await this.captureClipboardImage(
              index,
              [...this.pendingImages, ...promptImages],
              signal,
            );
            if (!promptOpen) {
              await this.imageStore.remove(this.state.threadId, attachment).catch(() => undefined);
              throw new Error("The prompt was closed before the clipboard image finished loading.");
            }
            promptImages.push(attachment);
            return attachment;
          },
        });
      } catch (error) {
        await this.discardImages(promptImages);
        throw error;
      } finally {
        promptOpen = false;
      }
      if (response === null) {
        await this.discardImages(promptImages);
        await this.clearPendingImages();
        return;
      }
      for (const error of response.pasteErrors) {
        this.terminal.error(`Image paste failed: ${error}`);
      }
      const input = stripPasteFailureMarkers(response.text);
      const images = [...this.pendingImages, ...response.images];
      if (!input && images.length === 0) continue;

      // Image markers are removed only while recognizing slash commands. They
      // remain in normal prompts so the provider can preserve the user's
      // intended ordering when several screenshots are referenced.
      const commandInput = stripImageMarkers(input, response.images);
      const slash = parseSlashCommand(commandInput);
      if (slash) {
        if (response.images.length) {
          this.pendingImages.push(...response.images);
          this.terminal.info(
            `Queued ${response.images.map((image) => image.label).join(", ")} for the next task.`,
          );
        }
        try {
          const shouldExit = await this.handleSlashCommand(commandInput);
          if (shouldExit) return;
        } catch (error) {
          this.terminal.error(error instanceof Error ? error.message : String(error));
        }
        continue;
      }

      try {
        await this.executePrompt(
          input || "Analyze the attached image(s).",
          images,
          true,
        );
        this.pendingImages = [];
      } catch (error) {
        this.pendingImages = images;
        this.terminal.error(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async runOnce(prompt: string): Promise<AgentRunResult> {
    const normalized = prompt.trim();
    if (!normalized && this.pendingImages.length === 0) {
      throw new Error("A non-empty prompt or at least one image is required");
    }
    const result = await this.executePrompt(
      normalized || "Analyze the attached image(s).",
      this.pendingImages,
    );
    this.pendingImages = [];
    return result;
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
        if (
          mode === "plan" &&
          this.state.taskGraph &&
          this.state.taskGraph.status !== "completed"
        ) {
          throw new Error(
            "Cannot switch to Plan mode while a task DAG is active or blocked. Complete or resolve it in Code/Auto mode first.",
          );
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
          !["qwen", "deepseek", "glm"].includes(provider)
        ) {
          throw new Error("Usage: /provider qwen|deepseek|glm");
        }
        this.requireProviderApiKey(provider);
        const model = requireCatalogModel(provider, this.config[provider].model).id;
        this.commitModelSelection(provider, model, "Provider switched to");
        return false;
      }
      case "model": {
        const request = parseModelCommand(command.args);
        if (request.action === "select") {
          const selection = await this.selectProviderAndModel();
          if (!selection) {
            this.terminal.info("Model selection canceled.");
            return false;
          }
          if (!(await this.ensureProviderApiKey(selection.provider))) return false;
          this.commitModelSelection(
            selection.provider,
            selection.model,
            "Model switched to",
            selection.thinkingEffort,
          );
          return false;
        }

        const provider = request.provider ?? this.state.provider;
        const model = requireCatalogModel(provider, request.model).id;
        this.requireProviderApiKey(provider);
        this.commitModelSelection(provider, model);
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
      case "image": {
        if (!command.rawArgs) throw new Error("Usage: /image <path|clipboard|clear>");
        if (command.rawArgs.toLowerCase() === "clear") {
          const count = this.pendingImages.length;
          await this.clearPendingImages();
          this.terminal.success(`Cleared ${count} queued image(s).`);
          return false;
        }
        this.requireCurrentModelVision();
        if (command.rawArgs.toLowerCase() === "clipboard") {
          const attachment = await this.captureClipboardImage(
            nextThreadImageNumber(this.state.messages, this.pendingImages),
          );
          this.pendingImages.push(attachment);
          this.terminal.success(`Queued ${attachment.label} from the clipboard.`);
          return false;
        }
        await this.queueImagePath(command.rawArgs, true);
        return false;
      }
      case "changes": {
        this.syncWorkspaceState();
        const changes = this.state.changes;
        this.terminal.write(changes.length ? `${json(changes)}\n` : "This thread has no file changes.\n");
        return false;
      }
      case "tasks": {
        if (command.args.length) throw new Error("Usage: /tasks");
        this.terminal.write(
          this.state.taskGraph
            ? `${json(taskGraphView(this.state.taskGraph))}\n`
            : "This thread has no task DAG.\n",
        );
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
      case "thinking": {
        if (command.args.length > 1) {
          throw new Error("Usage: /thinking [id|last]");
        }
        const rawTarget = command.args[0]?.toLowerCase();
        let target: number | "last" = "last";
        if (rawTarget && rawTarget !== "last") {
          if (!/^[1-9][0-9]{0,15}$/u.test(rawTarget)) {
            throw new Error("Usage: /thinking [id|last]");
          }
          const id = Number(rawTarget);
          if (!Number.isSafeInteger(id)) {
            throw new Error("Usage: /thinking [id|last]");
          }
          target = id;
        }
        if (!this.terminal.showReasoning(target)) {
          this.terminal.info(
            target === "last"
              ? "No Thinking content is available in this thread."
              : `Thinking block #${target} is not available in this thread.`,
          );
        }
        return false;
      }
      case "sessions":
        this.printSessions();
        return false;
      case "resume": {
        const threadId = command.args[0];
        if (!threadId || command.args.length !== 1) throw new Error("Usage: /resume <thread-id>");
        await this.clearPendingImages();
        await this.resumeThread(threadId);
        this.terminal.success(`Resumed thread ${this.state.threadId}`);
        return false;
      }
      case "new":
        if (command.args.length) throw new Error("Usage: /new");
        await this.clearPendingImages();
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
        await this.clearPendingImages();
        return true;
      default:
        throw new Error(`Unknown command /${command.name}; use /help to view available commands.`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const cleanupErrors: unknown[] = [];
    try {
      this.save();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (this.threadLease) {
      try {
        this.threadStore.releaseThreadLease(this.threadLease);
        this.threadLease = undefined;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      this.storage.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      this.terminal.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "Failed to close EASY CODE cleanly");
    }
  }

  async closeAsync(): Promise<void> {
    if (this.closed) return;
    try {
      await this.clearPendingImages();
      await this.imageStore.shutdown();
    } finally {
      this.close();
    }
  }

  private async executePrompt(
    userInput: string,
    images: readonly ImageAttachment[] = [],
    presentReasoning = false,
  ): Promise<AgentRunResult> {
    this.requireProviderApiKey(this.state.provider);
    if (images.length) this.requireCurrentModelVision();
    validateImageAttachmentCollection(images);
    validateProviderImageAttachments(this.state.provider, images);
    this.dirty = true;
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
      const runtime = this.createRuntime(presentReasoning);
      const result = await runtime.run(this.state, { text: userInput, images }, {
        maxSteps: this.activeStepLimit(),
        maxContextChars: this.config.maxContextChars,
        maxOutputChars: this.config.maxOutputChars,
        commandTimeoutMs: this.config.commandTimeoutMs,
        approvalPolicy: this.config.approvalPolicy,
        signal: controller.signal,
      });

      this.syncWorkspaceState();
      this.terminal.write(`\n${result.text.trim()}\n\n`);
      return result;
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      this.save();
    }
  }

  private createRuntime(presentReasoning: boolean): AgentRuntime {
    const effectiveConfig = this.effectiveConfig();
    const visionCapable = modelSupportsVision(this.state.provider, this.state.model);
    const provider = createProvider(
      effectiveConfig,
      this.state.provider,
      this.state.model,
      { loadImage: (attachment) => this.imageStore.load(this.state.threadId, attachment) },
    );
    const workspaceId = workspaceIdFromRoot(this.workspace.root);
    const tools = createDefaultTools(this.workspace, this.memoryManager).filter(
      (tool) => tool.name !== "read_image" || visionCapable,
    );

    return new AgentRuntime({
      provider,
      tools,
      contextManager: new ContextManager(),
      buildSystemPrompt: async ({ mode, workspaceSummary, memories, taskGraph }) =>
        buildSystemPrompt({
          config: effectiveConfig,
          mode,
          workspaceSummary,
          memories,
          ...(taskGraph ? { taskGraph } : {}),
        }),
      getWorkspaceSummary: async () => json(this.workspace.getManifestSummary()),
      searchMemories: async (query) => this.memoryManager.searchHybrid(workspaceId, query),
      commitMemoryMutations: async (input) =>
        this.memoryManager.applyModelMutationsWithEmbeddings({
          workspaceRoot: input.workspaceRoot,
          threadId: input.threadId,
          turnId: input.turnId,
          outcome: input.outcome,
          userInput: input.userInput,
          mutations: input.mutations,
        }),
      appendEvent: async (event) => {
        const { threadId, ...input } = event;
        this.threadStore.appendEvent(threadId, input);
        this.dirty = true;
      },
      recordCommand: (turnId, entry) => {
        this.threadStore.recordToolAudit(this.state.threadId, turnId, entry);
        this.dirty = true;
      },
      commitImages: async (threadId, attachments) => {
        for (const attachment of attachments) {
          await this.imageStore.commit(threadId, attachment);
        }
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
      onModelRequestStart: (text) => this.terminal.startActivity(text),
      onModelRequestEnd: () => this.terminal.stopActivity(),
      ...(presentReasoning
        ? {
            onReasoning: ({ text }: { text: string }) => {
              try {
                this.terminal.addReasoning(text);
              } catch {
                // Reasoning presentation is transient and must never interrupt
                // a persisted model response or its pending tool calls.
              }
            },
          }
        : {}),
      ...(visionCapable
        ? {
            attachImage: (input: {
              threadId: string;
              label: string;
              absolutePath: string;
              sourceName?: string;
            }) => this.imageStore.importFile(
              input.threadId,
              input.label,
              input.absolutePath,
              input.sourceName,
              this.workspace.root,
            ),
            discardImage: (threadId: string, attachment: ImageAttachment) =>
              this.imageStore.remove(threadId, attachment),
          }
        : {}),
    });
  }

  private requireCurrentModelVision(): void {
    requireVisionModel(this.state.provider, this.state.model);
  }

  private async captureClipboardImage(
    index: number,
    currentImages: readonly ImageAttachment[] = this.pendingImages,
    signal?: AbortSignal,
  ): Promise<ImageAttachment> {
    this.requireCurrentModelVision();
    if (currentImages.length >= MAX_IMAGES_PER_MODEL_REQUEST) {
      throw new Error(`A task can contain at most ${MAX_IMAGES_PER_MODEL_REQUEST} images.`);
    }
    assertThreadImageNumberAvailable(index);
    const data = await this.clipboardImageReader.readImage(signal);
    const attachment = await this.imageStore.importBuffer(
      this.state.threadId,
      `Image #${index}`,
      data,
      "clipboard",
    );
    try {
      validateImageAttachmentCollection([...currentImages, attachment]);
      validateProviderImageAttachments(this.state.provider, [attachment]);
      return attachment;
    } catch (error) {
      await this.imageStore.remove(this.state.threadId, attachment).catch(() => undefined);
      throw error;
    }
  }

  private async queueImagePath(rawPath: string, announce: boolean): Promise<ImageAttachment> {
    if (this.pendingImages.length >= MAX_IMAGES_PER_MODEL_REQUEST) {
      throw new Error(`A task can contain at most ${MAX_IMAGES_PER_MODEL_REQUEST} images.`);
    }
    let normalized = rawPath.trim();
    if (
      normalized.length >= 2 &&
      ((normalized.startsWith('"') && normalized.endsWith('"')) ||
        (normalized.startsWith("'") && normalized.endsWith("'")))
    ) {
      normalized = normalized.slice(1, -1);
    }
    if (!normalized) throw new Error("Image path must not be empty.");
    const absolutePath = path.isAbsolute(normalized)
      ? normalized
      : path.resolve(this.workspace.root, normalized);
    const imageNumber = nextThreadImageNumber(this.state.messages, this.pendingImages);
    assertThreadImageNumberAvailable(imageNumber);
    const attachment = await this.imageStore.importFile(
      this.state.threadId,
      `Image #${imageNumber}`,
      absolutePath,
      path.basename(normalized),
    );
    try {
      validateImageAttachmentCollection([...this.pendingImages, attachment]);
      validateProviderImageAttachments(this.state.provider, [attachment]);
    } catch (error) {
      await this.imageStore.remove(this.state.threadId, attachment).catch(() => undefined);
      throw error;
    }
    this.pendingImages.push(attachment);
    if (announce) {
      this.terminal.success(
        `Queued ${attachment.label}: ${attachment.width}x${attachment.height} ${attachment.mediaType}.`,
      );
    }
    return attachment;
  }

  private async discardImages(images: readonly ImageAttachment[]): Promise<void> {
    await Promise.all(images.map((image) =>
      this.imageStore.remove(this.state.threadId, image).catch(() => undefined),
    ));
  }

  private async clearPendingImages(): Promise<void> {
    const images = this.pendingImages;
    this.pendingImages = [];
    await this.discardImages(images);
  }

  private async prepareInteractiveStartup(): Promise<boolean> {
    if (this.startupInteraction === "none") return true;

    let selection = {
      provider: this.state.provider,
      model: this.state.model,
      thinkingEffort: this.state.thinkingEffort,
    };
    if (this.startupInteraction === "select-model") {
      const selected = await this.selectProviderAndModel();
      if (!selected) {
        this.terminal.info("Startup model selection canceled.");
        return false;
      }
      selection = selected;
    }

    if (!(await this.ensureProviderApiKey(selection.provider))) return false;

    if (this.startupInteraction === "select-model") {
      this.commitModelSelection(
        selection.provider,
        selection.model,
        "Selected",
        selection.thinkingEffort,
      );
    } else {
      const applied = thinkingEffortIsApplied(
        selection.provider,
        selection.model,
        selection.thinkingEffort,
      );
      this.terminal.success(
        `Selected ${providerLabel(selection.provider)} / ${selection.model} / ` +
          `thinking ${selection.thinkingEffort}${applied ? "" : " (saved, not applied)"}`,
      );
    }
    return true;
  }

  private async selectProviderAndModel(): Promise<{
    provider: ProviderName;
    model: string;
    thinkingEffort: ThinkingEffort;
  } | undefined> {
    const provider = await this.terminal.selectProvider(
      PROVIDER_CATALOG.map((entry) => ({
        provider: entry.provider,
        label: entry.label,
        apiKeyConfigured: Boolean(this.config[entry.provider].apiKey),
      })),
      this.state.provider,
    );
    if (!provider) return undefined;

    const configuredModel = this.config[provider].model;
    const initialModel = resolveCatalogModel(provider, configuredModel)?.id ??
      DEFAULT_MODEL_IDS[provider];
    const model = await this.terminal.selectModel(
      providerLabel(provider),
      modelsForProvider(provider),
      initialModel,
    );
    if (!model) return undefined;
    const canonicalModel = requireCatalogModel(provider, model).id;
    const thinkingEffort = await this.terminal.selectThinkingEffort(
      providerLabel(provider),
      canonicalModel,
      THINKING_EFFORTS.map((effort) => ({
        id: effort,
        label: effort[0]!.toUpperCase() + effort.slice(1),
        applied: thinkingEffortIsApplied(provider, canonicalModel, effort),
      })),
      this.state.thinkingEffort,
    );
    if (!thinkingEffort) return undefined;
    return { provider, model: canonicalModel, thinkingEffort };
  }

  private async ensureProviderApiKey(provider: ProviderName): Promise<boolean> {
    if (this.config[provider].apiKey) return true;
    if (!this.credentialStore) {
      throw new Error(
        `No ${provider} API key is configured, and the system credential store is unavailable. ` +
          `Run easy-code config set ${provider}.api-key or set the corresponding environment variable.`,
      );
    }
    this.terminal.info(`No API key is configured for ${providerLabel(provider)}.`);
    let value: string;
    try {
      value = await this.terminal.readSecret(
        `Enter the ${providerLabel(provider)} API key (input is hidden): `,
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
    return true;
  }

  private commitModelSelection(
    provider: ProviderName,
    model: string,
    verb = "Model switched to",
    thinkingEffort = this.state.thinkingEffort,
  ): void {
    const canonicalModel = requireCatalogModel(provider, model).id;
    const previous = {
      stateProvider: this.state.provider,
      stateModel: this.state.model,
      stateThinkingEffort: this.state.thinkingEffort,
      configProvider: this.config.provider,
      configModel: this.config[provider].model,
      configThinkingEffort: this.config.thinkingEffort,
      dirty: this.dirty,
    };
    try {
      this.state.provider = provider;
      this.state.model = canonicalModel;
      this.state.thinkingEffort = thinkingEffort;
      this.config.provider = provider;
      this.config[provider].model = canonicalModel;
      this.config.thinkingEffort = thinkingEffort;
      this.dirty = true;
      this.save();
    } catch (error) {
      this.state.provider = previous.stateProvider;
      this.state.model = previous.stateModel;
      this.state.thinkingEffort = previous.stateThinkingEffort;
      this.config.provider = previous.configProvider;
      this.config[provider].model = previous.configModel;
      this.config.thinkingEffort = previous.configThinkingEffort;
      this.dirty = previous.dirty;
      throw error;
    }
    const applied = thinkingEffortIsApplied(provider, canonicalModel, thinkingEffort);
    this.terminal.success(
      `${verb} ${providerLabel(provider)} / ${canonicalModel} / thinking ${thinkingEffort}` +
        (applied ? "" : " (saved, not applied)"),
    );
    if (this.pendingImages.length && !modelSupportsVision(provider, canonicalModel)) {
      this.terminal.info(
        `${this.pendingImages.length} queued image(s) remain attached, but this model cannot receive them. ` +
          "Choose an image-capable model before submitting the task.",
      );
    }
  }

  private effectiveConfig(): EasyCodeConfig {
    const config: EasyCodeConfig = {
      ...this.config,
      mode: this.state.mode,
      thinkingEffort: this.state.thinkingEffort,
      provider: this.state.provider,
      qwen: { ...this.config.qwen },
      deepseek: { ...this.config.deepseek },
      glm: { ...this.config.glm },
    };
    config[this.state.provider].model = this.state.model;
    return config;
  }

  private activeStepLimit(): number {
    return thinkingEffortStepLimit(
      this.state.thinkingEffort,
      this.config.maxSteps,
    );
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

  private async newThread(): Promise<void> {
    this.save();
    const previousLease = this.requireThreadLease();
    const nextWorkspace = await WorkspaceManager.create(this.config.workspaceRoot);
    const nextState = this.threadStore.create({
      workspaceRoot: nextWorkspace.root,
      mode: this.state.mode,
      provider: this.state.provider,
      model: this.state.model,
      thinkingEffort: this.state.thinkingEffort,
    });
    let nextLease: ThreadLease | undefined;
    try {
      nextLease = this.threadStore.acquireThreadLease(nextState.threadId);
      this.threadStore.releaseThreadLease(previousLease);
    } catch (error) {
      if (nextLease) {
        try {
          this.threadStore.releaseThreadLease(nextLease);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Could not switch threads and the new thread lease could not be released",
          );
        }
      }
      throw error;
    }
    this.workspace = nextWorkspace;
    this.state = nextState;
    this.threadLease = nextLease;
    this.dirty = false;
    this.terminal.clearReasoning();
  }

  private async resumeThread(threadId: string): Promise<void> {
    if (threadId === this.state.threadId) {
      this.save();
      return;
    }
    this.save();
    const previousLease = this.requireThreadLease();
    let nextLease: ThreadLease | undefined;
    let recovered: SessionState;
    let nextWorkspace: WorkspaceManager;
    let repairedInterruptedTurn: boolean;
    try {
      nextLease = this.threadStore.acquireThreadLease(threadId);
      recovered = this.threadStore.recover(threadId);
      if (!samePath(recovered.workspaceRoot, this.workspace.root)) {
        throw new Error(
          `Thread ${threadId} belongs to ${recovered.workspaceRoot}; restart with --workspace for that directory.`,
        );
      }
      nextWorkspace = await WorkspaceManager.create(recovered.workspaceRoot);
      repairedInterruptedTurn = repairInterruptedTurn(this.threadStore, recovered);
      this.threadStore.releaseThreadLease(previousLease);
    } catch (error) {
      if (nextLease) {
        try {
          this.threadStore.releaseThreadLease(nextLease);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Could not resume the thread and its lease could not be released",
          );
        }
      }
      throw error;
    }
    this.threadLease = nextLease;
    this.state = recovered;
    this.workspace = nextWorkspace;
    this.config.mode = recovered.mode;
    this.config.thinkingEffort = recovered.thinkingEffort;
    this.config.provider = recovered.provider;
    this.config[recovered.provider].model = recovered.model;
    this.dirty = repairedInterruptedTurn;
    this.terminal.clearReasoning();
    this.save();
  }

  private requireThreadLease(): ThreadLease {
    if (!this.threadLease) {
      throw new Error("The active thread lease is unavailable");
    }
    return this.threadLease;
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
        thinkingEffort: this.state.thinkingEffort,
        thinkingApplied: thinkingEffortIsApplied(
          this.state.provider,
          this.state.model,
          this.state.thinkingEffort,
        ),
        stepLimit: this.activeStepLimit(),
        vision: modelSupportsVision(this.state.provider, this.state.model),
        pendingImages: this.pendingImages.map((image) => image.label),
        taskDag: this.state.taskGraph
          ? (() => {
              const view = taskGraphView(this.state.taskGraph as NonNullable<SessionState["taskGraph"]>);
              return {
                id: view.id,
                status: view.status,
                progress: `${view.completed}/${view.total}`,
                currentTask: view.currentTask,
                startableTasks: view.startableTasks,
              };
            })()
          : null,
        apiKeyConfigured: Boolean(providerConfig.apiKey),
        workspace: this.workspace.root,
        approvalPolicy: this.config.approvalPolicy,
        autoApprovePrompts: this.assumeYes,
        database: this.storage.databasePath,
      })}\n`,
    );
  }

  private requireProviderApiKey(provider: ProviderName): void {
    if (this.config[provider].apiKey) return;
    const environment = provider === "qwen"
      ? "QWEN_API_KEY (DASHSCOPE_API_KEY is also supported)"
      : provider === "deepseek"
        ? "DEEPSEEK_API_KEY"
        : "ZAI_API_KEY (GLM_API_KEY and ZHIPUAI_API_KEY are also supported)";
    throw new Error(
      `No ${provider} API key is configured. Run ` +
      `easy-code config set ${provider}.api-key (saved to the system credential store), ` +
      `or set the ${environment} environment variable, then restart EASY CODE.`,
    );
  }

  private printTools(): void {
    const tools = createDefaultTools(this.workspace, this.memoryManager).map((tool) => ({
      name: tool.name,
      available:
        (tool.name !== "read_image" ||
          modelSupportsVision(this.state.provider, this.state.model)) &&
        (this.state.mode !== "plan" ||
          tool.name === "read_file" ||
          tool.name === "read_image" ||
          tool.name === "run_command" ||
          tool.name === "compact_context" ||
          tool.name === "manage_memory"),
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
          compactedMessageCount: this.state.compactedMessageCount,
          activeMessageCount: Math.max(
            0,
            this.state.messages.length - this.state.compactedMessageCount,
          ),
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
    return chalk.bold.cyan(
      `EASY CODE [${this.state.mode} ${this.state.provider}/${this.state.model} thinking:${this.state.thinkingEffort}] > `,
    );
  }
}
