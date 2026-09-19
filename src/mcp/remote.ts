import { SSEClientTransport, StreamableHTTPClientTransport,
  type AuthProvider, type OAuthClientProvider, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import type { RemoteMcpServerConfig } from "./config.js";

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
    const provider = authProvider ?? (config.auth === "bearer" ? {
      async token() {
        const value = process.env[config.bearerTokenEnvVar!];
        if (!value) throw new Error(`MCP bearer environment variable ${config.bearerTokenEnvVar} is missing`);
        return value;
      },
    } satisfies AuthProvider : undefined);
    const options = { authProvider: provider, requestInit: { redirect: "error" as const },
      eventSourceInit: { fetch: (target: string | URL, init?: RequestInit) =>
        fetch(target, { ...init, redirect: "error" }) } };
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
