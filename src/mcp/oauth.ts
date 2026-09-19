import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";

type KeyringModule = typeof import("@napi-rs/keyring");
const require = createRequire(import.meta.url);

export interface SavedCredentials {
  issuer?: string;
  redirectUrl?: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
}

export interface McpOauthCredentialStore {
  read(): Promise<SavedCredentials>;
  update(change: (saved: SavedCredentials) => void): Promise<void>;
  clear(): Promise<void>;
  hasTokens(): Promise<boolean>;
}

/** OAuth credentials are kept in the OS keyring, never in mcp.toml or a thread. */
export class McpOauthCredentials implements McpOauthCredentialStore {
  private readonly account: string;
  constructor(serverId: string, url: string) {
    this.account = `mcp:${serverId}:${createHash("sha256").update(url).digest("hex")}`;
  }
  private entry() {
    const { AsyncEntry } = require("@napi-rs/keyring") as KeyringModule;
    return new AsyncEntry("easy-code-agent", this.account);
  }
  async read(): Promise<SavedCredentials> {
    const value = await this.entry().getPassword();
    if (!value) return {};
    return JSON.parse(value) as SavedCredentials;
  }
  async update(change: (saved: SavedCredentials) => void): Promise<void> {
    const saved = await this.read();
    change(saved);
    await this.entry().setPassword(JSON.stringify(saved));
  }
  async clear(): Promise<void> { await this.entry().deleteCredential(); }
  async hasTokens(): Promise<boolean> { return Boolean((await this.read()).tokens?.access_token); }
}

class InteractiveOAuthProvider implements OAuthClientProvider {
  private verifier = "";
  private discovery?: OAuthDiscoveryState;
  private readonly expectedState = randomBytes(24).toString("hex");
  private authorizationUrl?: URL;
  private pendingClient?: StoredOAuthClientInformation;
  private pendingTokens?: StoredOAuthTokens;
  private pendingIssuer?: string;
  constructor(readonly redirectUrl: string, private readonly credentials: McpOauthCredentialStore,
    private readonly announce: (url: string) => void | Promise<void>) {}

  get clientMetadata() {
    return { client_name: "EASY CODE", redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none" };
  }
  state(): string { return this.expectedState; }
  async clientInformation(ctx?: { issuer: string }) {
    if (this.pendingClient) return this.pendingClient;
    const saved = await this.credentials.read();
    if (ctx && saved.issuer && saved.issuer !== ctx.issuer) return undefined;
    // Each attempt has a newly bound loopback port. A client registered for an
    // earlier redirect URI cannot safely be reused for this authorization.
    return saved.redirectUrl === this.redirectUrl ? saved.client : undefined;
  }
  async saveClientInformation(value: StoredOAuthClientInformation, ctx?: { issuer: string }) {
    this.pendingClient = value;
    this.pendingIssuer = ctx?.issuer;
  }
  async tokens(ctx?: { issuer: string }) {
    if (this.pendingTokens) return this.pendingTokens;
    const saved = await this.credentials.read();
    return !ctx || !saved.issuer || saved.issuer === ctx.issuer ? saved.tokens : undefined;
  }
  async saveTokens(value: StoredOAuthTokens, ctx?: { issuer: string }) {
    this.pendingTokens = value;
    this.pendingIssuer = ctx?.issuer ?? this.pendingIssuer;
  }
  async commit(): Promise<void> {
    if (!this.pendingClient && !this.pendingTokens) return;
    await this.credentials.update(saved => {
      if (this.pendingClient) {
        saved.client = this.pendingClient;
        saved.redirectUrl = this.redirectUrl;
      }
      if (this.pendingTokens) saved.tokens = this.pendingTokens;
      if (this.pendingIssuer) saved.issuer = this.pendingIssuer;
    });
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    if (url.protocol !== "https:" && !(url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new Error("MCP OAuth authorization URL must use HTTPS or loopback HTTP");
    }
    if (url.username || url.password || url.hash) {
      throw new Error("MCP OAuth authorization URL must not contain credentials or fragments");
    }
    this.authorizationUrl = url;
    await this.announce(url.toString());
  }
  saveCodeVerifier(value: string): void { this.verifier = value; }
  codeVerifier(): string { return this.verifier; }
  saveDiscoveryState(value: OAuthDiscoveryState): void { this.discovery = value; }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }
  assertState(value: string | null): void {
    if (!value || value !== this.expectedState) throw new Error("MCP OAuth state did not match");
  }
  get redirected(): boolean { return Boolean(this.authorizationUrl); }
}

const OAUTH_TIMEOUT_MS = 360_000;

function aborted(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("MCP OAuth authorization canceled");
  error.name = "AbortError";
  return error;
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw aborted(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      onAbort = () => reject(aborted(signal));
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Explicit /mcp login: local callback, SDK discovery/PKCE/exchange, keyring persistence. */
export async function authorizeMcpServer(serverId: string, url: string,
  announce: (url: string) => void | Promise<void>,
  credentials: McpOauthCredentialStore = new McpOauthCredentials(serverId, url),
  signal?: AbortSignal,
  timeoutMs = OAUTH_TIMEOUT_MS): Promise<void> {
  const controller = new AbortController();
  const onCancel = () => controller.abort(signal ? aborted(signal) : undefined);
  signal?.addEventListener("abort", onCancel, { once: true });
  if (signal?.aborted) onCancel();
  const timeout = setTimeout(() => {
    const error = new Error(`MCP OAuth authorization timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  const flowSignal = controller.signal;
  const fetchFn: typeof fetch = (input, init) => fetch(input, { ...init, signal: flowSignal, redirect: "error" });
  let callback: (params: URLSearchParams) => void = () => undefined;
  const callbackPromise = new Promise<URLSearchParams>(resolve => { callback = resolve; });
  const path = `/mcp/callback/${randomBytes(16).toString("hex")}`;
  let provider: InteractiveOAuthProvider | undefined;
  const server: Server = createServer((request, response) => {
    const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
    if (incoming.pathname !== path || request.method !== "GET") {
      response.writeHead(404).end(); return;
    }
    if (!provider) { response.writeHead(400).end("MCP authorization is not ready."); return; }
    let validState = true;
    try { provider.assertState(incoming.searchParams.get("state")); }
    catch { validState = false; }
    const success = validState && !incoming.searchParams.has("error") && incoming.searchParams.has("code");
    response.writeHead(success ? 200 : 400,
      { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end(success
      ? "EASY CODE MCP authorization received. You may close this tab."
      : "EASY CODE MCP authorization was not completed. Return to the terminal.");
    callback(incoming.searchParams);
  });
  try {
    await withAbort(new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    }), flowSignal);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP OAuth callback did not bind");
    provider = new InteractiveOAuthProvider(`http://127.0.0.1:${address.port}${path}`, credentials, async link => {
      if (flowSignal.aborted) throw aborted(flowSignal);
      await announce(link);
      if (flowSignal.aborted) throw aborted(flowSignal);
    });
    const result = await withAbort(auth(provider, { serverUrl: url, fetchFn,
      forceReauthorization: true }), flowSignal);
    if (result === "AUTHORIZED") { await provider.commit(); return; }
    if (!provider.redirected) throw new Error("MCP OAuth server did not supply an authorization URL");
    const params = await withAbort(callbackPromise, flowSignal);
    provider.assertState(params.get("state"));
    const authorizationError = params.get("error");
    if (authorizationError) throw new Error(`MCP OAuth authorization was declined: ${authorizationError}`);
    const code = params.get("code");
    if (!code) throw new Error("MCP OAuth callback did not include an authorization code");
    const completed = await withAbort(auth(provider, { serverUrl: url, authorizationCode: code,
      iss: params.get("iss") ?? undefined, fetchFn }), flowSignal);
    if (completed !== "AUTHORIZED") throw new Error("MCP OAuth token exchange did not complete");
    await provider.commit();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onCancel);
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}

export function storedMcpOauthProvider(serverId: string, url: string): OAuthClientProvider {
  const credentials = new McpOauthCredentials(serverId, url);
  return {
    redirectUrl: undefined,
    clientMetadata: { client_name: "EASY CODE", redirect_uris: [], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none" },
    clientInformation: ctx => credentials.read().then(saved => !ctx || !saved.issuer || saved.issuer === ctx.issuer ? saved.client : undefined),
    tokens: ctx => credentials.read().then(saved => !ctx || !saved.issuer || saved.issuer === ctx.issuer ? saved.tokens : undefined),
    saveTokens: (tokens, ctx) => credentials.update(saved => { saved.tokens = tokens; saved.issuer = ctx?.issuer ?? saved.issuer; }),
    redirectToAuthorization: () => { throw new Error("MCP OAuth sign-in required; use /mcp Authenticate"); },
    saveCodeVerifier: () => undefined,
    codeVerifier: () => { throw new Error("MCP OAuth sign-in required; use /mcp Authenticate"); },
  };
}
