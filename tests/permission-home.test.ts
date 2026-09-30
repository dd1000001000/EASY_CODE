import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureNativeProjectPermissionHome } from "../src/sandbox/permission-home.js";
import { describe, it } from "./harness.js";

async function withBaseHome(run: (baseHome: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-permission-home-"));
  try {
    await run(path.join(root, "runtime-home-v2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeAt(file: string, content: string, when: Date): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await utimes(file, when, when);
}

const users = (home: string) => path.join(home, ".sandbox-secrets", "sandbox_users.json");
const marker = (home: string) => path.join(home, ".sandbox", "setup_marker.json");
const earlier = new Date("2026-09-29T00:00:00Z");
const later = new Date("2026-09-30T00:00:00Z");

describe("native project permission home", () => {
  it("reuses the base Windows sandbox credentials and marker for a new project", async () => {
    await withBaseHome(async (baseHome) => {
      await writeAt(users(baseHome), "base-users", earlier);
      await writeAt(marker(baseHome), "base-marker", earlier);

      const home = await ensureNativeProjectPermissionHome(baseHome, [path.join(baseHome, "project")], "win32");

      assert.ok((await lstat(path.join(home, ".sandbox-secrets"))).isSymbolicLink());
      assert.equal(await readFile(users(home), "utf8"), "base-users");
      assert.equal(await readFile(marker(home), "utf8"), "base-marker");
      assert.equal((await stat(marker(home))).mtimeMs, earlier.getTime());

      // A setup that runs from the project home writes through to the shared credentials.
      await writeFile(users(home), "rotated-users");
      assert.equal(await readFile(users(baseHome), "utf8"), "rotated-users");
      await ensureNativeProjectPermissionHome(baseHome, [path.join(baseHome, "project")], "win32");
      assert.ok((await lstat(path.join(home, ".sandbox-secrets"))).isSymbolicLink());
    });
  });

  it("adopts the most recently provisioned legacy credentials and marker", async () => {
    await withBaseHome(async (baseHome) => {
      const roots = [path.join(baseHome, "project")];
      await writeAt(users(baseHome), "stale-base-users", earlier);
      await writeAt(marker(baseHome), "stale-base-marker", earlier);
      const home = await ensureNativeProjectPermissionHome(baseHome, roots, "linux");
      await writeAt(users(home), "live-project-users", later);
      await writeAt(marker(home), "live-project-marker", later);

      await ensureNativeProjectPermissionHome(baseHome, roots, "win32");

      assert.ok((await lstat(path.join(home, ".sandbox-secrets"))).isSymbolicLink());
      assert.equal(await readFile(users(baseHome), "utf8"), "live-project-users");
      assert.equal(await readFile(marker(baseHome), "utf8"), "live-project-marker");
      assert.deepEqual(
        (await readdir(home)).filter((name) => name.startsWith(".sandbox-secrets.")),
        [],
        "retired legacy credentials are removed",
      );
    });
  });

  it("keeps newer base credentials over an outdated legacy project copy", async () => {
    await withBaseHome(async (baseHome) => {
      const roots = [path.join(baseHome, "project")];
      await writeAt(users(baseHome), "live-base-users", later);
      const home = await ensureNativeProjectPermissionHome(baseHome, roots, "linux");
      await writeAt(users(home), "stale-project-users", earlier);

      await ensureNativeProjectPermissionHome(baseHome, roots, "win32");

      assert.equal(await readFile(users(baseHome), "utf8"), "live-base-users");
      assert.equal(await readFile(users(home), "utf8"), "live-base-users");
    });
  });

  it("leaves non-Windows project homes self-contained", async () => {
    await withBaseHome(async (baseHome) => {
      await writeAt(users(baseHome), "base-users", earlier);
      const home = await ensureNativeProjectPermissionHome(baseHome, [path.join(baseHome, "project")], "linux");
      await assert.rejects(access(path.join(home, ".sandbox-secrets")), { code: "ENOENT" });
    });
  });
});
