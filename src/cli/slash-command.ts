import { THINKING_EFFORTS, type ProviderName, type ThinkingEffort } from "../core/types.js";
import { PROVIDER_CATALOG } from "../models/catalog.js";
import type { Language } from "../i18n/language.js";

export interface SlashCommand {
  name: SlashCommandName;
  args: string[];
  rawArgs: string;
}

export const SLASH_COMMAND_NAMES = [
  "mode",
  "language",
  "provider",
  "model",
  "approval",
  "orchestration",
  "status",
  "workspace",
  "image",
  "tools",
  "skills",
  "mcp",
  "permissions",
  "context",
  "usage",
  "memory",
  "sessions",
  "resume",
  "new",
  "clear",
  "help",
  "exit",
] as const;

export type SlashCommandName = typeof SLASH_COMMAND_NAMES[number];

export interface SlashCommandCompletion {
  readonly replacement: string;
  readonly suffix: string;
}

const slashCommandNames = new Set<string>(SLASH_COMMAND_NAMES);

function canonicalSlashCommandName(value: string): SlashCommandName | undefined {
  const normalized = value.toLowerCase();
  if (slashCommandNames.has(normalized)) return normalized as SlashCommandName;
  return undefined;
}

export type ModelCommandRequest =
  | { action: "select" }
  | {
      action: "switch";
      provider?: ProviderName;
      model: string;
      thinkingEffort?: ThinkingEffort;
    };

function registeredProviders(): readonly ProviderName[] {
  // The registry is activated during CLI startup, after modules have been
  // evaluated. Resolve this live binding at command time rather than freezing
  // the packaged installation seed in a module-level constant.
  return PROVIDER_CATALOG.map(({ provider }) => provider);
}

function providerUsage(): string {
  return registeredProviders().join("|");
}

function modelCommandUsage(): string {
  return `Usage: /model | /model <model-id> | /model <${providerUsage()}> <model-id> [thinking-effort]`;
}

export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const separator = trimmed.search(/\s/u);
  const token = separator === -1 ? trimmed.slice(1) : trimmed.slice(1, separator);
  const name = canonicalSlashCommandName(token);
  if (!name) return null;
  const rawArgs = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  return {
    name,
    rawArgs,
    args: rawArgs ? rawArgs.split(/\s+/) : []
  };
}

/** Return presentation-only completion for a command-name prefix. */
export function completeSlashCommandPrefix(
  text: string,
  cursor: number,
): SlashCommandCompletion | undefined {
  if (cursor !== text.length) return undefined;
  const match = /^\/([a-z0-9_-]+)$/iu.exec(text);
  if (!match) return undefined;
  const prefix = match[1]!.toLowerCase();
  const candidate = SLASH_COMMAND_NAMES
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => name.startsWith(prefix) && name.length > prefix.length)
    .sort((left, right) =>
      (left.name.length - prefix.length) - (right.name.length - prefix.length) ||
      left.index - right.index
  )[0];
  if (!candidate) return undefined;
  const suffix = candidate.name.slice(prefix.length);
  return { replacement: `${text}${suffix}`, suffix };
}

/** Parse /model without conflating provider names with arbitrary model IDs. */
export function parseModelCommand(args: readonly string[]): ModelCommandRequest {
  if (args.length === 0) return { action: "select" };
  if (args.length > 3) throw new Error(modelCommandUsage());

  const first = args[0];
  if (!first) throw new Error(modelCommandUsage());
  const normalizedProvider = first.toLowerCase();
  const provider = registeredProviders().find((name) => name === normalizedProvider);

  if (args.length >= 2) {
    const model = args[1];
    if (!provider || !isModelId(model)) throw new Error(modelCommandUsage());
    const thinkingEffort = args[2];
    if (thinkingEffort && !(THINKING_EFFORTS as readonly string[]).includes(thinkingEffort))
      throw new Error(modelCommandUsage());
    return { action: "switch", provider, model,
      ...(thinkingEffort ? { thinkingEffort: thinkingEffort as ThinkingEffort } : {}) };
  }

  // A bare provider is intentionally rejected rather than being interpreted
  // as either a provider switch with an implicit model or a model ID.
  if (provider) throw new Error(modelCommandUsage());
  if (!isModelId(first)) throw new Error(modelCommandUsage());
  return { action: "switch", model: first };
}

function isModelId(value: string | undefined): value is string {
  return Boolean(
    value &&
    value.length <= 256 &&
    !/[\s\u0000-\u001f\u007f]/u.test(value),
  );
}

export function helpText(language: Language = "en_us"): string {
  const providers = providerUsage();
  if (language === "zh_cn") return `
EASY CODE 指令

  /mode plan|auto|code       切换工作模式
  /language [en_us|zh_cn]    查看或切换界面语言
  /provider ${providers}
                              切换模型供应商
  /model                     打开模型选择器
  /model <model>             切换当前供应商的模型
  /model ${providers} <id>
                              切换供应商和模型
  /model ${providers} <id> <effort>
                              同时切换思考强度
  /approval [manual|auto_approve|unrestricted]
                              选择手动批准、审批智能体或完全访问
  /orchestration [on|off]    控制 DAG 和子智能体；审查智能体保持开启
  /status                    查看当前状态
  /workspace                 查看项目工作文件夹
  /workspace refresh         刷新所有工作文件夹清单
  /workspace add <绝对路径>  向当前项目添加工作文件夹
  /workspace remove <folder-id>
                              从当前项目移除工作文件夹
  /workspace primary <folder-id>
                              设置主要工作文件夹
  /image <path|clipboard|clear>  添加图片或清空待发送图片
  /tools                     查看可用工具
  /skills                    查看全局和项目级技能
  /mcp [server-id action]    管理 MCP 服务器
  /permissions               查看权限与沙箱状态
  /context                   查看上下文预算
  /usage                     查看模型报告的 Token 用量
  /memory short [limit]      查看近期对话预览（默认 8 条，最多 500 条）
  /memory long [global|project] [id]
                              按范围或 ID 查看长期记忆（只读）
  /sessions                  列出历史对话
  /resume [id]               恢复对话
  /new                       新建对话
  /clear                     清空终端显示
  /help                      显示帮助
  /exit                      保存并退出
`;
  return `
EASY CODE commands

  /mode plan|auto|code       Switch working mode
  /language [en_us|zh_cn]    Show or change the interface language
  /provider ${providers}
                              Switch provider
  /model                     Open the provider and model selector
  /model <model>             Switch the current provider's model
  /model ${providers} <id>
                              Switch both provider and model
  /model ${providers} <id> <effort>
                              Switch provider, model and thinking effort
  /approval [manual|auto_approve|unrestricted]
                              Select user approval, independent approval agent, or full host access
  /orchestration [on|off]    Select DAG/subagent creation; reviewer stays enabled
  /status                    Show current status
  /workspace                 Show the project's workspace folders
  /workspace refresh         Refresh every attached folder inventory
  /workspace add <absolute-path>
                              Attach a workspace folder to this project
  /workspace remove <folder-id>
                              Detach a workspace folder from this project
  /workspace primary <folder-id>
                              Select the primary workspace folder
  /image <path>              Queue an image file for the next task
  /image clipboard           Queue the current clipboard image
  /image clear               Remove all queued, unsent images
  /tools                     Show available tools
  /skills                    Show global and project Skills
  /mcp                       Manage user MCP servers
  /mcp <server-id> <action>  Run an available MCP server action
  /permissions               Show command permissions and sandbox status
  /permissions revoke <index> Revoke a saved command/network prefix for this Thread
  /context                   Show context budget
  /usage                     Show cumulative provider-reported Token usage
  /memory short [limit]      Show recent short-term memory previews (default 8, max 500)
  /memory long [global|project] [id]  Show scoped long-term memory (read-only)
  /sessions                  List previous threads
  /resume [id]               Pick or resume a thread
  /new                       Start a new thread
  /clear                     Clear the screen
  /help                      Show help
  /exit                      Save and exit
`;
}
