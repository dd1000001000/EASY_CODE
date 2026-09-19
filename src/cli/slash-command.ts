import type { ProviderName } from "../core/types.js";
import { PROVIDER_CATALOG } from "../models/catalog.js";

export interface SlashCommand {
  name: SlashCommandName;
  args: string[];
  rawArgs: string;
}

export const SLASH_COMMAND_NAMES = [
  "mode",
  "provider",
  "model",
  "approval",
  "orchestration",
  "status",
  "workspace",
  "image",
  "changes",
  "tasks",
  "agents",
  "tools",
  "mcp",
  "permissions",
  "commands",
  "context",
  "usage",
  "memory",
  "thinking",
  "adjustment",
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

const SLASH_COMMAND_ALIASES: Readonly<Record<string, SlashCommandName>> = {
  quit: "exit",
  subagents: "agents",
};

const slashCommandNames = new Set<string>(SLASH_COMMAND_NAMES);

function canonicalSlashCommandName(value: string): SlashCommandName | undefined {
  const normalized = value.toLowerCase();
  if (slashCommandNames.has(normalized)) return normalized as SlashCommandName;
  return SLASH_COMMAND_ALIASES[normalized];
}

export type ModelCommandRequest =
  | { action: "select" }
  | {
      action: "switch";
      provider?: ProviderName;
      model: string;
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
  return `Usage: /model | /model <model-id> | /model <${providerUsage()}> <model-id>`;
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
  if (args.length > 2) throw new Error(modelCommandUsage());

  const first = args[0];
  if (!first) throw new Error(modelCommandUsage());
  const normalizedProvider = first.toLowerCase();
  const provider = registeredProviders().find((name) => name === normalizedProvider);

  if (args.length === 2) {
    const model = args[1];
    if (!provider || !isModelId(model)) throw new Error(modelCommandUsage());
    return { action: "switch", provider, model };
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

export function helpText(): string {
  const providers = providerUsage();
  return `
EASY CODE commands

  /mode plan|auto|code       Switch working mode
  /provider ${providers}
                              Switch provider
  /model                     Open the provider and model selector
  /model <model>             Switch the current provider's model
  /model ${providers} <id>
                              Switch both provider and model
  /approval                 Select user approval, independent approval agent, or full host access
  /orchestration [on|off]    Select DAG/subagent creation; reviewer stays enabled
  /status                    Show current status
  /workspace                 Show workspace summary
  /workspace refresh         Refresh the workspace inventory
  /image <path>              Queue an image file for the next task
  /image clipboard           Queue the current clipboard image
  /image clear               Remove all queued, unsent images
  /changes                   Show file changes in this thread
  /tasks                     Show the current model-managed task DAG
  /agents                    Show child sessions, tasks, isolation, and handoff
  /tools                     Show available tools
  /mcp                       Manage user MCP servers
  /permissions               Show command permissions and sandbox status
  /permissions revoke <index> Revoke a saved command/network prefix for this Thread
  /commands                  Show recent commands
  /context                   Show context budget
  /usage                     Show cumulative provider-reported Token usage
  /memory short [limit]      Show recent short-term memory previews (default 8, max 500)
  /memory long               Show automatic long-term memory
  /memory long <id>          Show one long-term memory entry
  /thinking [id|last]        Show the expanded model thinking
  /adjustment [id|last]      Show one retained queued adjustment
  /sessions                  List previous threads
  /resume [id]               Pick or resume a thread
  /new                       Start a new thread
  /clear                     Clear the screen
  /help                      Show help
  /exit                      Save and exit
`;
}
