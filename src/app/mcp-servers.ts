/** /mcp management for the interactive app: server menu, connection lifecycle and OAuth-authenticated connects. */

import type { AppInteractionPort } from "../ui/interaction-port.js";
import { McpConfigStore, type RemoteMcpServerConfig } from "../mcp/config.js";
import { McpConnections } from "../mcp/source.js";
import { authorizeMcpServer, McpOauthCredentials, storedMcpOauthProvider } from "../mcp/oauth.js";
import { mcpServerActions } from "../mcp/menu.js";
import { openAuthorizationUrl } from "../mcp/open-authorization.js";
import { CommandResolver } from "../command/resolver.js";
import { CommandRuntime } from "../command/runtime.js";
import type { EasyCodeConfig } from "../core/types.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { json } from "./text.js";

/** What McpServerController needs from its host; live values are forwarded through getters. */
export interface McpServerControllerContext {
  readonly config: EasyCodeConfig;
  readonly createCommandRuntime: (workspace: WorkspaceManager) => CommandRuntime;
  readonly handleSlashCommand: (input: string) => Promise<boolean>;
  readonly mcpConfigStore: McpConfigStore;
  mcpConnections: McpConnections | undefined;
  readonly terminal: AppInteractionPort;
  readonly trustedOuterSandbox: "harbor" | undefined;
  readonly workspace: WorkspaceManager;
}

export class McpServerController {
  constructor(private readonly ctx: McpServerControllerContext) {}

  async showMcpServers(requested?: { serverId: string; action: string }): Promise<void> {
    for (;;) {
      const config = await this.ctx.mcpConfigStore.read();
      const servers = Object.entries(config.servers).sort(([left], [right]) => left.localeCompare(right));
      if (servers.length === 0) {
        if (requested) throw new Error(`MCP server ${requested.serverId} is not configured.`);
        this.ctx.terminal.info(
          `User MCPs (${this.ctx.mcpConfigStore.filePath}): none configured. Ask the agent to add a server.`,
        );
        return;
      }
      const selected =
        requested?.serverId ??
        (await this.ctx.terminal.selectChoice(
          `User MCPs (${this.ctx.mcpConfigStore.filePath})`,
          servers.map(([id, server]) => ({
            id,
            label: id,
            detail: this.mcp().status(id).connected
              ? `✓ connected · ${this.mcp().status(id).toolCount} tool(s) · ${server.transport}`
              : `${server.enabled ? "enabled · disconnected" : "disabled"} · ${server.transport}`,
          })),
        ));
      if (!selected) return;
      const server = config.servers[selected];
      if (!server) {
        if (requested) throw new Error(`MCP server ${selected} is not configured.`);
        continue;
      }
      let authenticated = false;
      let authStoreReady = true;
      if (server.transport !== "stdio" && server.auth === "oauth") {
        try {
          authenticated = await new McpOauthCredentials(selected, server.url, this.ctx.config.dataDir).hasTokens();
        } catch (error) {
          authStoreReady = false;
          this.ctx.terminal.warning(
            `MCP OAuth credential store is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const connected = this.mcp().status(selected).connected;
      const bearerReady =
        server.transport === "stdio" || server.auth !== "bearer" || Boolean(process.env[server.bearerTokenEnvVar!]);
      if (!bearerReady) {
        this.ctx.terminal.warning(`Set ${server.bearerTokenEnvVar} in EASY CODE's environment before connecting.`);
      }
      const availableActions = mcpServerActions(server, {
        connected,
        authenticated,
        bearerReady,
        authStoreReady,
        benchmark: this.ctx.trustedOuterSandbox === "harbor",
      });
      const action =
        requested?.action ?? (await this.ctx.terminal.selectChoice(`MCP server: ${selected}`, availableActions));
      if (!action || action === "back") {
        if (requested) return;
        continue;
      }
      if (!availableActions.some((choice) => choice.id === action && !choice.disabled))
        throw new Error(`MCP action ${action} is not available for ${selected}.`);
      if (!requested) {
        await this.ctx.handleSlashCommand(`/mcp ${selected} ${action}`);
        return;
      }
      if (action === "details") {
        this.ctx.terminal.write(
          `${json(
            server.transport === "stdio"
              ? {
                  id: selected,
                  transport: server.transport,
                  command: server.command,
                  args: server.args,
                  cwd: server.cwd,
                  env: Object.fromEntries(
                    Object.entries(server.env).map(([name, value]) => [
                      name,
                      "value" in value ? "literal" : `env:${value.fromEnv}`,
                    ]),
                  ),
                  executableApproved: Boolean(server.executableHash),
                  enabled: server.enabled,
                }
              : {
                  id: selected,
                  transport: server.transport,
                  url: server.url,
                  auth: server.auth,
                  bearerTokenEnvVar: server.bearerTokenEnvVar,
                  headers: Object.fromEntries(
                    Object.entries(server.headers).map(([name, value]) => [
                      name,
                      "value" in value ? "literal" : `env:${value.fromEnv}`,
                    ]),
                  ),
                  query: Object.fromEntries(
                    Object.entries(server.query).map(([name, value]) => [
                      name,
                      "value" in value ? "literal" : `env:${value.fromEnv}`,
                    ]),
                  ),
                  enabled: server.enabled,
                },
          )}\n`,
        );
        return;
      } else if (action === "authenticate" && server.transport !== "stdio" && server.auth === "oauth") {
        this.ctx.terminal.info("Waiting for MCP authorization (up to 6 minutes). Press Ctrl+C to cancel.");
        try {
          await this.ctx.terminal.withCancellableExternalOperation((signal) =>
            authorizeMcpServer(
              selected,
              server.url,
              async (url) => {
                this.ctx.terminal.write(`MCP sign-in URL: ${url}\n`);
                try {
                  await openAuthorizationUrl(url);
                  this.ctx.terminal.info("Asked the system to open the authorization link with its default handler.");
                } catch (error) {
                  this.ctx.terminal.warning(
                    `Could not open the authorization link automatically: ${error instanceof Error ? error.message : String(error)}. Open the URL above manually.`,
                  );
                }
              },
              new McpOauthCredentials(selected, server.url, this.ctx.config.dataDir),
              signal,
            ),
          );
          this.ctx.terminal.success(`MCP server ${selected} authenticated.`);
        } catch (error) {
          this.ctx.terminal.warning(
            `MCP authorization did not complete: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        try {
          const toolCount = await this.connectAuthenticatedMcpServer(selected, server);
          this.ctx.terminal.success(`MCP server ${selected} connected with ${toolCount} tool(s).`);
        } catch (error) {
          this.ctx.terminal.warning(
            `MCP server ${selected} was authenticated but could not connect: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      } else if (action === "clear_auth" && server.transport !== "stdio" && server.auth === "oauth") {
        await this.mcp().disconnect(selected);
        await new McpOauthCredentials(selected, server.url, this.ctx.config.dataDir).clear();
        this.ctx.terminal.success(`MCP server ${selected} authentication cleared.`);
        return;
      } else if (action === "connect") {
        if (this.ctx.trustedOuterSandbox === "harbor") {
          this.ctx.terminal.warning("MCP servers are not available inside benchmark tasks.");
          return;
        }
        let toolCount: number;
        let approvedExecutableHash: string | undefined;
        if (server.transport === "stdio") {
          this.ctx.createCommandRuntime(this.ctx.workspace).assertEnvironmentSafe();
          const resolved = await new CommandResolver(this.ctx.workspace).resolve({
            program: server.command,
            args: server.args,
            cwd: server.cwd,
            intent: "run",
          });
          this.ctx.terminal.write(
            `${json({
              executable: resolved.executablePath,
              args: resolved.args,
              cwd: resolved.cwdAbsolute,
              executableSha256: resolved.executableHash,
              environmentReferences: server.env,
              network: "denied",
            })}\n`,
          );
          const approved = await this.ctx.terminal.selectChoice(
            `Run MCP server ${selected} inside the workspace sandbox?`,
            [
              { id: "cancel", label: "Cancel" },
              {
                id: "run",
                label: "Approve and connect",
                detail:
                  `${resolved.executablePath} ${resolved.args.join(" ")} · cwd=${resolved.cwdAbsolute} · sha256=${resolved.executableHash?.slice(0, 12)}`.slice(
                    0,
                    400,
                  ),
              },
            ],
            "cancel",
          );
          if (approved !== "run") return;
          approvedExecutableHash = resolved.executableHash;
          toolCount = await this.mcp().connect(selected, server, approvedExecutableHash);
        } else {
          if (
            server.auth === "oauth" &&
            !(await new McpOauthCredentials(selected, server.url, this.ctx.config.dataDir).hasTokens())
          ) {
            this.ctx.terminal.warning("Authenticate this MCP server before connecting.");
            return;
          }
          const approved = await this.ctx.terminal.selectChoice(
            `Connect to remote MCP server ${selected}?`,
            [
              { id: "cancel", label: "Cancel" },
              { id: "connect", label: "Approve connection", detail: `${server.url} · ${server.auth}` },
            ],
            "cancel",
          );
          if (approved !== "connect") return;
          toolCount = await this.mcp().connect(
            selected,
            server,
            undefined,
            server.auth === "oauth" ? storedMcpOauthProvider(selected, server.url, this.ctx.config.dataDir) : undefined,
          );
        }
        await this.ctx.mcpConfigStore.setEnabled(selected, true, approvedExecutableHash);
        this.ctx.terminal.success(`MCP server ${selected} connected with ${toolCount} tool(s).`);
        return;
      } else if (action === "disconnect") {
        await this.mcp().disconnect(selected);
        this.ctx.terminal.info(`Disconnected MCP server ${selected}.`);
        return;
      } else if (action === "disable") {
        await this.mcp().disconnect(selected);
        await this.ctx.mcpConfigStore.setEnabled(selected, false);
        this.ctx.terminal.success(`Disabled MCP server ${selected}.`);
        return;
      } else if (action === "remove") {
        const confirmed = await this.ctx.terminal.selectChoice(
          `Remove MCP server ${selected}?`,
          [
            { id: "cancel", label: "Cancel" },
            { id: "remove", label: "Remove configuration" },
          ],
          "cancel",
        );
        if (confirmed === "remove") {
          await this.mcp().disconnect(selected);
          if (server.transport !== "stdio" && server.auth === "oauth") {
            await new McpOauthCredentials(selected, server.url, this.ctx.config.dataDir).clear();
          }
          await this.ctx.mcpConfigStore.remove(selected);
          this.ctx.terminal.success(`Removed MCP server ${selected}.`);
        }
        return;
      }
    }
  }

  async connectAuthenticatedMcpServer(id: string, server: RemoteMcpServerConfig): Promise<number> {
    const toolCount = await this.mcp().connect(
      id,
      server,
      undefined,
      storedMcpOauthProvider(id, server.url, this.ctx.config.dataDir),
    );
    try {
      await this.ctx.mcpConfigStore.setEnabled(id, true);
    } catch (error) {
      await this.mcp().disconnect(id);
      throw error;
    }
    return toolCount;
  }

  mcp(): McpConnections {
    this.ctx.mcpConnections ??= new McpConnections(
      this.ctx.workspace,
      this.ctx.config.dataDir,
      this.ctx.config.limits,
      {
        onCatalogChanged: () => undefined,
        onReconnectError: (serverId, error) =>
          this.ctx.terminal.warning(
            `MCP server ${serverId} reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      },
    );
    return this.ctx.mcpConnections;
  }

  async connectEnabledMcpServers(): Promise<void> {
    const config = await this.ctx.mcpConfigStore.read();
    await Promise.all(
      Object.entries(config.servers)
        .filter(([, server]) => server.enabled)
        .map(async ([id, server]) => {
          if (this.mcp().status(id).connected) return;
          try {
            if (server.transport === "stdio") {
              if (!server.executableHash) throw new Error("the approved executable identity is missing");
              await this.mcp().connect(id, server, server.executableHash);
            } else {
              const authProvider =
                server.auth === "oauth" ? storedMcpOauthProvider(id, server.url, this.ctx.config.dataDir) : undefined;
              await this.mcp().connect(id, server, undefined, authProvider);
            }
          } catch (error) {
            this.ctx.terminal.warning(
              `Enabled MCP server ${id} could not connect: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }),
    );
  }
}
