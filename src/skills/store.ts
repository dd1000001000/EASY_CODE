import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "../utils/hash.js";
import { assertSkillName, createSkillMarkdown, parseSkillMarkdown, SKILL_DIRECTORY_NAME } from "./format.js";

export type SkillScope = "user" | "project";

export interface SkillSummary {
  readonly scope: SkillScope;
  readonly name: string;
  readonly description: string;
  readonly directory: string;
  readonly contentHash: string;
}

export interface SkillListing {
  readonly user: readonly SkillSummary[];
  readonly project: readonly SkillSummary[];
  readonly warnings: readonly string[];
  readonly userDirectory: string;
  readonly projectDirectory: string;
}

export interface SkillRead {
  readonly scope: SkillScope;
  readonly name: string;
  readonly directory: string;
  readonly relativePath: string;
  readonly content: string;
  readonly version: string;
  readonly files: readonly string[];
}

export interface SkillFile {
  readonly path: string;
  readonly content: string;
}

export interface SkillFileChange {
  readonly operation: "upsert" | "remove";
  readonly path: string;
  readonly content?: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function samePath(left: string, right: string): boolean {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inside(parent: string, candidate: string): boolean {
  const base = process.platform === "win32" ? parent.toLowerCase() : parent;
  const target = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = path.relative(base, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function memberPath(value: string): string {
  if (!value || path.isAbsolute(value) || /^(?:[A-Za-z]:|[\\/]{2})/u.test(value)) {
    throw new Error("Skill file path must be relative to the skill directory");
  }
  const segments = value.split(/[\\/]/u);
  if (segments.some(part => !part || part === "." || part === ".." || /[:\u0000-\u001f\u007f]/u.test(part) ||
      /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error("Skill file path contains an unsafe segment");
  }
  return segments.join("/");
}

async function assertRealDirectory(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Skill path is not a real directory: ${directory}`);
    const expected = path.join(await realpath(path.dirname(directory)), path.basename(directory));
    if (!samePath(await realpath(directory), expected)) throw new Error(`Skill directory redirects elsewhere: ${directory}`);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function ensureRoot(directory: string): Promise<void> {
  if (await assertRealDirectory(directory)) return;
  await mkdir(directory, { recursive: true });
  if (!await assertRealDirectory(directory)) throw new Error(`Could not create skill directory ${directory}`);
}

async function assertNoLinks(directory: string, root: string): Promise<void> {
  if (!inside(root, directory)) throw new Error("Skill path escapes its resource root");
  let current = root;
  if (!await assertRealDirectory(root)) throw new Error("Skill resource root is missing");
  const relative = path.relative(root, directory);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Skill path contains a symlink or junction: ${current}`);
    const expected = path.join(await realpath(path.dirname(current)), path.basename(current));
    if (!samePath(await realpath(current), expected)) throw new Error(`Skill path redirects elsewhere: ${current}`);
  }
}

async function treeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      const expected = path.join(await realpath(directory), entry.name);
      if (info.isSymbolicLink() || !samePath(await realpath(absolute), expected)) {
        throw new Error(`Skill contains a symlink or junction: ${relative}`);
      }
      if (info.isDirectory()) await visit(absolute, relative);
      else if (info.isFile()) files.push(relative);
      else throw new Error(`Skill contains an unsupported entry: ${relative}`);
    }
  }
  await visit(root, "");
  return files.sort();
}

async function treeVersion(root: string, files: readonly string[]): Promise<string> {
  const digest = createHash("sha256");
  for (const relative of files) {
    digest.update(relative).update("\0");
    const absolute = path.join(root, ...relative.split("/"));
    for await (const chunk of createReadStream(absolute)) digest.update(chunk as Buffer);
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function currentVersion(root: string): Promise<string> {
  return treeVersion(root, await treeFiles(root));
}

/** Durable, path-scoped Skill resources; no Thread ID participates in identity or storage. */
export class SkillStore {
  private projectRootPromise: Promise<string> | undefined;

  constructor(
    private readonly workspaceRoot: string,
    private readonly userHome: string = os.homedir(),
    private readonly trashDirectory: string = path.join(os.homedir(), ".easy_code", "skill-trash"),
  ) {}

  async projectRoot(): Promise<string> {
    if (!this.projectRootPromise) this.projectRootPromise = this.findProjectRoot();
    return this.projectRootPromise;
  }

  private async findProjectRoot(): Promise<string> {
    const workspace = path.normalize(await realpath(path.resolve(this.workspaceRoot)));
    let candidate = workspace;
    for (;;) {
      try {
        const info = await lstat(path.join(candidate, ".git"));
        if (info.isDirectory() || info.isFile()) return candidate;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) return workspace;
      candidate = parent;
    }
  }

  async directory(scope: SkillScope): Promise<string> {
    const parent = scope === "project"
      ? await this.projectRoot()
      : path.normalize(await realpath(path.resolve(this.userHome)));
    return path.join(parent, SKILL_DIRECTORY_NAME);
  }

  private async skillPath(scope: SkillScope, name: string): Promise<{ root: string; target: string }> {
    assertSkillName(name);
    const root = await this.directory(scope);
    const target = path.join(root, name);
    if (!inside(root, target)) throw new Error("Skill path escapes its resource root");
    return { root, target };
  }

  async list(): Promise<SkillListing> {
    const [userDirectory, projectDirectory] = await Promise.all([
      this.directory("user"), this.directory("project"),
    ]);
    const warnings: string[] = [];
    const listScope = async (scope: SkillScope, root: string): Promise<SkillSummary[]> => {
      try {
        if (!await assertRealDirectory(root)) return [];
      } catch (error) {
        warnings.push(`${scope}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
      const summaries: SkillSummary[] = [];
      for (const entry of await readdir(root)) {
        const match = /^\.backup-([a-z][a-z0-9_-]{0,63})-[0-9a-f-]{36}$/u.exec(entry);
        if (!match) continue;
        try {
          await this.recoverMissingSkill(root, path.join(root, match[1]!), match[1]!);
        } catch (error) {
          warnings.push(`${scope}/${match[1]}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        try {
          assertSkillName(entry.name);
          const target = path.join(root, entry.name);
          await assertNoLinks(target, root);
          const files = await treeFiles(target);
          if (!files.includes("SKILL.md")) throw new Error("Skill has no SKILL.md");
          const markdown = await readFile(path.join(target, "SKILL.md"), "utf8");
          const metadata = parseSkillMarkdown(markdown, entry.name);
          summaries.push({ scope, name: entry.name, description: metadata.description,
            directory: target, contentHash: sha256(Buffer.from(markdown, "utf8")) });
        } catch (error) {
          warnings.push(`${scope}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return summaries.sort((a, b) => a.name.localeCompare(b.name));
    };
    const [user, project] = await Promise.all([
      listScope("user", userDirectory), listScope("project", projectDirectory),
    ]);
    return { user, project, warnings, userDirectory, projectDirectory };
  }

  async read(scope: SkillScope, name: string, requestedPath = "SKILL.md"): Promise<SkillRead> {
    const { root, target } = await this.skillPath(scope, name);
    await this.recoverMissingSkill(root, target, name);
    await assertNoLinks(target, root);
    const files = await treeFiles(target);
    if (!files.includes("SKILL.md")) throw new Error(`Skill ${scope}/${name} has no SKILL.md`);
    const markdown = await readFile(path.join(target, "SKILL.md"), "utf8");
    parseSkillMarkdown(markdown, name);
    const relativePath = memberPath(requestedPath);
    if (!files.includes(relativePath)) throw new Error(`Skill file does not exist: ${relativePath}`);
    const content = await readFile(path.join(target, ...relativePath.split("/")));
    if (content.includes(0)) throw new Error("Binary skill resources cannot be read as text");
    return { scope, name, directory: target, relativePath, content: content.toString("utf8"),
      version: await treeVersion(target, files), files };
  }

  async create(scope: SkillScope, name: string, description: string, instructions: string,
    files: readonly SkillFile[] = [], signal?: AbortSignal): Promise<SkillRead> {
    const { root, target } = await this.skillPath(scope, name);
    await ensureRoot(root);
    await this.recoverMissingSkill(root, target, name);
    return this.withLock(root, name, signal, async () => {
      if (await assertRealDirectory(target)) throw new Error(`Skill ${scope}/${name} already exists`);
      const stage = path.join(root, `.staging-${name}-${randomUUID()}`);
      await mkdir(stage);
      try {
        await writeFile(path.join(stage, "SKILL.md"), createSkillMarkdown(name, description, instructions), { flag: "wx" });
        const seen = new Set<string>(["SKILL.md"]);
        for (const file of files) {
          const relative = memberPath(file.path);
          if (seen.has(relative)) throw new Error(`Duplicate skill file: ${relative}`);
          seen.add(relative);
          const filename = path.join(stage, ...relative.split("/"));
          await mkdir(path.dirname(filename), { recursive: true });
          await writeFile(filename, file.content, { flag: "wx" });
        }
        signal?.throwIfAborted();
        await rename(stage, target);
      } finally {
        if (await assertRealDirectory(stage)) await rm(stage, { recursive: true });
      }
      return this.read(scope, name);
    });
  }

  async modify(scope: SkillScope, name: string, expectedVersion: string,
    markdown: string | undefined, changes: readonly SkillFileChange[] = [],
    signal?: AbortSignal): Promise<SkillRead> {
    const { root, target } = await this.skillPath(scope, name);
    if (markdown === undefined && changes.length === 0) throw new Error("No Skill changes were supplied");
    await this.recoverMissingSkill(root, target, name);
    return this.withLock(root, name, signal, async () => {
      const original = await this.read(scope, name);
      if (original.version !== expectedVersion) throw new Error("Skill changed since it was read; read it again");
      const stage = path.join(root, `.staging-${name}-${randomUUID()}`);
      const backup = path.join(root, `.backup-${name}-${randomUUID()}`);
      await cp(target, stage, { recursive: true, errorOnExist: true, force: false });
      try {
        if (markdown !== undefined) {
          parseSkillMarkdown(markdown, name);
          await writeFile(path.join(stage, "SKILL.md"), markdown);
        }
        const seen = new Set<string>();
        for (const change of changes) {
          const relative = memberPath(change.path);
          if (relative === "SKILL.md" || seen.has(relative)) {
            throw new Error(`Use skillMarkdown for SKILL.md; duplicate or invalid change: ${relative}`);
          }
          seen.add(relative);
          const filename = path.join(stage, ...relative.split("/"));
          if (change.operation === "remove") {
            if (change.content !== undefined) throw new Error("Removed file must not provide content");
            await unlink(filename);
          } else {
            if (change.content === undefined) throw new Error("Upserted file needs content");
            await mkdir(path.dirname(filename), { recursive: true });
            await writeFile(filename, change.content);
          }
        }
        const stagedFiles = await treeFiles(stage);
        parseSkillMarkdown(await readFile(path.join(stage, "SKILL.md"), "utf8"), name);
        if (await currentVersion(target) !== expectedVersion) {
          throw new Error("Skill changed while the update was prepared; read it again");
        }
        if (await treeVersion(stage, stagedFiles) === expectedVersion) throw new Error("Skill update made no changes");
        signal?.throwIfAborted();
        await rename(target, backup);
        try {
          await rename(stage, target);
        } catch (error) {
          await rename(backup, target);
          throw error;
        }
        await rm(backup, { recursive: true }).catch(() => undefined);
      } finally {
        if (await assertRealDirectory(stage)) await rm(stage, { recursive: true });
      }
      return this.read(scope, name);
    });
  }

  async delete(scope: SkillScope, name: string, expectedVersion: string,
    signal?: AbortSignal): Promise<{ archivedAt: string; version: string }> {
    const { root, target } = await this.skillPath(scope, name);
    await this.recoverMissingSkill(root, target, name);
    return this.withLock(root, name, signal, async () => {
      const original = await this.read(scope, name);
      if (original.version !== expectedVersion) throw new Error("Skill changed since it was read; read it again");
      const configuredTrashRoot = path.resolve(this.trashDirectory);
      await ensureRoot(configuredTrashRoot);
      const trashRoot = await realpath(configuredTrashRoot);
      const archive = path.join(trashRoot, `${scope}-${name}-${randomUUID()}`);
      if (!inside(trashRoot, archive)) throw new Error("Skill archive escapes its trash root");
      if (await currentVersion(target) !== expectedVersion) {
        throw new Error("Skill changed while deletion was prepared; read it again");
      }
      signal?.throwIfAborted();
      try {
        await rename(target, archive);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw error;
        await cp(target, archive, { recursive: true, errorOnExist: true, force: false });
        if (await treeVersion(archive, await treeFiles(archive)) !== expectedVersion) {
          throw new Error("Skill archive verification failed; original was retained");
        }
        await assertNoLinks(target, root);
        if (await currentVersion(target) !== expectedVersion) {
          throw new Error("Skill changed before deletion; original was retained");
        }
        await rm(target, { recursive: true });
      }
      return { archivedAt: archive, version: expectedVersion };
    });
  }

  private async withLock<T>(root: string, name: string, signal: AbortSignal | undefined,
    action: () => Promise<T>): Promise<T> {
    const lockPath = path.join(root, `.lock-${name}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      signal?.throwIfAborted();
      try {
        handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
        } catch (error) {
          await handle.close();
          handle = undefined;
          await unlink(lockPath);
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        if (await this.reapDeadLock(lockPath)) continue;
        if (attempt === 99) throw new Error(`Skill ${name} is locked by another operation`);
        await delay(50, undefined, { signal });
      }
    }
    if (!handle) throw new Error("Could not acquire Skill mutation lock");
    try {
      return await action();
    } finally {
      await handle.close();
      await unlink(lockPath);
    }
  }

  private async reapDeadLock(lockPath: string): Promise<boolean> {
    try {
      const info = await lstat(lockPath);
      if (!info.isFile() || info.isSymbolicLink() || Date.now() - info.mtimeMs < 1_000) return false;
      let owner: { pid?: number };
      try { owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number }; }
      catch { owner = {}; }
      if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
        }
      } else if (Date.now() - info.mtimeMs < 60_000) return false;
      const latest = await lstat(lockPath);
      if (latest.mtimeMs !== info.mtimeMs || latest.ino !== info.ino) return false;
      await unlink(lockPath);
      return true;
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
  }

  private async recoverMissingSkill(root: string, target: string, name: string): Promise<void> {
    if (await assertRealDirectory(target) || !await assertRealDirectory(root)) return;
    const prefix = `.backup-${name}-`;
    const backups = (await readdir(root)).filter(entry => entry.startsWith(prefix));
    if (backups.length === 0) return;
    await this.withLock(root, name, undefined, async () => {
      if (await assertRealDirectory(target)) return;
      const candidates = (await readdir(root)).filter(entry => entry.startsWith(prefix));
      if (candidates.length !== 1) {
        throw new Error(`Skill ${name} has multiple interrupted updates; restore one backup manually`);
      }
      const backup = path.join(root, candidates[0]!);
      await assertNoLinks(backup, root);
      await treeFiles(backup);
      await rename(backup, target);
    });
  }
}
