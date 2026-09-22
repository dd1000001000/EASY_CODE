import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  realpath,
  stat,
} from "node:fs/promises";
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { getEasyCodeHome } from "../prompt-bundle/paths.js";

export type ExistingPathKind = "file" | "directory" | "any";

export interface ResolveExistingOptions {
  kind?: ExistingPathKind;
  allowFinalSymlink?: boolean;
}

/** The path operations consumed by file tools and command resolution. */
export interface WorkspaceBoundary {
  readonly root: string;
  protectedPaths(): readonly string[];
  normalizeRelative(input: string): string;
  resolveLexical(input: string): string;
  resolveExisting(input: string, options?: ResolveExistingOptions): Promise<string>;
  resolveForCreate(input: string, createParents?: boolean): Promise<string>;
  toRelative(absolutePath: string): string;
  isAccessible(input: string): Promise<boolean>;
  assertInside(candidate: string): void;
  protect(root: string): void;
  rootForPath?(candidate: string): string;
}

function looksLikeAbsoluteOnAnotherPlatform(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)/.test(value);
}

function comparable(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(comparable(parent), comparable(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Central path boundary for every workspace operation.
 *
 * Lexical containment is checked first, followed by realpath containment for
 * every existing target/ancestor. The latter prevents a workspace symlink or
 * Windows junction from redirecting an operation outside the workspace.
 */
export class WorkspacePathGuard {
  readonly root: string;
  private readonly protectedRoots: string[] = [];

  /** Runtime-owned mount exclusions; callers cannot mutate the guard. */
  protectedPaths(): readonly string[] { return [...this.protectedRoots]; }

  constructor(workspaceRoot: string) {
    if (!workspaceRoot || workspaceRoot.includes("\0")) {
      throw new Error("A valid workspace root is required");
    }

    const absolute = path.resolve(workspaceRoot);
    if (/^(?:\\\\|\/\/)/u.test(workspaceRoot)) throw new Error("Network/device workspace roots are not supported by offline tools");
    let ancestor = path.parse(absolute).root;
    for (const segment of absolute.slice(ancestor.length).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, segment);
      if (lstatSync(ancestor).isSymbolicLink()) throw new Error("Workspace roots must not traverse symbolic links or junctions");
    }
    const info = realpathSync.native(absolute);
    if (!statSync(info).isDirectory()) {
      throw new Error("Workspace root must be a directory");
    }
    this.root = path.normalize(info);
    const home = path.dirname(getEasyCodeHome());
    this.protect(path.join(home, ".easy-code-uninstall.lock"));
    this.protect(path.join(home, ".easy-code-uninstall-state.json"));
  }

  normalizeRelative(input: string): string {
    if (typeof input !== "string" || input.length === 0) {
      throw new Error("Path must be a non-empty workspace-relative string");
    }
    if (input.includes("\0") || input.includes("\r") || input.includes("\n")) {
      throw new Error("Path contains forbidden control characters");
    }
    if (path.isAbsolute(input) || looksLikeAbsoluteOnAnotherPlatform(input)) {
      throw new Error("Absolute paths are not allowed; use a workspace-relative path");
    }

    // Treat both separators as boundaries even when tests emulate another OS.
    const segments = input.split(/[\\/]+/u);
    const significantSegments = segments.filter((segment) => segment && segment !== ".");
    if (segments.some((segment) => segment === "..")) {
      throw new Error("Parent-directory traversal is not allowed");
    }
    if (segments.some((segment) => segment.toLowerCase() === ".git")) {
      throw new Error("Git control paths are reserved for the EASY CODE Runtime");
    }
    if (significantSegments[0]?.toLowerCase() === ".easy-code-runtime") {
      throw new Error("Sandbox scratch paths are reserved for the EASY CODE Runtime");
    }
    if (
      significantSegments.length >= 2 &&
      significantSegments[0]?.toLowerCase() === ".easycode" &&
      significantSegments[1]?.toLowerCase() === "config.toml"
    ) {
      throw new Error("Workspace trust configuration cannot be accessed through agent file tools");
    }

    const absolute = path.resolve(this.root, input);
    this.assertInside(absolute);
    const relative = path.relative(this.root, absolute);
    if (!relative || relative === ".") {
      throw new Error("A file or subdirectory path is required, not the workspace root");
    }
    return relative.split(path.sep).join("/");
  }

  resolveLexical(input: string): string {
    const relative = this.normalizeRelative(input);
    const absolute = path.resolve(this.root, ...relative.split("/"));
    this.assertInside(absolute);
    return absolute;
  }

  async resolveExisting(
    input: string,
    options: ResolveExistingOptions = {},
  ): Promise<string> {
    const lexical = this.resolveLexical(input);
    await this.assertNoRedirectedAncestors(lexical);
    const linkInfo = await lstat(lexical);
    if (linkInfo.isSymbolicLink() && options.allowFinalSymlink === false) {
      throw new Error("Writing through a symbolic link is not allowed");
    }

    const canonical = path.normalize(await realpath(lexical));
    this.assertInside(canonical);

    const targetInfo = await stat(canonical);
    const kind = options.kind ?? "any";
    if (kind === "file" && !targetInfo.isFile()) {
      throw new Error("Path does not refer to a regular file");
    }
    if (kind === "directory" && !targetInfo.isDirectory()) {
      throw new Error("Path does not refer to a directory");
    }
    return canonical;
  }

  async resolveForCreate(input: string, createParents = true): Promise<string> {
    const target = this.resolveLexical(input);
    await this.assertNoRedirectedAncestors(target);
    const parent = path.dirname(target);
    await this.assertNearestExistingAncestorInside(parent);
    if (createParents) {
      await mkdir(parent, { recursive: true });
    }
    const canonicalParent = path.normalize(await realpath(parent));
    this.assertInside(canonicalParent);

    const finalTarget = path.join(canonicalParent, path.basename(target));
    this.assertInside(finalTarget);
    return finalTarget;
  }

  toRelative(absolutePath: string): string {
    this.assertInside(absolutePath);
    const relative = path.relative(this.root, absolutePath);
    return relative.split(path.sep).join("/");
  }

  async isAccessible(input: string): Promise<boolean> {
    try {
      const target = await this.resolveExisting(input);
      await access(target, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  assertInside(candidate: string): void {
    const root = comparable(this.root);
    const value = comparable(path.resolve(candidate));
    const relative = path.relative(root, value);
    if (this.protectedRoots.some(protectedRoot => isInsideOrEqual(protectedRoot, value))) {
      throw new Error("Runtime resources cannot be accessed through workspace tools");
    }
    if (relative === "") return;
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Resolved path escapes the workspace boundary");
    }
    if (isInsideOrEqual(getEasyCodeHome(), value)) {
      throw new Error(
        "Official EASY CODE Runtime resources cannot be accessed through agent workspace tools",
      );
    }
  }

  protect(root: string): void {
    this.protectedRoots.push(path.resolve(root));
  }

  rootForPath(candidate: string): string {
    this.assertInside(candidate);
    return this.root;
  }

  private async assertNoRedirectedAncestors(target: string): Promise<void> {
    let current = this.root;
    for (const segment of path.relative(this.root, target).split(path.sep)) {
      current = path.join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error("Symbolic link/junction access is rejected before traversal: target may escape the workspace boundary or initiate network access");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  private async assertNearestExistingAncestorInside(start: string): Promise<void> {
    let current = path.resolve(start);
    this.assertInside(current);

    while (true) {
      try {
        const canonical = path.normalize(await realpath(current));
        this.assertInside(canonical);
        const info = await stat(canonical);
        if (!info.isDirectory()) {
          throw new Error("An ancestor of the target is not a directory");
        }
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error("Could not find an existing workspace ancestor");
      }
      current = parent;
      this.assertInside(current);
    }
  }
}

export interface NamedWorkspaceRoot { readonly key: string; readonly path: string }

/**
 * Routes a namespaced logical path to one of several independent host roots.
 * With more than one root, paths must start with the stable folder key. No
 * symlinked aggregate directory is created, so OS and application boundaries
 * continue to protect the real folders directly.
 */
export class MultiRootPathGuard implements WorkspaceBoundary {
  readonly root: string;
  readonly roots: readonly NamedWorkspaceRoot[];
  private readonly guards: ReadonlyMap<string, WorkspacePathGuard>;
  private readonly primaryKey: string;

  constructor(roots: readonly NamedWorkspaceRoot[], primaryKey: string) {
    if (!roots.length) throw new Error("At least one workspace folder is required");
    const entries = roots.map(entry => {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(entry.key)) throw new Error(`Invalid workspace folder key: ${entry.key}`);
      return [entry.key, new WorkspacePathGuard(entry.path)] as const;
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Workspace folder keys must be unique");
    const primary = entries.find(([key]) => key === primaryKey);
    if (!primary) throw new Error("The primary workspace folder is missing");
    this.primaryKey = primaryKey;
    this.guards = new Map(entries);
    this.roots = entries.map(([key, guard]) => ({ key, path: guard.root }));
    this.root = primary[1].root;
  }

  protectedPaths(): readonly string[] {
    return [...this.guards.values()].flatMap(guard => guard.protectedPaths());
  }

  private route(input: string, requireChild = false): { key: string; guard: WorkspacePathGuard; inner: string } {
    if (typeof input !== "string" || !input.length || input.includes("\0") || input.includes("\r") || input.includes("\n"))
      throw new Error("Path must be a non-empty workspace-relative string");
    if (path.isAbsolute(input) || looksLikeAbsoluteOnAnotherPlatform(input))
      throw new Error("Absolute paths are not allowed; use a workspace-relative path");
    if (this.guards.size === 1) {
      const [key, guard] = [...this.guards][0]!;
      const segments = input.split(/[\\/]+/u).filter(segment => segment && segment !== ".");
      // Accept the previously persisted namespaced form when a multi-root
      // project is reduced to one folder, then normalize back to legacy paths.
      const innerInput = segments[0] === key && segments.length > 1
        ? segments.slice(1).join("/")
        : input;
      return { key, guard, inner: guard.normalizeRelative(innerInput) };
    }
    const segments = input.split(/[\\/]+/u).filter(segment => segment && segment !== ".");
    let key = segments[0];
    let guard = key ? this.guards.get(key) : undefined;
    // Paths recorded while a project had one folder remain valid after a
    // second folder is attached: an unqualified path still means primary.
    // New paths are normalized to the explicit key before persistence.
    if (!guard) {
      key = this.primaryKey;
      guard = this.guards.get(key)!;
    } else {
      segments.shift();
    }
    if (!key) throw new Error(`Path must identify a project folder (${[...this.guards.keys()].join(", ")})`);
    if (!segments.length) {
      if (requireChild) throw new Error("A file or subdirectory path is required after the folder key");
      return { key, guard, inner: "" };
    }
    const inner = guard.normalizeRelative(segments.join("/"));
    return { key, guard, inner };
  }

  normalizeRelative(input: string): string {
    const routed = this.route(input);
    return this.guards.size === 1 ? routed.inner : routed.inner ? `${routed.key}/${routed.inner}` : routed.key;
  }

  resolveLexical(input: string): string {
    const routed = this.route(input, true);
    return routed.guard.resolveLexical(routed.inner);
  }

  async resolveExisting(input: string, options: ResolveExistingOptions = {}): Promise<string> {
    const routed = this.route(input);
    if (!routed.inner) {
      if (options.kind === "file") throw new Error("Path does not refer to a regular file");
      return routed.guard.root;
    }
    return routed.guard.resolveExisting(routed.inner, options);
  }

  async resolveForCreate(input: string, createParents = true): Promise<string> {
    const routed = this.route(input, true);
    return routed.guard.resolveForCreate(routed.inner, createParents);
  }

  toRelative(absolutePath: string): string {
    const normalized = path.resolve(absolutePath);
    for (const [key, guard] of this.guards) {
      try {
        guard.assertInside(normalized);
        const inner = path.relative(guard.root, normalized).split(path.sep).join("/");
        return this.guards.size === 1 ? inner || "." : inner ? `${key}/${inner}` : key;
      } catch {
        // Try the next root.
      }
    }
    throw new Error("Resolved path escapes every project folder boundary");
  }

  async isAccessible(input: string): Promise<boolean> {
    try {
      const target = await this.resolveExisting(input);
      await access(target, constants.R_OK);
      return true;
    } catch { return false; }
  }

  assertInside(candidate: string): void {
    for (const guard of this.guards.values()) {
      try { guard.assertInside(candidate); return; } catch { /* continue */ }
    }
    throw new Error("Resolved path escapes every project folder boundary");
  }

  protect(root: string): void { for (const guard of this.guards.values()) guard.protect(root); }

  rootForPath(candidate: string): string {
    for (const guard of this.guards.values()) {
      try { guard.assertInside(candidate); return guard.root; } catch { /* continue */ }
    }
    throw new Error("Resolved path escapes every project folder boundary");
  }
}
