import { SSEClientTransport, StreamableHTTPClientTransport,
  type AuthProvider, type OAuthClientProvider, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import { resolveMcpSetting, type RemoteMcpServerConfig } from "./config.js";

/** Transport lifecycle is uniform with the sandboxed stdio adapter. */
export class RemoteMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onDisconnected?: () => void;
  private readonly inner: SSEClientTransport | StreamableHTTPClientTransport;
  private active = false;
  private closed = false;

  get isActive(): boolean { return this.active && !this.closed; }

  constructor(config: RemoteMcpServerConfig, authProvider?: AuthProvider | OAuthClientProvider) {
    const url = new URL(config.url);
    for (const [name, value] of Object.entries(config.query)) {
      url.searchParams.set(name, resolveMcpSetting(value, `query parameter ${name}`));
    }
    const configuredHeaders = Object.fromEntries(Object.entries(config.headers).map(([name, value]) =>
      [name, resolveMcpSetting(value, `header ${name}`)]));
    const provider = authProvider ?? (config.auth === "bearer" ? {
      async token() {
        const value = process.env[config.bearerTokenEnvVar!];
        if (!value) throw new Error(`MCP bearer environment variable ${config.bearerTokenEnvVar} is missing`);
        return value;
      },
    } satisfies AuthProvider : undefined);
    const options = { authProvider: provider, requestInit: { redirect: "error" as const, headers: configuredHeaders },
      eventSourceInit: { fetch: (target: string | URL, init?: RequestInit) => {
        const headers: Record<string, string> = { ...configuredHeaders };
        new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
        return fetch(target, { ...init, headers, redirect: "error" });
      } } };
    this.inner = config.transport === "sse"
      ? new SSEClientTransport(url, options)
      : new StreamableHTTPClientTransport(url, options);
  }

  async start(): Promise<void> {
    if (this.closed || this.active) throw new Error("MCP transport cannot be restarted");
    this.inner.onmessage = message => this.onmessage?.(message);
    this.inner.onerror = error => this.onerror?.(error);
    this.inner.onclose = () => {
      this.active = false;
      this.onclose?.();
      this.onDisconnected?.();
    };
    await this.inner.start();
    this.active = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.isActive) throw new Error("MCP server is not connected");
    await this.inner.send(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.active = false;
    await this.inner.close();
  }
}
