import path from "node:path";

import chalk from "chalk";
import type { Command } from "commander";

import {
  activePromptBundleBinding,
  ensurePromptBundle,
  loadPromptBundleCatalog,
} from "./manager.js";
import { getEasyCodeHome } from "./paths.js";

function printBundleSummary(): void {
  const catalog = loadPromptBundleCatalog();
  const binding = activePromptBundleBinding();
  process.stdout.write(
    [
      `Prompt Bundle: ${binding.bundleVersion}`,
      `Format: ${String(binding.formatVersion)}`,
      `Manifest: ${binding.manifestHash}`,
      `Tools: ${String(catalog.listTools().length)} (${binding.toolCatalogHash})`,
      `Location: ${path.join(getEasyCodeHome(), "bundles", `prompt-${binding.bundleVersion}`)}`,
    ].join("\n") + "\n",
  );
}

/** Register integrity diagnostics for the fixed, non-configurable Bundle. */
export function registerPromptBundleCommands(program: Command): Command {
  const prompts = program
    .command("prompts")
    .description("inspect or repair the trusted EASY CODE prompt/tool Bundle");

  prompts
    .command("doctor")
    .description("verify the installed Bundle and show its bound versions")
    .action(async () => {
      await ensurePromptBundle();
      process.stdout.write(`${chalk.green("Prompt Bundle integrity checks passed.")}\n`);
      printBundleSummary();
    });

  prompts
    .command("repair")
    .description("restore missing or changed official Bundle files from this installation")
    .action(async () => {
      await ensurePromptBundle();
      process.stdout.write(`${chalk.green("Prompt Bundle is verified and repaired if needed.")}\n`);
      printBundleSummary();
    });

  prompts
    .command("list")
    .description("list the active tool contracts")
    .action(async () => {
      await ensurePromptBundle();
      const catalog = loadPromptBundleCatalog();
      printBundleSummary();
      for (const id of catalog.listTools()) {
        const tool = catalog.getTool(id);
        process.stdout.write(`- ${id} contract ${tool.contractVersion}\n`);
      }
    });

  prompts.action(() => prompts.outputHelp());
  return prompts;
}
