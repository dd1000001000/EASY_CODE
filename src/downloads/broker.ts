import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import type { WorkspaceManager } from "../workspace/manager.js";
import { sha256 } from "../utils/hash.js";

const integrity = z.string().regex(/^(?:sha256-[A-Za-z0-9+/]{43}=|sha512-[A-Za-z0-9+/]{86}==)$/u);
const artifactSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/u),
  kind: z.enum(["file", "npm", "wheel"]),
  url: z.string().url().max(4096),
  integrity,
  filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/u),
  maxBytes: z.number().int().min(1).max(268435456),
  redirects: z.array(z.string().url().max(4096)).max(3).default([]),
  workspaceRoot: z.string().min(1),
}).strict();
export type DownloadArtifact = z.infer<typeof artifactSchema>;
const catalogueSchema = z.object({version: z.literal(1), artifacts: z.array(artifactSchema).max(2048)}).strict();

function pathKey(filename: string): string {
  const normalized = path.resolve(filename);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function approvedRedirect(current: URL, location: string, approved: readonly string[]): URL {
  if (!location) throw new Error("Artifact redirect is missing a location");
  const next = new URL(location, current);
  if (!approved.includes(next.href)) throw new Error("Artifact redirect was not explicitly authorized");
  return assertArtifactURL(next.href);
}

/** No DNS, loopback, private/link-local/reserved IPv4 or IPv6 endpoint exception. */
export function publicDownloadAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number) as [number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
    a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) ||
    a === 192 && b === 0 || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113);
}

export function assertArtifactURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.port && url.port !== "443" || isIP(url.hostname) ||
      !url.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal)$/iu.test(url.hostname)) {
    throw new Error("Artifact URL must be a public HTTPS origin without credentials or fragments");
  }
  return url;
}

async function requestBytes(url: URL, maxBytes: number, signal: AbortSignal): Promise<{ bytes?: Buffer; redirect?: string }> {
  signal.throwIfAborted();
  let abort!: () => void;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, family: 4 }),
    new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }),
  ]).finally(() => signal.removeEventListener("abort", abort));
  if (!addresses.length || addresses.some(({ address }) => !publicDownloadAddress(address))) throw new Error("Artifact DNS resolved to a forbidden address");
  // Pin the checked address for this request. A second resolver cannot rebind it.
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", agent: false, family: 4, signal, rejectUnauthorized: true,
      lookup: (_hostname, _options, callback) => callback(null, addresses[0]!.address, 4),
      headers: { Accept: "application/octet-stream", "Accept-Encoding": "identity", "User-Agent": "EASY-CODE-Artifact/1" } }, async (res) => {
      try {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) { res.destroy(); resolve({redirect: res.headers.location ?? ""}); return; }
        if (res.statusCode !== 200) throw new Error(`Artifact server returned HTTP ${res.statusCode}`);
        if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") throw new Error("Encoded download bodies are not accepted");
        if (Number(res.headers["content-length"] ?? 0) > maxBytes) throw new Error("Artifact exceeds its byte allowance");
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of res) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          if (size > maxBytes) throw new Error("Artifact exceeds its byte allowance");
          chunks.push(data);
        }
        resolve({bytes: Buffer.concat(chunks)});
      } catch (error) { res.destroy(); reject(error); }
    });
    req.once("error", reject);
    req.end();
  });
}

export function verifyArtifact(bytes: Buffer, expected: string): void {
  integrity.parse(expected);
  const separator = expected.indexOf("-");
  if (createHash(expected.slice(0, separator)).update(bytes).digest("base64") !== expected.slice(separator + 1)) {
    throw new Error("Artifact integrity mismatch; content was not installed");
  }
}

async function ordinaryDirectory(root: string): Promise<string> {
  await mkdir(root, {recursive: true, mode: 0o700});
  const canonical = await realpath(root);
  if (pathKey(canonical) !== pathKey(root) || (await lstat(root)).isSymbolicLink()) {
    throw new Error("Download cache must not traverse redirected directories");
  }
  return canonical;
}

/** Immutable per-run catalogue. Model input selects IDs, never URLs or headers. */
export class DownloadBroker {
  private readonly artifacts = new Map<string, DownloadArtifact>();
  private readonly manifests = new Map<string, string>();
  private pending: Promise<unknown> = Promise.resolve();
  private downloadedBytes = 0;
  private budgetPath?: string;
  private constructor(private readonly workspace: WorkspaceManager, private readonly cacheRoot: string) {}

  static async create(workspace: WorkspaceManager, configDirectory: string, cacheDirectory: string, scope?: string): Promise<DownloadBroker> {
    for (const root of [configDirectory, cacheDirectory]) {
      if (/^(?:\\\\|\/\/)/u.test(root)) throw new Error("Download authority must use a local filesystem");
      await mkdir(root, { recursive: true, mode: 0o700 });
    }
    // Resolve trusted user paths once (including Windows 8.3 aliases), then
    // verify containment on their physical targets, not their lexical aliases.
    configDirectory = await realpath(configDirectory);
    cacheDirectory = await realpath(cacheDirectory);
    // A model-writable workspace cannot contain the authority catalogue/cache.
    for (const root of [configDirectory, cacheDirectory]) {
      const relative = path.relative(workspace.root, path.resolve(root));
      if (relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
        throw new Error("Trusted download configuration/cache must be outside the model workspace");
      }
    }
    const broker = new DownloadBroker(workspace, path.join(cacheDirectory, "approved-artifacts"));
    const catalogPath = path.join(configDirectory, "artifact-catalog.json");
    try {
      const info = await lstat(catalogPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2097152) throw new Error("Invalid trusted artifact catalogue");
      const catalogue = catalogueSchema.parse(JSON.parse(await readFile(catalogPath, "utf8")));
      for (const entry of catalogue.artifacts) {
        if (pathKey(entry.workspaceRoot) !== pathKey(workspace.root)) continue;
        broker.register(entry);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const snapshotRoot = await ordinaryDirectory(path.join(cacheDirectory,"download-authorizations"));
    const snapshotPath = scope ? path.join(snapshotRoot,sha256(JSON.stringify([workspace.root,scope]))) : undefined;
    broker.budgetPath = snapshotPath ? `${snapshotPath}.budget` : undefined;
    if (broker.budgetPath) try {
      const info = await lstat(broker.budgetPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error("Invalid download budget ledger");
      const ledger = await readFile(broker.budgetPath, "utf8");
      if (!/^(?:[0-9]+\n)+$/u.test(ledger)) throw new Error("Incomplete download budget ledger; refusing to reset its budget");
      const balances = ledger.trimEnd().split("\n").map(value => z.number().int().min(0).max(536870912).parse(Number(value)));
      broker.downloadedBytes = balances[balances.length - 1]!;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let restored = false;
    if(snapshotPath) try {
      const info=await lstat(snapshotPath);
      if(!info.isFile()||info.isSymbolicLink()||info.size>2097152) throw new Error("Invalid download authorization snapshot");
      const saved=z.object({version:z.literal(1),manifests:z.array(z.tuple([z.enum(["package.json","package-lock.json"]),z.string().regex(/^[a-f0-9]{64}$/u)])).max(2),artifacts:z.array(artifactSchema).max(2048)}).strict().parse(JSON.parse(await readFile(snapshotPath,"utf8")));
      saved.manifests.forEach(([name,hash])=>broker.manifests.set(name,hash));
      saved.artifacts.forEach(entry=>{if(!broker.artifacts.has(entry.id))broker.register(entry);});
      restored=true;
    } catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(!restored){
      const before=new Set(broker.artifacts.keys());
      await broker.captureNpmLock();
      if(snapshotPath){const file=await open(snapshotPath,"wx",0o600);try{await file.writeFile(JSON.stringify({version:1,manifests:[...broker.manifests],artifacts:[...broker.artifacts.values()].filter(entry=>!before.has(entry.id))}));await file.sync();}finally{await file.close();}}
    }
    return broker;
  }

  private register(entry: DownloadArtifact): void {
    assertArtifactURL(entry.url);
    entry.redirects.forEach(assertArtifactURL);
    if (entry.kind === "wheel" && !entry.filename.endsWith(".whl")) throw new Error("Wheel downloads require a wheel filename");
    if (entry.kind === "npm" && !entry.filename.endsWith(".tgz")) throw new Error("npm downloads require a tarball filename");
    if (this.artifacts.has(entry.id)) throw new Error("Duplicate artifact identity");
    this.artifacts.set(entry.id, Object.freeze(entry));
  }

  private async captureNpmLock(): Promise<void> {
    try {
      const lockPath = await this.workspace.pathGuard.resolveExisting("package-lock.json", {kind:"file",allowFinalSymlink:false});
      const packagePath = await this.workspace.pathGuard.resolveExisting("package.json", {kind:"file",allowFinalSymlink:false});
      if ((await lstat(lockPath)).size > 10485760 || (await lstat(packagePath)).size > 1048576) return;
      const raw = await readFile(lockPath), manifest = await readFile(packagePath);
      const lock = JSON.parse(raw.toString("utf8")) as {lockfileVersion?: number; packages?: Record<string, { resolved?: string; integrity?: string }>};
      if (!lock || typeof lock !== "object" || ![2,3].includes(lock.lockfileVersion ?? 0) || !lock.packages || typeof lock.packages !== "object") return;
      this.manifests.set("package-lock.json", sha256(raw)); this.manifests.set("package.json",sha256(manifest));
      for (const entry of Object.values(lock.packages).slice(0,2048)) {
        if (!entry || typeof entry.resolved !== "string" || !entry.integrity || !integrity.safeParse(entry.integrity).success) continue;
        let url: URL;
        try { url = assertArtifactURL(entry.resolved); } catch { continue; }
        if (url.hostname !== "registry.npmjs.org" || url.search || !url.pathname.includes("/-/")) continue;
        const id = `npm_${sha256(JSON.stringify([entry.resolved,entry.integrity])).slice(0,32)}`;
        if (this.artifacts.has(id)) continue;
        const artifact = artifactSchema.safeParse({id,kind:"npm",url:url.href,integrity:entry.integrity,
          filename:path.posix.basename(url.pathname),maxBytes:67108864,workspaceRoot:this.workspace.root});
        if (artifact.success) this.register(artifact.data);
      }
    } catch (error) {
      // A project without a supported valid lock has no implicit authority.
      // It should still be possible to inspect or repair that project offline.
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        this.manifests.clear();
        return;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(offset = 0): { artifacts: Array<{id:string; kind:string; filename:string}>; nextOffset?:number } {
    const entries=[...this.artifacts.values()];
    return {artifacts:entries.slice(offset,offset+20).map(({id,kind,filename})=>({id,kind,filename})),
      ...(offset+20<entries.length?{nextOffset:offset+20}:{})};
  }

  fetch(id: string, signal?: AbortSignal): Promise<{path:string; sha256:string; bytes:number; cached:boolean}> {
    const operation = this.pending.catch(()=>undefined).then(()=>this.fetchOne(id,signal));
    this.pending=operation;
    return operation;
  }

  matchesWorkspace(root: string): boolean { return pathKey(root) === pathKey(this.workspace.root); }

  private async persistBudget(): Promise<void> {
    if (!this.budgetPath) return;
    const file = await open(this.budgetPath, "a", 0o600);
    try { await file.writeFile(`${this.downloadedBytes}\n`); await file.sync(); } finally { await file.close(); }
  }

  private async fetchOne(id: string, signal?: AbortSignal): Promise<{path:string; sha256:string; bytes:number; cached:boolean}> {
    const entry=this.artifacts.get(id);
    if (!entry) throw new Error("Artifact is not in the trusted catalogue or initial dependency lock; ask the user to authorize it");
    if(entry.kind==="npm") for(const [filename,hash] of this.manifests) {
      const current=await this.workspace.pathGuard.resolveExisting(filename,{kind:"file",allowFinalSymlink:false});
      if(sha256(await readFile(current))!==hash) throw new Error("Dependency manifest changed; new downloads require a new trusted snapshot");
    }
    signal?.throwIfAborted();
    const cache=await ordinaryDirectory(this.cacheRoot);
    const objectPath=path.join(cache,sha256(entry.integrity));
    let bytes:Buffer|undefined, cached=false;
    try {
      const info=await lstat(objectPath);
      if(!info.isFile()||info.isSymbolicLink()||info.size>entry.maxBytes) throw new Error("Invalid cached artifact");
      bytes=await readFile(objectPath); verifyArtifact(bytes,entry.integrity); cached=true;
    } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
    if(!bytes) {
      if(this.downloadedBytes+entry.maxBytes>536870912) throw new Error("Download session byte budget exhausted");
      // Reserve before I/O, including failed downloads; retries cannot reset cost.
      this.downloadedBytes+=entry.maxBytes;
      await this.persistBudget();
      const timeout=AbortSignal.timeout(60000);
      const boundedSignal=signal?AbortSignal.any([signal,timeout]):timeout;
      let url=assertArtifactURL(entry.url);
      for(let hop=0;hop<=3;hop++) {
        const result=await requestBytes(url,entry.maxBytes,boundedSignal);
        if(result.bytes) {bytes=result.bytes;break;}
        url=approvedRedirect(url,result.redirect??"",entry.redirects);
      }
      if(!bytes) throw new Error("Artifact redirect limit exceeded");
      verifyArtifact(bytes,entry.integrity);
      this.downloadedBytes-=entry.maxBytes-bytes.length;
      await this.persistBudget();
      try { const handle=await open(objectPath,"wx",0o400); try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();} }
      catch(error) { if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error; verifyArtifact(await readFile(objectPath),entry.integrity); }
    }
    const relative=`vendor/downloads/${id}/${entry.filename}`;
    const destination=await this.workspace.pathGuard.resolveForCreate(relative,true);
    signal?.throwIfAborted();
    let created=false;
    try {const file=await open(destination,"wx",0o600);created=true;try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}
    catch(error) {if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      const safe=await this.workspace.pathGuard.resolveExisting(relative,{kind:"file",allowFinalSymlink:false});verifyArtifact(await readFile(safe),entry.integrity);}
    verifyArtifact(await readFile(await this.workspace.pathGuard.resolveExisting(relative,{kind:"file",allowFinalSymlink:false})),entry.integrity);
    const hash=sha256(bytes);
    if(created)this.workspace.recordChange({path:relative,operation:"create",afterHash:hash,source:"file_tool",status:"verified",timestamp:new Date().toISOString()});
    await this.workspace.refreshManifest();
    return {path:relative,sha256:hash,bytes:bytes.length,cached};
  }
}
