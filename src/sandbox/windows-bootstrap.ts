import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function hasRetiredSrtDenyAcl(icaclsOutput: string): boolean {
  return /srt-sandbox/iu.test(icaclsOutput);
}

export function retiredSrtAccount(environment: NodeJS.ProcessEnv): string {
  return environment.COMPUTERNAME
    ? `${environment.COMPUTERNAME}\\srt-sandbox`
    : "srt-sandbox";
}

function icaclsEntrypoint(environment: NodeJS.ProcessEnv): string {
  return path.join(environment.SystemRoot ?? environment.WINDIR ?? "C:\\Windows", "System32", "icacls.exe");
}

async function runIcacls(executable: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(executable, [...args], {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

/**
 * Keep the private native-sandbox state from inheriting ACLs installed by the
 * retired SRT backend. The migration is deliberately limited to EASY CODE's
 * own native-sandbox directory; it never edits the user profile ACL or removes
 * the shared legacy account.
 */
export async function prepareWindowsSandboxStorage(
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ legacyAclRemoved: boolean }> {
  if (process.platform !== "win32") return { legacyAclRemoved: false };
  const ownedRoot = path.dirname(home);
  await mkdir(ownedRoot, { recursive: true, mode: 0o700 });
  const executable = icaclsEntrypoint(environment);
  const before = await runIcacls(executable, [ownedRoot]);
  if (!hasRetiredSrtDenyAcl(before)) return { legacyAclRemoved: false };

  // Convert inherited entries to explicit entries before removing only the
  // retired sandbox account's deny ACE. This preserves the user's, SYSTEM's,
  // and Administrators' existing rights.
  await runIcacls(executable, [ownedRoot, "/inheritance:d"]);
  await runIcacls(executable, [ownedRoot, "/remove:d", retiredSrtAccount(environment)]);
  const after = await runIcacls(executable, [ownedRoot]);
  if (hasRetiredSrtDenyAcl(after)) {
    throw new Error(`Legacy sandbox deny ACL could not be removed from ${ownedRoot}`);
  }
  return { legacyAclRemoved: true };
}
