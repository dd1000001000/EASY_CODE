import os from "node:os";
import path from "node:path";

import type {
  AgentMode,
  CommandExecutionMode,
  EasyCodeConfig,
  LongTermMemory,
  PlanReviewState,
  TaskGraph,
  ToolName,
} from "../core/types.js";
import {
  loadPromptBundleCatalog,
  type PromptBundleCatalog,
  type PromptToolMetadata,
} from "../prompt-bundle/index.js";
import { taskGraphPromptView } from "../tasks/task-graph.js";
import {
  loadEasyCodeInstructions,
  type EasyCodeInstruction,
} from "./instructions.js";

export interface BuildSystemPromptOptions {
  config: EasyCodeConfig;
  mode: AgentMode;
  workspaceSummary?: string;
  memories?: string | readonly string[] | readonly LongTermMemory[];
  taskGraph?: Readonly<TaskGraph>;
  planReview?: Readonly<PlanReviewState>;
  now?: Date;
  cwd?: string;
  timeZone?: string;
  locale?: string;
  shell?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  /** Tools exposed for this model request. Omit to retain the legacy all-tools prompt. */
  availableTools?: readonly ToolName[];
  commandExecutionMode?: CommandExecutionMode;
}

const TOOL_RULE_ORDER: readonly ToolName[] = [
  "select_mode",
  "propose_plan",
  "read_file",
  "read_image",
  "create_file",
  "update_file",
  "delete_file",
  "run_command",
  "manage_tasks",
  "manage_subagents",
  "submit_task_result",
  "compact_context",
  "manage_memory",
];

const COMMAND_MODE_RESOURCE: Readonly<Record<CommandExecutionMode, string>> = {
  manual: "command-modes/manual.md",
  auto_approve: "command-modes/auto-approve.md",
  unrestricted: "command-modes/unrestricted.md",
};

/** Build the complete system prompt without including secrets from Provider config. */
export async function buildSystemPrompt(
  options: BuildSystemPromptOptions,
): Promise<string> {
  const catalog = loadPromptBundleCatalog();
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Prompt time is invalid");
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? os.arch();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspaceRoot = path.resolve(options.config.workspaceRoot);
  const locale = validLocale(
    options.locale ?? Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US",
  );
  const language = locale.split(/[-_]/)[0] || locale;
  const timeZone = validTimeZone(
    options.timeZone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC",
  );
  const shell = options.shell ?? resolveShell(env, platform);
  const localTime = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const timeZoneDisplay = new Intl.DateTimeFormat(locale, {
    timeZone,
    timeZoneName: "long",
  })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value;

  const instructions = await loadEasyCodeInstructions({
    configDir: options.config.configDir,
    workspaceRoot,
    cwd,
    platform,
  });
  const environment = renderPrompt(catalog, "system/environment.md", {
    localTime,
    timeZoneDisplay: timeZoneDisplay ? ` (${timeZoneDisplay})` : "",
    utcTime: now.toISOString(),
    timeZone,
    locale,
    language,
    platform,
    arch,
    shell,
    cwd,
    workspaceRoot,
    mode: options.mode,
    provider: options.config.provider,
    model: options.config[options.config.provider].model,
  });

  const sections = [
    promptText(catalog, "system/base.md"),
    promptText(catalog, "system/security.md"),
    formatModeRules(catalog, options.mode, options.availableTools),
    formatToolRules(catalog, options.availableTools),
    promptText(
      catalog,
      COMMAND_MODE_RESOURCE[options.commandExecutionMode ?? "manual"],
    ),
    environment,
  ];
  if (instructions.length) {
    sections.push(formatInstructions(catalog, instructions));
  }
  if (options.workspaceSummary?.trim()) {
    sections.push(
      untrustedBlock(
        catalog,
        "WORKSPACE_SUMMARY",
        bounded(catalog, options.workspaceSummary.trim(), 24_000),
      ),
    );
  }
  const memories = normalizeMemories(options.memories);
  if (memories) {
    sections.push(
      untrustedBlock(
        catalog,
        "RETRIEVED_MEMORY",
        bounded(catalog, memories, 16_000),
      ),
    );
  }
  // Keep Runtime control state last so ContextManager's head/tail fallback
  // preserves it preferentially when the system prompt itself must be bounded.
  if (options.taskGraph) {
    sections.push(formatTaskGraph(catalog, options.taskGraph));
  }
  if (options.planReview) {
    sections.push(formatPlanReview(catalog, options.planReview));
  }
  return sections.join("\n\n");
}

function formatModeRules(
  catalog: PromptBundleCatalog,
  mode: AgentMode,
  availableTools?: readonly ToolName[],
): string {
  if (availableTools === undefined) {
    return promptText(catalog, `modes/${mode}.md`);
  }
  const exposed = new Set(availableTools);
  if (mode === "plan") {
    return promptText(
      catalog,
      exposed.has("propose_plan")
        ? "modes/plan-readonly-with-proposal.md"
        : "modes/plan-readonly.md",
    );
  }
  if (mode === "auto" && !exposed.has("select_mode")) {
    return promptText(catalog, "modes/auto-effective.md");
  }
  return promptText(catalog, `modes/${mode}.md`);
}

function formatToolRules(
  catalog: PromptBundleCatalog,
  availableTools?: readonly ToolName[],
): string {
  const selected = availableTools === undefined
    ? TOOL_RULE_ORDER
    : TOOL_RULE_ORDER.filter((name) => availableTools.includes(name));
  return [
    promptText(catalog, "system/common-tools.md"),
    ...selected.map((name) => formatToolGuidance(catalog.getTool(name))),
  ].join("\n");
}

function formatToolGuidance(metadata: PromptToolMetadata): string {
  const rawEntries: readonly string[] = typeof metadata.guidance === "string"
    ? metadata.guidance.split(/\r\n|[\n\r\u2028\u2029]/u)
    : metadata.guidance;
  const entries = rawEntries
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.map((entry) => `- ${entry}`).join("\n");
}

function formatPlanReview(
  catalog: PromptBundleCatalog,
  review: Readonly<PlanReviewState>,
): string {
  const state = bounded(catalog, JSON.stringify(review, null, 2), 24_000);
  return renderPrompt(catalog, "runtime/plan-review.md", {
    state: untrustedBlock(catalog, "PLAN_REVIEW", state),
  });
}

function formatTaskGraph(
  catalog: PromptBundleCatalog,
  graph: Readonly<TaskGraph>,
): string {
  const state = bounded(
    catalog,
    JSON.stringify(taskGraphPromptView(graph), null, 2),
    48_000,
  );
  return renderPrompt(catalog, "runtime/task-dag.md", {
    state: untrustedBlock(catalog, "TASK_DAG", state),
  });
}

function formatInstructions(
  catalog: PromptBundleCatalog,
  instructions: readonly EasyCodeInstruction[],
): string {
  const blocks = instructions.map((instruction, index) =>
    renderPrompt(catalog, "runtime/project-guidance-layer.md", {
      index: index + 1,
      source: instruction.source,
      path: instruction.path,
      truncation: instruction.truncated
        ? promptText(catalog, "runtime/project-guidance-truncated-label.md")
        : "",
      content: prefixLines(instruction.content.trimEnd()),
    }),
  );
  return renderPrompt(catalog, "runtime/project-guidance.md", {
    layers: blocks.join("\n\n"),
  });
}

function prefixLines(value: string): string {
  return value
    .split(/\r\n|[\n\r\u2028\u2029]/u)
    .map((line) => `| ${line}`)
    .join("\n");
}

function normalizeMemories(
  value:
    | string
    | readonly string[]
    | readonly LongTermMemory[]
    | undefined,
): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        return (
          `[memory_id=${item.id}] [category=${item.category}] ` +
          `[status=${item.status}] [confidence=${item.confidence.toFixed(2)}] ` +
          item.content.trim()
        );
      })
      .filter(Boolean)
      .map((item) => `- ${item}`)
      .join("\n");
  }
  return typeof value === "string" ? value.trim() : "";
}

function untrustedBlock(
  catalog: PromptBundleCatalog,
  name: string,
  value: string,
): string {
  return renderPrompt(catalog, "runtime/untrusted-block.md", {
    name,
    content: prefixLines(value),
  });
}

function bounded(
  catalog: PromptBundleCatalog,
  value: string,
  limit: number,
): string {
  return value.length > limit
    ? `${value.slice(0, limit)}\n${promptText(catalog, "runtime/truncation-marker.md")}`
    : value;
}

function promptText(catalog: PromptBundleCatalog, relativePath: string): string {
  return catalog.readText(relativePath).trimEnd();
}

function renderPrompt(
  catalog: PromptBundleCatalog,
  relativePath: string,
  values: Readonly<Record<string, string | number | boolean>>,
): string {
  return catalog.render(relativePath, values).trimEnd();
}

function resolveShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const configured = env.EASY_CODE_SHELL?.trim();
  if (configured) return configured;
  if (platform === "win32") {
    return env.ComSpec?.trim() || env.COMSPEC?.trim() || "powershell.exe";
  }
  return env.SHELL?.trim() || "/bin/sh";
}

function validLocale(value: string): string {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([value])[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}

function validTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return value;
  } catch {
    return "UTC";
  }
}
