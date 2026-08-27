import type { ProviderName } from "../core/types.js";

export interface SlashCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

export type ModelCommandRequest =
  | { action: "show" }
  | {
      action: "switch";
      provider?: ProviderName;
      model: string;
    };

const MODEL_COMMAND_USAGE =
  "Usage: /model | /model <model-id> | /model <qwen|deepseek> <model-id>";
const PROVIDERS: readonly ProviderName[] = ["qwen", "deepseek"];

export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const firstSpace = trimmed.indexOf(" ");
  const name = (firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)).toLowerCase();
  const rawArgs = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  return {
    name,
    rawArgs,
    args: rawArgs ? rawArgs.split(/\s+/) : []
  };
}

/** Parse /model without conflating provider names with arbitrary model IDs. */
export function parseModelCommand(args: readonly string[]): ModelCommandRequest {
  if (args.length === 0) return { action: "show" };
  if (args.length > 2) throw new Error(MODEL_COMMAND_USAGE);

  const first = args[0];
  if (!first) throw new Error(MODEL_COMMAND_USAGE);
  const normalizedProvider = first.toLowerCase();
  const provider = PROVIDERS.find((name) => name === normalizedProvider);

  if (args.length === 2) {
    const model = args[1];
    if (!provider || !isModelId(model)) throw new Error(MODEL_COMMAND_USAGE);
    return { action: "switch", provider, model };
  }

  // A bare provider is intentionally rejected rather than being interpreted
  // as either a provider switch with an implicit model or a model ID.
  if (provider) throw new Error(MODEL_COMMAND_USAGE);
  if (!isModelId(first)) throw new Error(MODEL_COMMAND_USAGE);
  return { action: "switch", model: first };
}

function isModelId(value: string | undefined): value is string {
  return Boolean(
    value &&
    value.length <= 256 &&
    !/[\s\u0000-\u001f\u007f]/u.test(value),
  );
}

export const HELP_TEXT = `
EASY CODE 命令

  /mode plan|auto|code       切换工作模式
  /provider qwen|deepseek    切换 Provider
  /model                     查看 Provider、模型和 Key 状态
  /model <model>             切换当前 Provider 的模型
  /model qwen|deepseek <id>  同时切换 Provider 和模型
  /status                    查看当前状态
  /workspace                 查看工作区摘要
  /workspace refresh         刷新工作区清单
  /changes                   查看本 Thread 的文件变化
  /tools                     查看当前工具
  /permissions               查看命令权限与沙箱状态
  /commands                  查看最近命令
  /context                   查看上下文预算
  /memory short              查看自动短期记忆
  /memory long               查看自动长期记忆
  /memory long <id>          查看一条长期记忆
  /sessions                  列出历史 Thread
  /resume <id>               恢复 Thread
  /new                       新建 Thread
  /clear                     清屏
  /help                      显示帮助
  /exit                      保存并退出
`;
