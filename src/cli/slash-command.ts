import { THINKING_EFFORTS, type ProviderName, type ThinkingEffort } from "../core/types.js";
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
  /model ${providers} <id> <effort>
                              Switch provider, model and thinking effort
  /approval [manual|auto_approve|unrestricted]
                              Select user approval, independent approval agent, or full host access
  /orchestration [on|off]    Select DAG/subagent creation; reviewer stays enabled
  /status                    Show current status
  /workspace                 Show workspace summary
  /workspace refresh         Refresh the workspace inventory
  /image <path>              Queue an image file for the next task
  /image clipboard           Queue the current clipboard image
  /image clear               Remove all queued, unsent images
  /tools                     Show available tools
  /skills                    Show user and project Skills
  /mcp                       Manage user MCP servers
  /mcp <server-id> <action>  Run an available MCP server action
  /permissions               Show command permissions and sandbox status
  /permissions revoke <index> Revoke a saved command/network prefix for this Thread
  /context                   Show context budget
  /usage                     Show cumulative provider-reported Token usage
  /memory short [limit]      Show recent short-term memory previews (default 8, max 500)
  /memory long [global|project] [id]  Show scoped long-term memory
  /memory move <id> <global|project>  Move one memory between scopes
  /memory forget <id>        Expire one long-term memory
  /sessions                  List previous threads
  /resume [id]               Pick or resume a thread
  /new                       Start a new thread
  /clear                     Clear the screen
  /help                      Show help
  /exit                      Save and exit
`;
}
