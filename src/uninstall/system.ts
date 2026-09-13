import { execa } from "execa";
import os from "node:os";
import { podmanEnvironment } from "../sandbox/podman-client.js";
export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export type SystemRunner = (program: string, args: string[], cwd?: string) => Promise<CommandResult>;
export const createSystemRunner = (environment: NodeJS.ProcessEnv): SystemRunner => async (program, args, cwd = os.tmpdir()) => {
  const result = await execa(program, args, { cwd, env: environment, extendEnv: false,
    shell: false, windowsHide: true, reject: false, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  return { exitCode: result.exitCode ?? 125, stdout: result.stdout, stderr: result.stderr };
};
export const runSystem: SystemRunner = (program, args, cwd) => createSystemRunner(podmanEnvironment())(program, args, cwd);
export async function checked(run: SystemRunner, program: string, args: string[], cwd?: string): Promise<string> {
  const result = await run(program, args, cwd);
  if (result.exitCode !== 0) throw new Error(program + " " + args.slice(0, 2).join(" ") + " failed: " + (result.stderr || result.stdout).slice(-1600));
  return result.stdout.trim();
}
export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
