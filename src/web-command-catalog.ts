import type { SlashCommandName } from "./cli/slash-command.js";

export interface WebCommandEntry {
  readonly name: SlashCommandName;
  readonly description: string;
}

/** Browser command descriptions; availability is still derived from the CLI parser. */
export const WEB_COMMAND_DESCRIPTIONS: Partial<Record<SlashCommandName, string>> = {
  mode: "Switch between Plan, Auto, and Code modes.",
  status: "Inspect the current conversation and runtime state.",
  tools: "Browse the tools available to the agent.",
  skills: "Browse user and project skills.",
  mcp: "Manage connected MCP servers and authorization.",
  permissions: "Inspect sandbox permissions and revoke saved grants.",
  context: "Inspect the context window and compaction budget.",
  usage: "Review provider-reported token usage.",
  memory: "Inspect short-term and scoped long-term memory.",
  help: "Browse available commands and their syntax.",
};
