import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNoUninstall, assertPlainAncestors } from "../install/ownership.js";

/** Serialize npm, startup and explicit setup without changing another VM. */
export async function withPodmanSetupLock<T>(action: () => Promise<T>, timeoutMs: number,
  home = os.homedir()): Promise<T> {
  const directory = path.join(home, ".easy_code");
  const file = path.join(directory, "podman-setup.lock");
  assertNoUninstall(home); assertPlainAncestors(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    assertNoUninstall(home);
    try { handle = await open(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const content = await readFile(file, "utf8").catch(() => "");
      let owner;
      try { owner = JSON.parse(content); } catch { /* another writer may be initializing it */ }
      if (owner?.hostname === os.hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH" && await readFile(file, "utf8").catch(() => "") === content) {
            await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
            continue;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error(`Another Podman setup is running or its state is unknown: ${file}. Wait for it to finish; no installation was replayed.`);
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: os.hostname(), token }));
    assertNoUninstall(home);
    return await action();
  } finally {
    await handle.close();
    const owner = await readFile(file, "utf8").then(JSON.parse).catch(() => undefined);
    if (owner?.token === token) await unlink(file);
  }
}
