import type { ProviderName } from "../core/types.js";
import type { Language } from "../i18n/language.js";
import { PROVIDER_CATALOG, modelsForProvider, providerLabel } from "../models/catalog.js";
import { SLASH_COMMAND_NAMES, type SlashCommandName } from "./slash-command.js";

/** One argument value offered after a command name. */
export interface SlashArgument {
  readonly value: string;
  readonly description?: string;
  /** The argument must be followed by more input (a path, an ID), so Enter only fills it in. */
  readonly incomplete?: boolean;
}

/** Host-supplied arguments that depend on session data, such as resumable threads. */
export type SlashArgumentSource = (command: SlashCommandName) => readonly SlashArgument[] | undefined;

export interface SlashSuggestion {
  /** Text shown in the menu's first column. */
  readonly label: string;
  readonly description: string;
  /** The complete draft after accepting this suggestion. */
  readonly replacement: string;
  /** Enter runs the accepted draft; otherwise it only fills it in for further typing. */
  readonly submit: boolean;
  /** Caret position after accepting; the end of the draft when absent. */
  readonly cursor?: number;
}

export interface SlashSuggestionContext {
  readonly language: Language;
  /** The session's provider, whose models are offered after `/model`. */
  readonly provider?: ProviderName;
  readonly dynamicArguments?: SlashArgumentSource;
}

type Localized = Readonly<Record<Language, string>>;

interface CommandSpec {
  readonly description: Localized;
  /** The command does nothing useful without an argument. */
  readonly requiresArgument?: boolean;
  readonly arguments?: (context: SlashSuggestionContext) => readonly SlashArgument[];
}

function localized(language: Language, text: Localized): string {
  return text[language];
}

function staticArguments(values: readonly (readonly [string, Localized, "incomplete"?])[]) {
  return (context: SlashSuggestionContext): readonly SlashArgument[] =>
    values.map(([value, description, incomplete]) => ({
      value,
      description: localized(context.language, description),
      ...(incomplete ? { incomplete: true } : {}),
    }));
}

const COMMAND_NAME_SET: ReadonlySet<string> = new Set(SLASH_COMMAND_NAMES);

function isSlashCommandName(value: string): value is SlashCommandName {
  return COMMAND_NAME_SET.has(value);
}

const COMMANDS: Readonly<Record<SlashCommandName, CommandSpec>> = {
  mode: {
    description: { en_us: "Switch working mode", zh_cn: "切换工作模式" },
    requiresArgument: true,
    arguments: staticArguments([
      ["plan", { en_us: "Propose a plan before any change", zh_cn: "先给出计划，不改动文件" }],
      ["auto", { en_us: "Choose Plan or Code for each request", zh_cn: "每个请求自动选择 Plan 或 Code" }],
      ["code", { en_us: "Edit and run code directly", zh_cn: "直接修改和运行代码" }],
    ]),
  },
  language: {
    description: { en_us: "Show or change the interface language", zh_cn: "查看或切换界面语言" },
    arguments: staticArguments([
      ["en_us", { en_us: "English", zh_cn: "English" }],
      ["zh_cn", { en_us: "Simplified Chinese", zh_cn: "简体中文" }],
    ]),
  },
  provider: {
    description: { en_us: "Switch provider", zh_cn: "切换模型供应商" },
    requiresArgument: true,
    arguments: () =>
      PROVIDER_CATALOG.map(({ provider }) => ({ value: provider, description: providerLabel(provider) })),
  },
  model: {
    description: { en_us: "Pick a model, or switch to the given one", zh_cn: "选择模型，或直接切换到指定模型" },
    arguments: (context) =>
      context.provider
        ? modelsForProvider(context.provider).map((model) => ({ value: model.id, description: model.label }))
        : [],
  },
  approval: {
    description: { en_us: "Choose how commands are approved", zh_cn: "选择命令的批准方式" },
    arguments: staticArguments([
      ["manual", { en_us: "You approve each command", zh_cn: "每条命令由你批准" }],
      ["auto_approve", { en_us: "An approval agent decides", zh_cn: "由审批智能体决定" }],
      ["unrestricted", { en_us: "Full host access, no approval", zh_cn: "完全访问主机，不再审批" }],
    ]),
  },
  orchestration: {
    description: { en_us: "Turn task DAGs and subagents on or off", zh_cn: "开关任务 DAG 和子智能体" },
    arguments: staticArguments([
      ["on", { en_us: "Allow DAGs and subagents", zh_cn: "允许 DAG 和子智能体" }],
      ["off", { en_us: "Main agent only", zh_cn: "只用主智能体" }],
    ]),
  },
  status: { description: { en_us: "Show current status", zh_cn: "查看当前状态" } },
  workspace: {
    description: { en_us: "Show or change workspace folders", zh_cn: "查看或修改工作文件夹" },
    arguments: staticArguments([
      ["refresh", { en_us: "Refresh every folder inventory", zh_cn: "刷新所有文件夹清单" }],
      ["add", { en_us: "Attach a folder by absolute path", zh_cn: "按绝对路径添加文件夹" }, "incomplete"],
      ["remove", { en_us: "Detach a folder by ID", zh_cn: "按 ID 移除文件夹" }, "incomplete"],
      ["primary", { en_us: "Select the primary folder", zh_cn: "设置主要文件夹" }, "incomplete"],
    ]),
  },
  image: {
    description: { en_us: "Queue an image for the next task", zh_cn: "为下一个任务添加图片" },
    requiresArgument: true,
    arguments: staticArguments([
      ["clipboard", { en_us: "Queue the clipboard image", zh_cn: "添加剪贴板中的图片" }],
      ["clear", { en_us: "Remove all queued images", zh_cn: "清空待发送的图片" }],
    ]),
  },
  tools: { description: { en_us: "Show available tools", zh_cn: "查看可用工具" } },
  skills: { description: { en_us: "Show global and project Skills", zh_cn: "查看全局和项目级技能" } },
  mcp: { description: { en_us: "Manage MCP servers", zh_cn: "管理 MCP 服务器" } },
  permissions: {
    description: { en_us: "Show command permissions and sandbox status", zh_cn: "查看权限与沙箱状态" },
    arguments: staticArguments([
      ["revoke", { en_us: "Revoke a saved prefix by index", zh_cn: "按序号撤销已保存的前缀" }, "incomplete"],
    ]),
  },
  context: { description: { en_us: "Show context budget", zh_cn: "查看上下文预算" } },
  compact: { description: { en_us: "Deeply compact the conversation", zh_cn: "深度压缩当前会话上下文" } },
  usage: { description: { en_us: "Show provider-reported token usage", zh_cn: "查看模型报告的 Token 用量" } },
  memory: {
    description: { en_us: "Show short- or long-term memory", zh_cn: "查看短期或长期记忆" },
    requiresArgument: true,
    arguments: staticArguments([
      ["short", { en_us: "Recent conversation previews", zh_cn: "近期对话预览" }],
      ["long", { en_us: "Long-term memory (read-only)", zh_cn: "长期记忆（只读）" }],
    ]),
  },
  sessions: { description: { en_us: "List previous threads", zh_cn: "列出历史对话" } },
  resume: {
    description: { en_us: "Pick or resume a thread", zh_cn: "选择并恢复对话" },
    arguments: (context) => context.dynamicArguments?.("resume") ?? [],
  },
  new: { description: { en_us: "Start a new thread", zh_cn: "新建对话" } },
  clear: { description: { en_us: "Clear the screen", zh_cn: "清空终端显示" } },
  help: { description: { en_us: "Show help", zh_cn: "显示帮助" } },
  exit: { description: { en_us: "Save and exit", zh_cn: "保存并退出" } },
};

/** Most suggestions considered at once; the menu scrolls within them. */
export const MAX_SLASH_SUGGESTIONS = 50;

/**
 * Menu entries for a draft that is a slash command still being typed: command
 * names while the first word is incomplete, then the values of its first
 * argument. Anything else (multi-line text, a caret before the end, a second
 * argument) has no menu.
 */
export function slashSuggestions(
  text: string,
  cursor: number,
  context: SlashSuggestionContext,
): readonly SlashSuggestion[] {
  if (cursor !== text.length || !text.startsWith("/") || /[\r\n]/u.test(text)) return [];

  const commandMatch = /^\/([a-z0-9_-]*)$/iu.exec(text);
  if (commandMatch) {
    const prefix = commandMatch[1]!.toLowerCase();
    return SLASH_COMMAND_NAMES.filter((name) => name.startsWith(prefix)).map((name) => {
      const spec = COMMANDS[name];
      const takesArgument = spec.requiresArgument === true;
      return {
        label: `/${name}`,
        description: localized(context.language, spec.description),
        replacement: takesArgument ? `/${name} ` : `/${name}`,
        submit: !takesArgument,
      };
    });
  }

  const argumentMatch = /^\/([a-z0-9_-]+) (\S*)$/iu.exec(text);
  if (!argumentMatch) return [];
  const name = argumentMatch[1]!.toLowerCase();
  if (!isSlashCommandName(name)) return [];
  const spec = COMMANDS[name];
  if (!spec.arguments) return [];
  const prefix = argumentMatch[2]!.toLowerCase();
  return spec
    .arguments(context)
    .filter(({ value }) => value.toLowerCase().startsWith(prefix))
    .slice(0, MAX_SLASH_SUGGESTIONS)
    .map(({ value, description, incomplete }) => ({
      label: value,
      description: description ?? "",
      replacement: incomplete ? `/${name} ${value} ` : `/${name} ${value}`,
      submit: !incomplete,
    }));
}
