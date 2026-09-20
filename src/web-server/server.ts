import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EasyCodeApp } from "../app.js";
import type { ImageAttachment } from "../core/types.js";
import { MAX_IMAGE_BYTES, validateImageAttachmentCollection } from "../images/image-store.js";
import { parseSlashCommand } from "../cli/slash-command.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { projectWebHistory } from "./history.js";
import { WebInteraction } from "./interaction.js";
import type { WebPatch } from "../web-contracts.js";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES;
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
    if (total > limit) throw new Error("Request body exceeds the allowed size.");
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
  private readonly staged = new Map<string, ImageAttachment>();
  private readonly staticRoot: string;
  private origin = "";
  private running?: Promise<void>;
  private stopping = false;

  constructor(private readonly app: EasyCodeApp, private readonly port: WebInteraction, assetsRoot?: string) {
    this.staticRoot = assetsRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
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
    this.app.startHostedSession();
    this.port.loadHistory(projectWebHistory(this.app.threadEvents()));
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
    this.app.cancelActiveRequest();
    this.port.cancelExternalOperation();
    this.port.cancelPendingDecisions();
    for (const response of this.streams) response.end();
    this.streams.clear();
    await this.running?.catch(() => undefined);
    await this.clearStaged().catch(error => {
      process.stderr.write(`Could not remove staged browser images: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private snapshot(): unknown {
    return {
      ...this.port.snapshot(),
      plan: this.app.pendingPlan() ?? null,
      threads: this.app.workspaceThreads(),
    };
  }

  private run(action: () => Promise<void>): void {
    if (this.running) throw new Error("Another session operation is still running.");
    const work = Promise.resolve().then(action);
    this.running = work;
    void work.catch(error => this.port.error(error instanceof Error ? error.message : String(error)))
      .finally(() => { if (this.running === work) this.running = undefined; });
  }

  private takeImages(ids: unknown): ImageAttachment[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("Invalid image IDs.");
    const unique = new Set(ids as string[]);
    if (unique.size !== ids.length) throw new Error("Duplicate image IDs.");
    const images = [...unique].map(id => {
      const image = this.staged.get(id);
      if (!image) throw new Error(`Image ${id} is not staged for this Thread.`);
      return image;
    });
    validateImageAttachmentCollection(images);
    for (const image of images) this.staged.delete(image.id);
    return images;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const host = request.headers.host;
      if (!this.origin || host !== new URL(this.origin).host) { json(response, 403, { error: "Invalid Host." }); return; }
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
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
      json(response, 400, { error: redactSensitiveInformation(error instanceof Error ? error.message : String(error)) });
    }
  }

  private async api(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (pathname === "/api/state" && request.method === "GET") { json(response, 200, this.snapshot()); return; }
    if (pathname === "/api/events" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
      this.streams.add(response);
      response.write(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
      const unsubscribe = this.port.subscribe(change => {
        if (response.destroyed) return;
        response.write(`id: ${change.sequence}\nevent: patch\ndata: ${JSON.stringify(change.patch as WebPatch)}\n\n`);
      });
      const heartbeat = setInterval(() => { if (!response.destroyed) response.write(": heartbeat\n\n"); }, 25_000);
      request.once("close", () => { clearInterval(heartbeat); unsubscribe(); this.streams.delete(response); });
      return;
    }
    if (request.method !== "POST") { json(response, 405, { error: "Method not allowed." }); return; }
    if (pathname === "/api/image") {
      if (this.staged.size >= 20) throw new Error("Too many staged images.");
      const contentType = request.headers["content-type"]?.split(";")[0];
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType ?? "")) throw new Error("Unsupported image type.");
      const data = await body(request, MAX_UPLOAD_BYTES);
      const image = await this.app.importHostedImage(data, this.app.nextHostedImageLabel(this.staged.size), "browser-upload");
      try { validateImageAttachmentCollection([...this.staged.values(), image]); }
      catch (error) { await this.app.discardHostedImage(image); throw error; }
      this.staged.set(image.id, image);
      json(response, 200, { image: { id: image.id, label: image.label, mediaType: image.mediaType } }); return;
    }
    const input = await jsonBody(request);
    if (pathname === "/api/image/discard") {
      if (typeof input.id !== "string") throw new Error("Invalid image ID.");
      const image = this.staged.get(input.id);
      if (image) {
        await this.app.discardHostedImage(image);
        this.staged.delete(input.id);
      }
      json(response, 200, { discarded: Boolean(image) }); return;
    }
    if (pathname === "/api/message") {
      if (this.running || this.app.isRequestActive()) throw new Error("A request is already running; use the adjustment composer.");
      if (typeof input.text !== "string" || input.text.length > 200_000) throw new Error("Invalid message text.");
      if (parseSlashCommand(input.text) && Array.isArray(input.imageIds) && input.imageIds.length) {
        throw new Error("Send slash commands without attached images; images remain available in the composer.");
      }
      const images = this.takeImages(input.imageIds);
      if (!input.text.trim() && !images.length) throw new Error("A message needs text or an image.");
      if (parseSlashCommand(input.text) && !images.length) {
        this.run(async () => {
          const previousThreadId = this.app.sessionInfo().threadId;
          const exit = await this.app.handleSlashCommand(input.text as string);
          if (exit) this.port.info("Use Ctrl+C in the EASY CODE terminal to stop the Web server.");
          if (this.app.sessionInfo().threadId !== previousThreadId) {
            this.port.loadHistory(projectWebHistory(this.app.threadEvents()));
          }
        });
      } else {
        this.port.presentUser(input.text, images);
        this.run(async () => {
          const result = await this.app.submitUserMessage(input.text as string || "Analyze the attached image(s).", images);
          if (result.planProposal) this.port.showPlan(result.planProposal);
        });
      }
      json(response, 202, { accepted: true }); return;
    }
    if (pathname === "/api/adjustment") {
      if (typeof input.text !== "string" || input.text.length > 200_000) throw new Error("Invalid adjustment text.");
      const images = this.takeImages(input.imageIds);
      let sequence: number;
      try { sequence = await this.app.submitAdjustment(input.text, images); }
      catch (error) {
        for (const image of images) this.staged.set(image.id, image);
        throw error;
      }
      json(response, 200, { sequence }); return;
    }
    if (pathname === "/api/cancel") { json(response, 200, { canceled: this.app.cancelActiveRequest() }); return; }
    if (pathname === "/api/decision") {
      if (typeof input.id !== "string" || (input.value !== undefined && typeof input.value !== "string") ||
        (typeof input.value === "string" && input.value.length > 8192)) throw new Error("Invalid decision.");
      json(response, 200, { accepted: this.port.resolveDecision(input.id, input.value as string | undefined) }); return;
    }
    if (pathname === "/api/plan") {
      if (this.running) throw new Error("Another session operation is running.");
      if (input.action !== "approve" && input.action !== "reject" && input.action !== "adjust" && input.action !== "defer") throw new Error("Invalid plan decision.");
      const decision = input.action === "adjust"
        ? { action: "adjust" as const, feedback: String(input.feedback ?? "").trim() }
        : { action: input.action } as { action: "approve" | "reject" | "defer" };
      if (decision.action === "adjust" && !decision.feedback) throw new Error("Plan feedback is required.");
      this.run(() => this.app.reviewHostedPlan(decision));
      json(response, 202, { accepted: true }); return;
    }
    if (pathname === "/api/thread") {
      if (this.running || this.app.isRequestActive()) throw new Error("Wait for the active operation before switching Threads.");
      if (input.action === "new") {
        this.run(async () => { await this.clearStaged(); await this.app.startNewHostedThread(); this.port.loadHistory(projectWebHistory(this.app.threadEvents())); });
      } else if (input.action === "resume" && typeof input.threadId === "string") {
        this.run(async () => { await this.clearStaged(); await this.app.resumeHostedThread(input.threadId as string); this.port.loadHistory(projectWebHistory(this.app.threadEvents())); });
      } else throw new Error("Invalid Thread action.");
      json(response, 202, { accepted: true }); return;
    }
    if (pathname === "/api/external-cancel") { json(response, 200, { canceled: this.port.cancelExternalOperation() }); return; }
    json(response, 404, { error: "Unknown API route." });
  }

  private async clearStaged(): Promise<void> {
    let failure: unknown;
    for (const image of this.staged.values()) {
      try { await this.app.discardHostedImage(image); this.staged.delete(image.id); }
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

export async function serveWeb(app: EasyCodeApp, port: WebInteraction): Promise<void> {
  const server = new EasyCodeWebServer(app, port);
  try { await server.serve(); }
  finally { await server.stop(); }
}
