import type { TerminalChoice } from "../cli/terminal.js";
import type { McpServerConfig } from "./config.js";

export interface McpMenuState {
  readonly connected: boolean;
  readonly authenticated: boolean;
  readonly authStoreReady: boolean;
  readonly bearerReady: boolean;
  readonly benchmark: boolean;
}

/** Presentation only: execution still rechecks approval and credentials. */
export function mcpServerActions(server: McpServerConfig, state: McpMenuState): TerminalChoice[] {
  const choices: TerminalChoice[] = [
    { id: "details", label: "Show configuration", detail: "Credentials are never shown" },
  ];
  if (state.connected) {
    choices.push({ id: "disconnect", label: "Disconnect", detail: server.transport === "stdio"
      ? "Stop the local MCP server" : "Close the remote MCP connection" });
  } else {
    const needsOAuth = server.transport !== "stdio" && server.auth === "oauth";
    const needsBearer = server.transport !== "stdio" && server.auth === "bearer";
    if (!state.benchmark && (!needsOAuth || (state.authStoreReady && state.authenticated)) &&
        (!needsBearer || state.bearerReady)) {
      choices.push({ id: "connect", label: "Connect", detail: server.transport === "stdio"
        ? "Runs inside the workspace OS sandbox after approval" : "Connects to the approved remote URL" });
    }
    if (needsOAuth && state.authStoreReady && !state.benchmark) {
      choices.push({ id: "authenticate", label: state.authenticated ? "Reauthenticate" : "Authenticate",
        detail: "Sign in through the remote server's OAuth flow" });
      if (state.authenticated) choices.push({ id: "clear_auth", label: "Clear authentication",
        detail: "Remove this server's saved OAuth tokens" });
    }
  }
  if (server.enabled) choices.push({ id: "disable", label: "Disable", detail: "Prevent future use" });
  choices.push({ id: "remove", label: "Remove", detail: "Delete this server from the user configuration" },
    { id: "back", label: "Back" });
  return choices;
}
