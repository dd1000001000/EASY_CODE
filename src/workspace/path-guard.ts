import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  realpath,
  stat,
} from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { getEasyCodeHome } from "../prompt-bundle/paths.js";

export type ExistingPathKind = "file" | "directory" | "any";

export interface ResolveExistingOptions {
  kind?: ExistingPathKind;
  allowFinalSymlink?: boolean;
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

  constructor(workspaceRoot: string) {
    if (!workspaceRoot || workspaceRoot.includes("\0")) {
      throw new Error("A valid workspace root is required");
    }

    const absolute = path.resolve(workspaceRoot);
    const info = realpathSync.native(absolute);
    if (!statSync(info).isDirectory()) {
      throw new Error("Workspace root must be a directory");
    }
    this.root = path.normalize(info);
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
    if (significantSegments[0]?.toLowerCase() === ".easy-code-srt-runtime") {
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
