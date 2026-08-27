#!/usr/bin/env node

import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { Command, Option } from "commander";

import { EasyCodeApp, type EasyCodeAppOptions } from "./app.js";
import { registerConfigCommands } from "./config/config-command.js";
import type { AgentMode, ApprovalPolicyName, ProviderName } from "./core/types.js";

interface CliOptions {
  workspace?: string;
  provider?: ProviderName;
  model?: string;
  mode?: AgentMode;
  approval?: ApprovalPolicyName;
  yes?: boolean;
  resume?: string;
  image?: string[];
}

const MINIMUM_NODE_VERSION = [16, 20, 0] as const;

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
): EasyCodeAppOptions {
  return {
    workspaceRoot: options.workspace,
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    approvalPolicy: options.approval,
    assumeYes: options.yes,
    resumeThreadId: options.resume,
    imagePaths: options.image,
    startupInteraction,
  };
}

async function withApp(
  options: CliOptions,
  action: (app: EasyCodeApp) => Promise<void>,
  startupInteraction: EasyCodeAppOptions["startupInteraction"] = "none",
): Promise<void> {
  const app = await EasyCodeApp.create(appOptions(options, startupInteraction));
  try {
    await action(app);
  } finally {
    await app.closeAsync();
  }
}

function addCommonOptions(command: Command): Command {
  return command
    .option("-w, --workspace <path>", "workspace root (default: current directory)")
    .addOption(new Option("--provider <name>", "model provider").choices(["qwen", "deepseek"]))
    .option("--model <id>", "provider model id")
    .addOption(new Option("--mode <mode>", "working mode").choices(["plan", "auto", "code"]))
    .addOption(
      new Option("--approval <policy>", "command approval policy")
        .choices(["safe", "ask", "never"]),
    )
    .option("-y, --yes", "automatically approve every policy-allowed command prompt, including shells")
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
  const program = addCommonOptions(
    new Command()
      .name("easy-code")
      .description("EASY CODE — local CLI coding agent for Alibaba Qwen and DeepSeek")
      .version("0.1.0")
      .showHelpAfterError(),
  );

  program.action(async (options: CliOptions) => {
    const explicitSelection = Boolean(options.provider || options.model || options.resume);
    await withApp(
      options,
      async (app) => app.runInteractive(),
      explicitSelection ? "ensure-api-key" : "select-model",
    );
  });

  program
    .command("run")
    .description("run one prompt non-interactively")
    .argument("<prompt...>", "programming task")
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

  await program.parseAsync(argv);
}

if (isDirectExecution()) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${chalk.red("EASY CODE error:")} ${message}\n`);
    process.exitCode = 1;
  });
}

export * from "./app.js";
export * from "./config/index.js";
export * from "./core/types.js";
export * from "./memory/index.js";
export * from "./images/index.js";
export * from "./models/index.js";
export * from "./providers/index.js";
export * from "./tools/index.js";
export * from "./workspace/index.js";
