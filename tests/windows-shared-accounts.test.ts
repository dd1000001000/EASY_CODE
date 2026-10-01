import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertProjectSandboxReady } from "../src/sandbox/project-readiness.js";
import { otherCodexHomes, reconcileWindowsSandboxAccounts } from "../src/sandbox/windows-shared-accounts.js";
import { describe, it } from "./harness.js";

const earlier = new Date("2026-10-01T05:00:00Z");
const later = new Date("2026-10-01T17:00:00Z");

function usersJson(password: string, version = 5): string {
  return JSON.stringify({
    version,
    offline: { username: "CodexSandboxOffline", password: `${password}-offline` },
    online: { username: "CodexSandboxOnline", password: `${password}-online` },
  });
}

const usersFile = (home: string) => path.join(home, ".sandbox-secrets", "sandbox_users.json");

async function writeUsers(home: string, content: string, when: Date): Promise<void> {
  await mkdir(path.dirname(usersFile(home)), { recursive: true });
  await writeFile(usersFile(home), content);
  await utimes(usersFile(home), when, when);
}

async function withHomes(run: (ours: string, desktop: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-shared-accounts-"));
  try {
    await run(path.join(root, "easy-code-home"), path.join(root, ".codex"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Windows sandbox accounts shared with other Codex installs", () => {
  it("hands EASY CODE's newer setup to the other Codex home without making it look newer", async () => {
    await withHomes(async (ours, desktop) => {
      await writeUsers(ours, usersJson("easy"), later);
      await writeUsers(desktop, usersJson("desktop"), earlier);

      assert.deepEqual(await reconcileWindowsSandboxAccounts(ours, [desktop]), { kind: "current" });
      assert.equal(await readFile(usersFile(desktop), "utf8"), usersJson("easy"));
      assert.equal((await stat(usersFile(desktop))).mtimeMs, later.getTime());
      // Once both hold the same credentials nothing changes.
      assert.deepEqual(await reconcileWindowsSandboxAccounts(ours, [desktop]), { kind: "current" });
    });
  });

  it("reports a newer setup made by another Codex and keeps EASY CODE's file", async () => {
    await withHomes(async (ours, desktop) => {
      await writeUsers(ours, usersJson("easy"), earlier);
      await writeUsers(desktop, usersJson("desktop"), later);

      const state = await reconcileWindowsSandboxAccounts(ours, [desktop]);
      assert.equal(state.kind, "reset_elsewhere");
      assert.equal(state.kind === "reset_elsewhere" && state.home, desktop);
      assert.equal(state.kind === "reset_elsewhere" && state.at.getTime(), later.getTime());
      assert.equal(await readFile(usersFile(ours), "utf8"), usersJson("easy"));
      assert.equal(await readFile(usersFile(desktop), "utf8"), usersJson("desktop"));
    });
  });

  it("leaves homes alone that were never set up or use another credential format", async () => {
    await withHomes(async (ours, desktop) => {
      await writeUsers(ours, usersJson("easy"), later);
      assert.deepEqual(await reconcileWindowsSandboxAccounts(ours, [desktop]), { kind: "current" });

      await writeUsers(desktop, usersJson("desktop", 6), earlier);
      assert.deepEqual(await reconcileWindowsSandboxAccounts(ours, [desktop]), { kind: "current" });
      assert.equal(await readFile(usersFile(desktop), "utf8"), usersJson("desktop", 6));

      await writeUsers(desktop, "not json", earlier);
      assert.deepEqual(await reconcileWindowsSandboxAccounts(ours, [desktop]), { kind: "current" });
      assert.equal(await readFile(usersFile(desktop), "utf8"), "not json");
    });
  });

  it("does nothing before EASY CODE's own setup and never compares a home with itself", async () => {
    await withHomes(async (ours, desktop) => {
      await writeUsers(desktop, usersJson("desktop"), later);
      assert.deepEqual(await reconcileWindowsSandboxAccounts(ours, [desktop]), { kind: "current" });

      await writeUsers(ours, usersJson("easy"), earlier);
      assert.deepEqual(await reconcileWindowsSandboxAccounts(ours, [ours]), { kind: "current" });
    });
  });

  it("looks at CODEX_HOME and the default ~/.codex", () => {
    const configured = path.join(os.tmpdir(), "custom-codex-home");
    assert.deepEqual(otherCodexHomes({ CODEX_HOME: configured }), [
      path.resolve(configured),
      path.join(os.homedir(), ".codex"),
    ]);
    assert.deepEqual(otherCodexHomes({}), [path.join(os.homedir(), ".codex")]);
    assert.deepEqual(otherCodexHomes({ CODEX_HOME: configured, EASY_CODE_SHARE_SANDBOX_ACCOUNTS: "off" }), []);
  });

  it("refuses a command, instead of letting Codex start an elevated setup, after another install's setup", async () => {
    await withHomes(async (ours, desktop) => {
      await writeUsers(ours, usersJson("easy"), earlier);
      await writeUsers(desktop, usersJson("desktop"), later);
      const service = { request: async () => ({ status: "ready" }) };

      await assert.rejects(
        assertProjectSandboxReady(service, 1_000, ours, "win32", [desktop]),
        /Project sandbox is not ready: Another Codex installation .* re-ran Windows sandbox setup/u,
      );
      // Not on other platforms, where the accounts do not exist.
      await assertProjectSandboxReady(service, 1_000, ours, "linux", [desktop]);
      // After EASY CODE's own setup the command runs and the other home is brought up to date.
      await writeUsers(ours, usersJson("easy-again"), new Date(later.getTime() + 60_000));
      await assertProjectSandboxReady(service, 1_000, ours, "win32", [desktop]);
      assert.equal(await readFile(usersFile(desktop), "utf8"), usersJson("easy-again"));
    });
  });
});
