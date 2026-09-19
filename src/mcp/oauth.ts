import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { resolveEasyCodePaths } from "../config/defaults.js";
import { assertPlainAncestors, recordOwnedResource } from "../install/ownership.js";

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

interface SecretEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(value: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export type McpKeyringEntryFactory = (account: string) => SecretEntry;

function systemEntry(account: string): SecretEntry {
  const { AsyncEntry } = require("@napi-rs/keyring") as KeyringModule;
  return new AsyncEntry("easy-code-agent", account);
}

interface EncryptedCredentialFile {
  version: 1;
  nonce: string;
  tag: string;
  ciphertext: string;
}

/** A short key stays in the OS keyring; variable-length OAuth data is encrypted on disk. */
export class McpOauthCredentials implements McpOauthCredentialStore {
  private readonly legacyAccount: string;
  private readonly keyAccount: string;
  private readonly filePath: string;
  private readonly associatedData: Buffer;

  constructor(serverId: string, url: string,
    dataDir = resolveEasyCodePaths().dataDir,
    private readonly entryFactory: McpKeyringEntryFactory = systemEntry) {
    const identity = createHash("sha256").update(`${serverId}\0${url}`).digest("hex");
    this.legacyAccount = `mcp:${serverId}:${createHash("sha256").update(url).digest("hex")}`;
    this.keyAccount = `mcp-oauth-${identity.slice(0, 32)}.key`;
    this.filePath = path.join(dataDir, "mcp-oauth", `${identity}.json.enc`);
    this.associatedData = Buffer.from(`${serverId}\0${url}`, "utf8");
  }

  private async key(create: boolean): Promise<Buffer | undefined> {
    const entry = this.entryFactory(this.keyAccount);
    let encoded = await entry.getPassword();
    if (!encoded && create) {
      encoded = randomBytes(32).toString("base64");
      await entry.setPassword(encoded);
    }
    // Retry ownership registration if a prior process saved the short key but
    // exited before recording the uninstall receipt.
    if (encoded && create && this.entryFactory === systemEntry) {
      recordOwnedResource({ kind: "credential", name: this.keyAccount });
    }
    if (!encoded) return undefined;
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded) {
      throw new Error("MCP OAuth encryption key is invalid");
    }
    return key;
  }

  async read(): Promise<SavedCredentials> {
    assertPlainAncestors(this.filePath);
    let value: string;
    try { value = await readFile(this.filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const legacy = await this.entryFactory(this.legacyAccount).getPassword();
      return legacy ? JSON.parse(legacy) as SavedCredentials : {};
    }
    const key = await this.key(false);
    if (!key) throw new Error("MCP OAuth encryption key is missing");
    const envelope = JSON.parse(value) as Partial<EncryptedCredentialFile>;
    if (envelope.version !== 1 || typeof envelope.nonce !== "string" ||
        typeof envelope.tag !== "string" || typeof envelope.ciphertext !== "string") {
      throw new Error("MCP OAuth credential file has an unsupported format");
    }
    const nonce = Buffer.from(envelope.nonce, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("MCP OAuth credential file is invalid");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(this.associatedData);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as SavedCredentials;
  }

  async update(change: (saved: SavedCredentials) => void): Promise<void> {
    const saved = await this.read();
    change(saved);
    const key = await this.key(true);
    if (!key) throw new Error("MCP OAuth encryption key could not be created");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(this.associatedData);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(saved), "utf8"), cipher.final()]);
    const envelope: EncryptedCredentialFile = { version: 1, nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
    const directory = path.dirname(this.filePath);
    assertPlainAncestors(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    assertPlainAncestors(this.filePath);
    const temporary = `${this.filePath}.${randomBytes(16).toString("hex")}.tmp`;
    try {
      const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
      const handle = await open(temporary, flags, 0o600);
      try { await handle.writeFile(JSON.stringify(envelope), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    await this.entryFactory(this.legacyAccount).deleteCredential().catch(() => undefined);
  }

  async clear(): Promise<void> {
    assertPlainAncestors(this.filePath);
    await rm(this.filePath, { force: true });
    await this.entryFactory(this.legacyAccount).deleteCredential();
    await this.entryFactory(this.keyAccount).deleteCredential();
  }
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

/** Explicit /mcp login: local callback, SDK discovery/PKCE/exchange, encrypted credential persistence. */
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

export function storedMcpOauthProvider(serverId: string, url: string,
  dataDir = resolveEasyCodePaths().dataDir): OAuthClientProvider {
  const credentials = new McpOauthCredentials(serverId, url, dataDir);
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
