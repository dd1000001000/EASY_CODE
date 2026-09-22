import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SandboxFailure } from "./failure.js";
import { nativeProjectPermissionConfig } from "./native-policy.js";

/** Create one immutable Codex home for the exact logical-project root set. */
export async function ensureNativeProjectPermissionHome(
  baseHome: string,
  writableRoots: readonly string[],
): Promise<string> {
  const profile = nativeProjectPermissionConfig(writableRoots);
  const identity = createHash("sha256").update(profile).digest("hex").slice(0, 20);
  const home = path.join(baseHome, `project-home-v3-${identity}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const configPath = path.join(home, "config.toml");
  try {
    await writeFile(configPath, profile, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(configPath, "utf8") !== profile) {
      throw new SandboxFailure("state_persistence", "Project sandbox permission profile could not be safely initialized");
    }
  }
  return home;
}
