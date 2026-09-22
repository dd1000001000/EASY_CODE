import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EasyCodeApp } from "../app.js";
import type { ImageAttachment } from "../core/types.js";
import { MAX_IMAGE_BYTES, validateImageAttachmentCollection } from "../images/image-store.js";
import { assertDataDirectoryOutsideWorkspace } from "../images/path-policy.js";
import { parseSlashCommand, SLASH_COMMAND_NAMES } from "../cli/slash-command.js";
import { WEB_COMMAND_DESCRIPTIONS } from "../web-command-catalog.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { projectWebHistory } from "./history.js";
import { WebInteraction } from "./interaction.js";
import { ProjectIndex } from "./projects.js";
import { createStorage, type EasyCodeStorage } from "../storage/database.js";
import { ThreadStore, type ThreadSummary } from "../threads/thread-store.js";
import { deleteThreadTree } from "../threads/delete-thread.js";
import { pickLocalFolder } from "./folder-picker.js";
import { executeLanguageCommand, readLanguage, type Language } from "../i18n/language.js";
import type { WebPatch } from "../web-contracts.js";
import type { ProjectWorkspace } from "../projects/types.js";
import type { ThreadResourceAttachment } from "../resources/index.js";

const WEB_UNAVAILABLE_SLASH_COMMANDS = new Set<string>([
  "new", "resume", "sessions", "exit", "model", "provider", "approval", "orchestration", "image", "clear", "workspace",
]);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES;
class MissingThreadError extends Error {}
interface HostedThread {
  app: EasyCodeApp;
  port: WebInteraction;
  running?: Promise<void>;
  staged: Map<string, ImageAttachment>;
  stagedResources: Map<string, ThreadResourceAttachment>;
  unsubscribe: () => void;
}
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}
async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += part.byteLength;
    if (total > limit) throw new Error(`Request body exceeds the configured ${limit}-byte limit.`);
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("Expected application/json.");
  return asRecord(JSON.parse((await body(request, MAX_JSON_BYTES)).toString("utf8")));
}
function equalToken(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookieToken(request: IncomingMessage): string | undefined {
  return request.headers.cookie?.split(";").map(part => part.trim())
    .find(part => part.startsWith("easy_code_web="))?.slice("easy_code_web=".length);
}
function openBrowser(url: string): void {
  let program: string; let args: string[];
  if (process.platform === "win32") {
    program = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe");
    args = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    program = "/usr/bin/open"; args = [url];
  } else {
    program = "/usr/bin/xdg-open"; args = [url];
  }
  const child = spawn(program, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
  child.once("error", error => process.stderr.write(
    `Could not open the browser: ${error.message}\nOpen ${url} in a browser on this computer instead.\n`,
  ));
  child.unref();
}

export class EasyCodeWebServer {
  private readonly token = randomBytes(32).toString("base64url");
  private readonly cookie = randomBytes(32).toString("base64url");
  private readonly server = http.createServer((request, response) => { void this.handle(request, response); });
  private readonly streams = new Set<ServerResponse>();
  private readonly hosts = new Map<string, HostedThread>();
  private readonly staticRoot: string;
  private origin = "";
  private transitioning = false;
  private stopping = false;
  private readonly projects: ProjectIndex;
  private readonly projectStorage: EasyCodeStorage;
  private broadcastLanguageValue: Language = "en_us";
  private readonly dataDir: string;

  constructor(private app: EasyCodeApp | undefined, private port: WebInteraction, dataDir: string, assetsRoot?: string,
    private readonly createApp?: (workspaceRoot: string, threadId: string | undefined, port: WebInteraction,
      projectWorkspace?: ProjectWorkspace) => Promise<EasyCodeApp>) {
    this.staticRoot = assetsRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
    this.dataDir = dataDir;
    this.projectStorage = createStorage(this.dataDir);
    this.broadcastLanguageValue = readLanguage(this.projectStorage);
    this.port.setLanguage(this.broadcastLanguageValue);
    this.projects = new ProjectIndex(this.projectStorage);
  }

  private hostFor(threadId: unknown): HostedThread {
    if (typeof threadId !== "string") throw new MissingThreadError("Select a conversation before continuing.");
    const host = this.hosts.get(threadId);
    if (!host) throw new MissingThreadError("Conversation is not open. Select it in the sidebar first.");
    return host;
  }

  private busyThreadIds(): string[] {
    return [...this.hosts].filter(([, host]) => host.running || host.app.isProjectWorkspaceBusy?.() || host.port.snapshot().view.busy ||
      host.port.snapshot().view.decision !== null || host.port.snapshot().view.review !== null ||
      host.port.snapshot().view.subagents.some(agent => agent.status === "running" || agent.status === "stopping")).map(([id]) => id);
  }

  private assertProjectIdle(projectId: string): void {
    const projectThreads = new Set(this.allThreads().filter(thread => thread.workspaceId === projectId).map(thread => thread.threadId));
    if (this.busyThreadIds().some(threadId => projectThreads.has(threadId))) {
      throw new Error("Wait for every conversation in this project to finish before changing its folders.");
    }
  }

  private async closeProjectHosts(projectId: string): Promise<void> {
    const threadIds = new Set(this.allThreads().filter(thread => thread.workspaceId === projectId).map(thread => thread.threadId));
    for (const threadId of threadIds) {
      const host = this.hosts.get(threadId);
      if (!host) continue;
      await this.clearStaged(host);
      host.unsubscribe();
      this.hosts.delete(threadId);
      await host.app.closeAsync();
      host.port.close();
    }
    if (this.app && threadIds.has(this.app.sessionInfo().threadId)) await this.leaveCurrentSession();
  }

  private async mutateProjectFolders<Result>(projectId: string, operation: () => Promise<Result> | Result): Promise<Result> {
    if (this.transitioning) throw new Error("Another project or conversation change is still in progress.");
    this.transitioning = true;
    try {
      this.assertProjectIdle(projectId);
      await this.closeProjectHosts(projectId);
      return await operation();
    } finally { this.transitioning = false; }
  }

  private async deleteProjectResources(projectId: string): Promise<void> {
    if (!/^project_[0-9a-f-]{36}$/u.test(projectId)) throw new Error("Invalid project resource identity.");
    const targets = [
      path.join(this.dataDir, "projects", projectId),
      path.join(this.dataDir, "command-leases", projectId),
      path.join(this.dataDir, "command-quarantine", `${projectId}.json`),
      path.join(this.dataDir, "command-boundary", `${projectId}.json`),
    ];
    for (const target of targets) await rm(target, { recursive: true, force: true, maxRetries: 3 });
  }

  private broadcastStatus(): void {
    const data = JSON.stringify({ runningThreadIds: this.busyThreadIds() });
    for (const stream of this.streams) if (!stream.destroyed) stream.write(`event: status\ndata: ${data}\n\n`);
  }

  private broadcastLanguage(): void {
    const language = readLanguage(this.projectStorage);
    if (language === this.broadcastLanguageValue) return;
    this.broadcastLanguageValue = language;
    this.port.setLanguage(language);
    for (const host of this.hosts.values()) host.port.setLanguage(language);
    const data = JSON.stringify({ language });
    for (const stream of this.streams) if (!stream.destroyed) stream.write(`event: language\ndata: ${data}\n\n`);
  }

  private attachHost(app: EasyCodeApp, port: WebInteraction): HostedThread {
    const threadId = app.sessionInfo().threadId;
    const host: HostedThread = { app, port, staged: new Map(), stagedResources: new Map(), unsubscribe: () => undefined };
    host.unsubscribe = port.subscribe(change => {
      const patch: WebPatch | undefined = change.patch?.kind === "entries.reset"
        ? { kind: "entries.reset", entries: port.historyPage().entries, history: port.historyState() }
        : change.patch;
      const data = JSON.stringify({ threadId, sequence: change.sequence, patch });
      for (const stream of this.streams) if (!stream.destroyed) stream.write(`event: patch\ndata: ${data}\n\n`);
      this.broadcastStatus();
    });
    this.hosts.set(threadId, host);
    app.startHostedSession();
    port.loadHistory(projectWebHistory(app.threadEvents()));
    return host;
  }

  private allThreads(): readonly ThreadSummary[] {
    const store = new ThreadStore(this.projectStorage);
    return store.list({ limit: 100_000 }).filter(item => !store.isBoundSubagentThread(item.threadId));
  }

  async serve(): Promise<void> {
    await this.start();
    await this.waitForStop();
  }

  /** Listen without spawning a browser when embedding or testing the local host. */
  async start(openBrowserPage = true): Promise<string> {
    if (!existsSync(path.join(this.staticRoot, "index.html"))) {
      throw new Error("Web assets are missing. Run npm run build before easy-code --web.");
    }
    if (this.app) this.attachHost(this.app, this.port);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Web listener did not bind to a TCP port.");
    this.origin = `http://127.0.0.1:${address.port}`;
    process.stdout.write(`EASY CODE Web is running at ${this.origin}\nPress Ctrl+C to stop it.\n`);
    if (openBrowserPage) openBrowser(`${this.origin}/#token=${this.token}`);
    return this.origin;
  }

  private async waitForStop(): Promise<void> {
    await new Promise<void>(resolve => {
      const stop = () => { void this.stop().then(resolve); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      this.server.once("close", () => {
        process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const host of this.hosts.values()) {
      host.app.cancelActiveRequest();
      host.port.cancelExternalOperation();
      host.port.cancelPendingDecisions();
    }
    for (const response of this.streams) response.end();
    this.streams.clear();
    await Promise.all([...this.hosts.values()].map(async host => {
      await host.running?.catch(() => undefined);
      await this.clearStaged(host).catch(error => {
        process.stderr.write(`Could not remove staged browser images: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }));
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    try { await Promise.all([...this.hosts.values()].map(async host => {
      host.unsubscribe();
      await host.app.closeAsync();
      host.port.close();
    })); }
    finally { this.projectStorage.close(); }
  }

  private snapshot(): unknown {
    const current = this.port.snapshot();
    const page = this.port.historyPage();
    return {
      ...current,
      language: readLanguage(this.projectStorage),
      view: { ...current.view, entries: page.entries },
      history: this.port.historyState(page),
      plan: this.app?.pendingPlan() ?? null,
      runningThreadIds: this.busyThreadIds(),
      ...this.projects.list(this.allThreads()),
    };
  }

  private run(host: HostedThread, action: () => Promise<void>): void {
    if (host.running) throw new Error("Another operation is still running in this conversation.");
    const work = Promise.resolve().then(action);
    host.running = work;
    this.broadcastStatus();
    void work.catch(error => {
      // A request may fail before the app reaches its own presentation cleanup.
      // Close any pending Web turn so its duration and disclosure do not remain live forever.
      host.port.clearCurrentRequest();
      host.port.error(error instanceof Error ? error.message : String(error));
    })
      .finally(() => { if (host.running === work) host.running = undefined; this.broadcastStatus(); });
  }

  private async switchSession(projectId: string, threadId?: string): Promise<void> {
    if (this.transitioning) throw new Error("A conversation is already opening.");
    if (!this.createApp) throw new Error("Project switching is unavailable in this host.");
    this.transitioning = true;
    try {
      const existing = threadId && this.hosts.get(threadId);
      if (existing) {
        this.app = existing.app;
        this.port = existing.port;
        return;
      }
      const nextPort = new WebInteraction();
      let next: EasyCodeApp;
      const projectWorkspace = this.projects.workspace(projectId);
      const root = projectWorkspace.folders.find(folder => folder.id === projectWorkspace.primaryFolderId)!.path;
      try { next = await this.createApp(root, threadId, nextPort, projectWorkspace); }
      catch (error) { nextPort.close(); throw error; }
      if (path.resolve(next.dataDirectory()) !== path.resolve(this.dataDir)) {
        await next.closeAsync();
        nextPort.close();
        throw new Error("This project uses a different EASY CODE data directory.");
      }
      this.attachHost(next, nextPort);
      this.app = next;
      this.port = nextPort;
    } finally { this.transitioning = false; }
  }

  private async leaveCurrentSession(): Promise<void> {
    this.app = undefined;
    this.port = new WebInteraction();
  }

  private deleteConversation(threadId: string): readonly string[] {
    const storage = createStorage(this.dataDir);
    try { return deleteThreadTree(storage, new ThreadStore(storage), threadId); }
    finally { storage.close(); }
  }

  private async prepareDelete(targetThreadId: string, deletedProjectId?: string): Promise<void> {
    if (this.transitioning || this.hosts.get(targetThreadId)?.running || this.hosts.get(targetThreadId)?.app.isRequestActive() ||
      this.hosts.get(targetThreadId)?.port.snapshot().view.subagents.some(agent => agent.status === "running" || agent.status === "stopping"))
      throw new Error("Stop this conversation before deleting it.");
    const host = this.hosts.get(targetThreadId);
    if (host) {
      await this.clearStaged(host);
      host.unsubscribe();
      this.hosts.delete(targetThreadId);
      await host.app.closeAsync();
      host.port.close();
    }
    if (this.app?.sessionInfo().threadId !== targetThreadId) return;
    this.app = undefined;
    this.port = new WebInteraction();
    const replacement = this.allThreads().filter(item => item.threadId !== targetThreadId &&
      item.workspaceId !== deletedProjectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (replacement) await this.switchSession(replacement.workspaceId, replacement.threadId);
    else await this.leaveCurrentSession();
  }

  private takeImages(host: HostedThread, ids: unknown, consume = true): ImageAttachment[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("Invalid image IDs.");
    const unique = new Set(ids as string[]);
    if (unique.size !== ids.length) throw new Error("Duplicate image IDs.");
    const images = [...unique].map(id => {
      const image = host.staged.get(id);
      if (!image) throw new Error(`Image ${id} is not staged for this Thread.`);
      return image;
    });
    validateImageAttachmentCollection(images);
    if (consume) for (const image of images) host.staged.delete(image.id);
    return images;
  }

  private takeResources(host: HostedThread, ids: unknown, consume = true): ThreadResourceAttachment[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("Invalid resource IDs.");
    const unique = new Set(ids as string[]);
    if (unique.size !== ids.length) throw new Error("Duplicate resource IDs.");
    const resources = [...unique].map(id => {
      const resource = host.stagedResources.get(id);
      if (!resource) throw new Error(`Resource ${id} is not staged for this Thread.`);
      return resource;
    });
    if (consume) for (const resource of resources) host.stagedResources.delete(resource.id);
    return resources;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const host = request.headers.host;
      if (!this.origin || host !== new URL(this.origin).host) { json(response, 403, { error: "Invalid Host." }); return; }
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      const pathname = new URL(request.url ?? "/", this.origin).pathname;
      if (request.method === "POST") {
        if (request.headers.origin !== this.origin) { json(response, 403, { error: "Invalid Origin." }); return; }
        if (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin") {
          json(response, 403, { error: "Cross-site request denied." }); return;
        }
      }
      if (pathname === "/api/bootstrap" && request.method === "POST") {
        const input = await jsonBody(request);
        if (typeof input.token !== "string" || !equalToken(input.token, this.token)) {
          json(response, 403, { error: "Invalid local session token." }); return;
        }
        response.setHeader("Set-Cookie", `easy_code_web=${this.cookie}; HttpOnly; SameSite=Strict; Path=/`);
        json(response, 200, { ok: true }); return;
      }
      if (pathname.startsWith("/api/")) {
        if (!equalToken(cookieToken(request) ?? "", this.cookie)) { json(response, 401, { error: "Local session is not authenticated." }); return; }
        await this.api(pathname, request, response); return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") { json(response, 405, { error: "Method not allowed." }); return; }
      await this.staticFile(pathname, request, response);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      json(response, error instanceof MissingThreadError ? 409 : 400,
        { error: redactSensitiveInformation(error instanceof Error ? error.message : String(error)) });
    }
  }

  private async api(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (pathname === "/api/state" && request.method === "GET") { json(response, 200, this.snapshot()); return; }
    if (pathname === "/api/history" && request.method === "GET") {
      const params = new URL(request.url ?? pathname, this.origin).searchParams;
      const host = this.hostFor(params.get("threadId"));
      const epoch = params.get("epoch");
      if (!epoch || epoch !== host.port.historyState().epoch) throw new Error("History changed; refresh the conversation.");
      const before = params.get("before") ?? undefined;
      const after = params.get("after") ?? undefined;
      const around = params.get("around") ?? undefined;
      if ([before, after, around].some(cursor => cursor && cursor.length > 200)) throw new Error("Invalid history cursor.");
      const page = host.port.historyPage({ before, after, around });
      json(response, 200, { threadId: host.app.sessionInfo().threadId, epoch, ...page }); return;
    }
    if (pathname === "/api/commands" && request.method === "GET") {
      json(response, 200, { commands: SLASH_COMMAND_NAMES
        .filter(name => !WEB_UNAVAILABLE_SLASH_COMMANDS.has(name) && WEB_COMMAND_DESCRIPTIONS[name])
        .map(name => ({ name, description: WEB_COMMAND_DESCRIPTIONS[name] })) }); return;
    }
    if (pathname === "/api/events" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
      this.streams.add(response);
      response.write(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
      const heartbeat = setInterval(() => {
        this.broadcastLanguage();
        if (!response.destroyed) response.write(": heartbeat\n\n");
      }, 25_000);
      request.once("close", () => { clearInterval(heartbeat); this.streams.delete(response); });
      return;
    }
    if (request.method !== "POST") { json(response, 405, { error: "Method not allowed." }); return; }
    if (pathname === "/api/image") {
      const host = this.hostFor(request.headers["x-easy-code-thread-id"]);
      if (host.staged.size >= 20) throw new Error("Too many staged images.");
      const contentType = request.headers["content-type"]?.split(";")[0];
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType ?? "")) throw new Error("Unsupported image type.");
      const data = await body(request, MAX_UPLOAD_BYTES);
      const image = await host.app.importHostedImage(data, host.app.nextHostedImageLabel(host.staged.size), "browser-upload");
      try { validateImageAttachmentCollection([...host.staged.values(), image]); }
      catch (error) { await host.app.discardHostedImage(image); throw error; }
      host.staged.set(image.id, image);
      json(response, 200, { image: { id: image.id, label: image.label, mediaType: image.mediaType } }); return;
    }
    if (pathname === "/api/resource") {
      const host = this.hostFor(request.headers["x-easy-code-thread-id"]);
      if (host.stagedResources.size >= 20) throw new Error("Too many staged documents.");
      const mediaType = request.headers["content-type"]?.split(";")[0]?.toLowerCase() || "application/octet-stream";
      const encodedName = request.headers["x-easy-code-filename"];
      if (typeof encodedName !== "string") throw new Error("Document filename is required.");
      let filename: string;
      try { filename = decodeURIComponent(encodedName); } catch { throw new Error("Invalid document filename."); }
      const data = await body(request, host.app.hostedDocumentMaxBytes());
      const resource = await host.app.importHostedDocument(data, filename, mediaType);
      host.stagedResources.set(resource.id, resource);
      json(response, 200, { resource }); return;
    }
    const input = await jsonBody(request);
    if (pathname === "/api/command" || pathname === "/api/message" &&
      typeof input.text === "string" && parseSlashCommand(input.text)?.name === "language") {
      if (Array.isArray(input.imageIds) && input.imageIds.length) {
        throw new Error("Send /language without attached images.");
      }
      const command = typeof input.text === "string" ? parseSlashCommand(input.text) : null;
      if (command?.name !== "language") throw new Error("Only /language is available without a conversation.");
      const result = executeLanguageCommand(this.projectStorage, command.args);
      if (result.changed) this.broadcastLanguage();
      json(response, 200, result); return;
    }
    if (pathname === "/api/folder/pick") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6 * 60_000);
      try { json(response, 200, { path: await pickLocalFolder(controller.signal) ?? null }); }
      finally { clearTimeout(timeout); }
      return;
    }
    if (pathname === "/api/image/discard") {
      const host = this.hostFor(input.threadId);
      if (typeof input.id !== "string") throw new Error("Invalid image ID.");
      const image = host.staged.get(input.id);
      if (image) {
        await host.app.discardHostedImage(image);
        host.staged.delete(input.id);
      }
      json(response, 200, { discarded: Boolean(image) }); return;
    }
    if (pathname === "/api/resource/discard") {
      const host = this.hostFor(input.threadId);
      if (typeof input.id !== "string") throw new Error("Invalid resource ID.");
      const resource = host.stagedResources.get(input.id);
      if (resource) {
        await host.app.discardHostedResource(resource);
        host.stagedResources.delete(input.id);
      }
      json(response, 200, { discarded: Boolean(resource) }); return;
    }
    if (pathname === "/api/ui/command/cancel") {
      const host = this.hostFor(input.threadId);
      json(response, 200, { canceled: host.port.cancelExternalOperation() }); return;
    }
    if (pathname === "/api/ui/model" || pathname === "/api/ui/approval" || pathname === "/api/ui/orchestration") {
      const host = this.hostFor(input.threadId);
      if (host.running || host.app.isRequestActive()) throw new Error("Wait for the current request to finish.");
      this.run(host, () => pathname === "/api/ui/model"
        ? host.app.selectHostedModel() : pathname === "/api/ui/approval"
          ? host.app.selectHostedApproval() : host.app.selectHostedOrchestration());
      json(response, 202, { accepted: true }); return;
    }
    if (pathname === "/api/message") {
      const host = this.hostFor(input.threadId);
      if (host.running || host.app.isRequestActive()) throw new Error("A request is already running; use the adjustment composer.");
      if (typeof input.text !== "string" || input.text.length > 200_000) throw new Error("Invalid message text.");
      if (parseSlashCommand(input.text) && ((Array.isArray(input.imageIds) && input.imageIds.length) ||
          (Array.isArray(input.resourceIds) && input.resourceIds.length))) {
        throw new Error("Send slash commands without attachments; attachments remain available in the composer.");
      }
      const images = this.takeImages(host, input.imageIds, false);
      const resources = this.takeResources(host, input.resourceIds, false);
      for (const image of images) host.staged.delete(image.id);
      for (const resource of resources) host.stagedResources.delete(resource.id);
      if (!input.text.trim() && !images.length && !resources.length) throw new Error("A message needs text or an attachment.");
      if (parseSlashCommand(input.text) && !images.length) {
        const command = parseSlashCommand(input.text);
        if (command && WEB_UNAVAILABLE_SLASH_COMMANDS.has(command.name))
          throw new Error(`/${command.name} is not available as a Web command.`);
        this.run(host, async () => {
          const exit = await host.app.handleSlashCommand(input.text as string);
          if (exit) host.port.info("Use Ctrl+C in the EASY CODE terminal to stop the Web server.");
        });
      } else {
        host.port.presentUser(input.text, images, resources);
        this.run(host, async () => {
          await host.app.submitUserMessage(input.text as string || "Analyze the attached resource(s).", images, resources);
        });
      }
      json(response, 202, { accepted: true }); return;
    }
    if (pathname === "/api/adjustment") {
      const host = this.hostFor(input.threadId);
      if (typeof input.text !== "string" || input.text.length > 200_000) throw new Error("Invalid adjustment text.");
      const command = parseSlashCommand(input.text);
      if (command && WEB_UNAVAILABLE_SLASH_COMMANDS.has(command.name))
        throw new Error(`/${command.name} is not available as a Web command.`);
      const images = this.takeImages(host, input.imageIds, false);
      const resources = this.takeResources(host, input.resourceIds, false);
      for (const image of images) host.staged.delete(image.id);
      for (const resource of resources) host.stagedResources.delete(resource.id);
      let sequence: number;
      const resourceNotice = resources.length ? `\n\nAttached read-only Thread resources:\n${resources.map(resource => `- ${resource.filename}: ${resource.uri}`).join("\n")}\nUse read_file with these exact paths.` : "";
      try { sequence = await host.app.submitAdjustment(`${input.text}${resourceNotice}`, images); }
      catch (error) {
        for (const image of images) host.staged.set(image.id, image);
        for (const resource of resources) host.stagedResources.set(resource.id, resource);
        throw error;
      }
      json(response, 200, { sequence }); return;
    }
    if (pathname === "/api/cancel") { json(response, 200, { canceled: this.hostFor(input.threadId).app.cancelActiveRequest() }); return; }
    if (pathname === "/api/decision") {
      const host = this.hostFor(input.threadId);
      if (typeof input.id !== "string" || (input.value !== undefined && typeof input.value !== "string") ||
        (typeof input.value === "string" && input.value.length > 8192)) throw new Error("Invalid decision.");
      json(response, 200, { accepted: host.port.resolveDecision(input.id, input.value as string | undefined) }); return;
    }
    if (pathname === "/api/plan") {
      const host = this.hostFor(input.threadId);
      if (host.running) throw new Error("Another session operation is running.");
      if (input.action !== "approve" && input.action !== "reject" && input.action !== "adjust") throw new Error("Invalid plan decision.");
      const decision = input.action === "adjust"
        ? { action: "adjust" as const, feedback: String(input.feedback ?? "").trim() }
        : { action: input.action } as { action: "approve" | "reject" };
      if (decision.action === "adjust" && !decision.feedback) throw new Error("Plan feedback is required.");
      this.run(host, () => host.app.reviewHostedPlan(decision));
      json(response, 202, { accepted: true }); return;
    }
    if (pathname === "/api/thread") {
      const threads = this.allThreads();
      if (input.action === "new") {
        const project = typeof input.projectId === "string"
          ? this.projects.get(input.projectId)
          : this.app?.sessionInfo().projectId
            ? this.projects.get(this.app.sessionInfo().projectId!)
            : undefined;
        if (!project) throw new Error("Choose a project folder first.");
        if (!project.ready) throw new Error("Attach at least one folder before creating a conversation.");
        await this.switchSession(project.id);
      } else if (input.action === "resume" && typeof input.threadId === "string") {
        const thread = threads.find(item => item.threadId === input.threadId);
        if (!thread) throw new Error("Conversation not found.");
        await this.switchSession(thread.workspaceId, thread.threadId);
      } else throw new Error("Invalid Thread action.");
      json(response, 200, { accepted: true }); return;
    }
    if (pathname === "/api/project/add") {
      if (input.name !== undefined && typeof input.name !== "string") throw new Error("Invalid project name.");
      if (this.transitioning) throw new Error("A project is already opening.");
      this.transitioning = true;
      try {
        const project = this.projects.create(typeof input.name === "string" ? input.name : "Untitled project");
        await this.leaveCurrentSession();
        json(response, 200, { project }); return;
      } finally { this.transitioning = false; }
    }
    if (pathname === "/api/project/folder/add") {
      if (typeof input.projectId !== "string" || typeof input.path !== "string") throw new Error("Choose a project and local folder.");
      await assertDataDirectoryOutsideWorkspace(this.dataDir, input.path);
      const folder = await this.mutateProjectFolders(input.projectId,
        () => this.projects.addFolder(input.projectId as string, input.path as string));
      json(response, 200, { folder, project: this.projects.get(input.projectId) }); return;
    }
    if (pathname === "/api/project/folder/remove") {
      if (typeof input.projectId !== "string" || typeof input.folderId !== "string") throw new Error("Invalid project folder.");
      await this.mutateProjectFolders(input.projectId,
        () => this.projects.removeFolder(input.projectId as string, input.folderId as string));
      json(response, 200, { project: this.projects.get(input.projectId) }); return;
    }
    if (pathname === "/api/project/folder/primary") {
      if (typeof input.projectId !== "string" || typeof input.folderId !== "string") throw new Error("Invalid project folder.");
      await this.mutateProjectFolders(input.projectId,
        () => this.projects.setPrimaryFolder(input.projectId as string, input.folderId as string));
      json(response, 200, { project: this.projects.get(input.projectId) }); return;
    }
    if (pathname === "/api/project/edit") {
      if (typeof input.projectId !== "string" || typeof input.name !== "string" ||
        !Array.isArray(input.retainedFolderIds) || !input.retainedFolderIds.every(value => typeof value === "string") ||
        !Array.isArray(input.addedFolderPaths) || !input.addedFolderPaths.every(value => typeof value === "string") ||
        input.primaryFolderId !== undefined && typeof input.primaryFolderId !== "string" ||
        input.primaryFolderPath !== undefined && typeof input.primaryFolderPath !== "string") {
        throw new Error("Invalid project edit.");
      }
      for (const folderPath of input.addedFolderPaths as string[]) {
        await assertDataDirectoryOutsideWorkspace(this.dataDir, folderPath);
      }
      const project = await this.mutateProjectFolders(input.projectId, () => this.projects.editProject(input.projectId as string, {
        name: input.name as string,
        retainedFolderIds: input.retainedFolderIds as string[],
        addedFolderPaths: input.addedFolderPaths as string[],
        ...(typeof input.primaryFolderId === "string" ? { primaryFolderId: input.primaryFolderId } : {}),
        ...(typeof input.primaryFolderPath === "string" ? { primaryFolderPath: input.primaryFolderPath } : {}),
      }));
      json(response, 200, { project }); return;
    }
    if (pathname === "/api/project/rename") {
      if (typeof input.projectId !== "string" || typeof input.name !== "string") throw new Error("Invalid project rename.");
      this.projects.renameProject(input.projectId, input.name);
      json(response, 200, { accepted: true }); return;
    }
    if (pathname === "/api/thread/rename") {
      if (typeof input.threadId !== "string" || typeof input.name !== "string") throw new Error("Invalid conversation rename.");
      const thread = this.allThreads().find(item => item.threadId === input.threadId);
      if (!thread) throw new Error("Conversation not found.");
      this.projects.renameThread(thread, input.name);
      json(response, 200, { accepted: true }); return;
    }
    if (pathname === "/api/thread/delete") {
      if (typeof input.threadId !== "string" || input.confirmThreadId !== input.threadId) throw new Error("Confirm the exact conversation ID to delete.");
      const thread = this.allThreads().find(item => item.threadId === input.threadId);
      if (!thread) throw new Error("Conversation not found.");
      await this.prepareDelete(thread.threadId);
      const deleted = this.deleteConversation(thread.threadId);
      json(response, 200, { deleted }); return;
    }
    if (pathname === "/api/project/delete") {
      if (typeof input.projectId !== "string") throw new Error("Invalid project ID.");
      const project = this.projects.get(input.projectId);
      if (input.confirmProjectId !== project.id) throw new Error("Confirm the exact project ID to remove.");
      const threads = this.allThreads().filter(item => item.workspaceId === project.id);
      const busy = new Set(this.busyThreadIds());
      if (threads.some(thread => busy.has(thread.threadId)))
        throw new Error("Stop the project's active conversations before removing it.");
      for (const thread of threads) {
        if (!this.allThreads().some(item => item.threadId === thread.threadId)) continue;
        await this.prepareDelete(thread.threadId, project.id);
        this.deleteConversation(thread.threadId);
      }
      this.projectStorage.db.prepare<[string]>(
        "DELETE FROM memories WHERE workspace_id = ? AND scope = 'project'",
      ).run(project.id);
      this.projects.forgetProject(project.id);
      await this.deleteProjectResources(project.id);
      json(response, 200, { removed: project.id, deletedThreads: threads.length }); return;
    }
    if (pathname === "/api/external-cancel") { json(response, 200, { canceled: this.hostFor(input.threadId).port.cancelExternalOperation() }); return; }
    json(response, 404, { error: "Unknown API route." });
  }

  private async clearStaged(host: HostedThread): Promise<void> {
    let failure: unknown;
    for (const image of host.staged.values()) {
      try { await host.app.discardHostedImage(image); host.staged.delete(image.id); }
      catch (error) { failure ??= error; }
    }
    for (const resource of host.stagedResources.values()) {
      try { await host.app.discardHostedResource(resource); host.stagedResources.delete(resource.id); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }

  private async staticFile(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const relative = pathname === "/" || !path.extname(pathname) ? "index.html" : decodeURIComponent(pathname.slice(1));
    const target = path.resolve(this.staticRoot, relative);
    if (target !== this.staticRoot && !target.startsWith(this.staticRoot + path.sep)) { json(response, 404, { error: "Not found." }); return; }
    if (!existsSync(target) || !statSync(target).isFile()) { json(response, 404, { error: "Not found." }); return; }
    response.writeHead(200, { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    if (request.method === "HEAD") response.end(); else createReadStream(target).pipe(response);
  }
}

export async function serveWeb(dataDir: string, port: WebInteraction,
  createApp?: (workspaceRoot: string, threadId: string | undefined, port: WebInteraction,
    projectWorkspace?: ProjectWorkspace) => Promise<EasyCodeApp>, signal?: AbortSignal): Promise<void> {
  const server = new EasyCodeWebServer(undefined, port, dataDir, undefined, createApp);
  const stop = () => { void server.stop(); };
  signal?.addEventListener("abort", stop, { once: true });
  try { await server.serve(); }
  finally { signal?.removeEventListener("abort", stop); await server.stop(); }
}
