#!/usr/bin/env node

import path from "node:path";
import os from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { Command, InvalidArgumentError, Option } from "commander";

import { EasyCodeApp, type EasyCodeAppOptions } from "./app.js";
import { prepareDataDirectoryOutsideWorkspace, resolveDataDirectoryOutsideWorkspace } from "./images/path-policy.js";
import { WebInteraction } from "./web-server/interaction.js";
import { serveWeb } from "./web-server/server.js";
import { WorkspaceMutationLock } from "./subagents/workspace-mutation-lock.js";
import { createStorage } from "./storage/database.js";
import { ThreadStore } from "./threads/thread-store.js";
import { ProjectIndex } from "./web-server/projects.js";
import type { ProjectWorkspace } from "./projects/types.js";
import { registerConfigCommands } from "./config/config-command.js";
import { registerSandboxCommands } from "./sandbox/cli.js";
import {
  registerSweBenchCommands,
} from "./benchmarks/swebench.js";
import {
  registerPromptBundleCommands,
} from "./prompt-bundle/index.js";
import { registerUninstallCommand } from "./uninstall/index.js";
import { registerInstallCommands } from "./install/index.js";
import { assertNoUninstall, beginOwnedResource, completeOwnedResource, recordOwnedResource } from "./install/ownership.js";
import { registerRuntimeSession } from "./install/session.js";
import {
  THINKING_EFFORTS,
  type AgentMode,
  type ApprovalPolicyName,
  type ProviderName,
  type ThinkingEffort,
} from "./core/types.js";
import { ensureUserModelRegistry, PROVIDER_CATALOG } from "./models/catalog.js";

interface CliOptions {
  web?: boolean;
  workspace?: string;
  provider?: ProviderName;
  model?: string;
  mode?: AgentMode;
  thinkingEffort?: ThinkingEffort;
  approval?: ApprovalPolicyName;
  yes?: boolean;
  maxModelRequests?: number;
  resume?: string;
  image?: string[];
}

const MINIMUM_NODE_VERSION = [20, 11, 0] as const;

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const parts = version.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`Unable to determine the Node.js version from ${JSON.stringify(version)}`);
  }

  const [major = 0, minor = 0, patch = 0] = parts;
  const [minimumMajor, minimumMinor, minimumPatch] = MINIMUM_NODE_VERSION;
  const supported =
    major > minimumMajor ||
    (major === minimumMajor &&
      (minor > minimumMinor ||
        (minor === minimumMinor && patch >= minimumPatch)));
  if (!supported) {
    throw new Error(
      `EASY CODE requires Node.js >= ${MINIMUM_NODE_VERSION.join(".")}; current version is ${version}.`,
    );
  }
}

export function isDirectExecution(
  entryPath: string | undefined = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (!entryPath || !moduleUrl.startsWith("file:")) return false;
  const normalize = (value: string): string => {
    const absolute = path.resolve(value);
    let resolved = absolute;
    try {
      resolved = realpathSync.native(absolute);
    } catch {
      // Keep the lexical path for synthetic/nonexistent paths used by callers.
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(entryPath) === normalize(fileURLToPath(moduleUrl));
}

function appOptions(
  options: CliOptions,
  startupInteraction: EasyCodeAppOptions["startupInteraction"] = "none",
  terminal?: EasyCodeAppOptions["terminal"],
  projectWorkspace?: ProjectWorkspace,
): EasyCodeAppOptions {
  return {
    workspaceRoot: options.workspace,
    ...(projectWorkspace ? { projectWorkspace } : {}),
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    thinkingEffort: options.thinkingEffort,
    approvalPolicy: options.approval,
    assumeYes: options.yes,
    maxModelRequests: options.maxModelRequests,
    resumeThreadId: options.resume,
    imagePaths: options.image,
    startupInteraction,
    sandboxStartup: startupInteraction !== "none",
    keepInteractionOpen: options.web === true,
    ...(terminal ? { terminal } : {}),
  };
}

async function withApp(
  options: CliOptions,
  action: (app: EasyCodeApp) => Promise<void>,
  startupInteraction: EasyCodeAppOptions["startupInteraction"] = "none",
  terminal?: EasyCodeAppOptions["terminal"],
): Promise<void> {
  let app: EasyCodeApp | undefined;
  let stopRequested = false;
  const release = registerRuntimeSession(() => { stopRequested = true; app?.requestUninstallShutdown(); });
  try {
    const { loadEasyCodeConfig } = await import("./config/loader.js");
    const config = await loadEasyCodeConfig({ workspaceRoot: options.workspace, credentialStore: false });
    const resources = (["data", "config", "cache"] as const).map(kind => ({
      kind,
      path: config[(kind + "Dir") as "dataDir" | "configDir" | "cacheDir"],
    }));
    for (const resource of resources) beginOwnedResource(resource);
    recordOwnedResource({ kind: "config", path: path.join(os.homedir(), ".easy_code") });
    const dataDir = await prepareDataDirectoryOutsideWorkspace(config.dataDir, config.workspaceRoot);
    const storage = createStorage(dataDir);
    let projectWorkspace: ProjectWorkspace;
    try {
      const projects = new ProjectIndex(storage);
      if (options.resume) {
        const thread = new ThreadStore(storage).list({ limit: 100_000 })
          .find(item => item.threadId === options.resume);
        if (!thread) throw new Error(`Thread not found: ${options.resume}`);
        projectWorkspace = projects.workspace(thread.workspaceId);
      } else {
        projectWorkspace = projects.workspace(projects.add(config.workspaceRoot).id);
      }
    } finally { storage.close(); }
    app = await EasyCodeApp.create({
      ...appOptions(options, startupInteraction, terminal, projectWorkspace),
      workspaceRoot: projectWorkspace.folders.find(folder => folder.id === projectWorkspace.primaryFolderId)!.path,
    });
    for (const resource of resources) completeOwnedResource(resource);
    if (stopRequested) { app.requestUninstallShutdown(); return; }
    await action(app);
  } finally {
    try { await app?.closeAsync(); } finally { release(); }
  }
}

async function withWeb(options: CliOptions): Promise<void> {
  const { loadEasyCodeConfig } = await import("./config/loader.js");
  const config = await loadEasyCodeConfig({ workspaceRoot: options.workspace, credentialStore: false });
  const dataDir = await resolveDataDirectoryOutsideWorkspace(config.dataDir, config.workspaceRoot);
  const resources = (["data", "config", "cache"] as const).map(kind => ({
    kind, path: kind === "data" ? dataDir : config[(kind + "Dir") as "configDir" | "cacheDir"],
  }));
  for (const resource of resources) beginOwnedResource(resource);
  recordOwnedResource({ kind: "config", path: path.join(os.homedir(), ".easy_code") });
  const port = new WebInteraction();
  // A physical folder may intentionally be attached to more than one logical
  // project. One host-wide lock prevents two Web Threads from racing writes to
  // that shared folder (and remains safe for disjoint projects).
  const workspaceMutationLock = new WorkspaceMutationLock();
  const shutdown = new AbortController();
  const release = registerRuntimeSession(() => shutdown.abort());
  try {
    await prepareDataDirectoryOutsideWorkspace(dataDir, config.workspaceRoot);
    for (const resource of resources) completeOwnedResource(resource);
    await serveWeb(dataDir, port, (workspaceRoot, resumeThreadId, threadPort, projectWorkspace) => {
      if (!projectWorkspace) throw new Error("Logical project workspace is unavailable.");
      return EasyCodeApp.create({ ...appOptions(options, "none", threadPort, projectWorkspace), workspaceRoot, resumeThreadId,
        provider: undefined, model: undefined, thinkingEffort: undefined, keepInteractionOpen: true,
        workspaceMutationLock });
    }, shutdown.signal);
  } finally { port.close(); release(); }
}

function addCommonOptions(command: Command): Command {
  return command
    .option("-w, --workspace <path>", "workspace root (default: current directory)")
    .addOption(
      new Option("--provider <name>", "model provider").choices(
        PROVIDER_CATALOG.map(({ provider }) => provider),
      ),
    )
    .option("--model <id>", "provider model id")
    .addOption(new Option("--mode <mode>", "working mode").choices(["plan", "auto", "code"]))
    .addOption(
      new Option("--thinking-effort <effort>", "model thinking effort")
        .choices([...THINKING_EFFORTS]),
    )
    .addOption(
      new Option("--approval <policy>", "user prompt availability: safe/ask allow prompts; never disables prompts")
        .choices(["safe", "ask", "never"]),
    )
    .option("-y, --yes", "use the independent command approval agent; rejection requires user approval")
    .option("--resume <thread-id>", "resume a saved Thread")
    .option(
      "-i, --image <path>",
      "queue an image for the first task (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    );
}

export async function main(argv = process.argv): Promise<void> {
  assertSupportedNodeVersion();
  // Maintenance must work even with invalid/missing user models and must not
  // recreate configuration during --dry-run or after partially completed removal.
  if (argv[2] === "uninstall") {
    const maintenance = new Command().name("easy-code");
    registerUninstallCommand(maintenance);
    await maintenance.parseAsync(argv);
    return;
  }
  assertNoUninstall();
  // This fixed per-user file is created only once. Subsequent installs and
  // upgrades validate and load it without overwriting user-defined models.
  await ensureUserModelRegistry();
  const program = addCommonOptions(
    new Command()
      .name("easy-code")
      .description(
        "EASY CODE — local CLI coding agent with a user-maintained OpenAI-compatible model registry",
      )
      .version("0.1.0")
      .showHelpAfterError(),
  );

  program.option("--web", "open the local Vue Web interface");

  program.action(async (options: CliOptions) => {
    if (options.web) {
      if (options.image?.length) throw new Error("Use the Web composer to attach images when launching with --web.");
      await withWeb(options);
      return;
    }
    await withApp(
      options,
      async (app) => app.runInteractive(),
      "ensure-api-key",
    );
  });

  program
    .command("run")
    .description("run one prompt non-interactively")
    .argument("<prompt...>", "programming task")
    .option(
      "--max-model-requests <count>",
      "stop after this many aggregate model API requests (main agent, children, reviewer, approvals, and compaction)",
      parseModelRequestLimit,
    )
    .action(async (promptParts: string[], _localOptions: unknown, command: Command) => {
      const options = command.optsWithGlobals() as CliOptions;
      await withApp(options, async (app) => {
        const result = await app.runOnce(promptParts.join(" "));
        if (result.reason !== "success" && result.reason !== "planned") {
          process.exitCode = 1;
        }
      });
    });

  registerConfigCommands(program);
  registerPromptBundleCommands(program);
  registerSandboxCommands(program);
  registerSweBenchCommands(program);
  registerInstallCommands(program);
  registerUninstallCommand(program);
  await program.parseAsync(argv);
}

export function parseModelRequestLimit(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("must be a positive safe integer");
  }
  return parsed;
}

if (isDirectExecution()) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${chalk.red("EASY CODE error:")} ${message}\n`);
    process.exitCode = 1;
  });
}

export * from "./app.js";
export * from "./benchmarks/index.js";
export * from "./config/index.js";
export * from "./core/types.js";
export * from "./memory/index.js";
export * from "./images/index.js";
export * from "./install/index.js";
export * from "./models/index.js";
export * from "./providers/index.js";
export * from "./prompt-bundle/index.js";
export * from "./subagents/index.js";
export * from "./tasks/index.js";
export * from "./tools/index.js";
export * from "./uninstall/index.js";
export * from "./workspace/index.js";
