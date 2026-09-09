import path from "node:path";
import { access } from "node:fs/promises";
import type { ReviewParticipant } from "./driver.js";
import { ReviewCleanupError } from "./errors.js";

/** Capability check, not a test verdict. Goes through the same command approval
 * and isolation boundary as every participant command. Never installs anything. */
export async function preflightReviewEnvironment(p: ReviewParticipant): Promise<void> {
  const root = p.context.workspaceRoot;
  const exists = async (name: string) => access(path.join(root, name)).then(() => true, () => false);
  let program: string | undefined, args: string[] = ["--version"];
  if (await exists("package.json")) program = "node";
  else if (await exists("pyproject.toml") || await exists("setup.py") || await exists("manage.py")) {
    program = "python";
    for (const venv of [".venv", "venv"]) {
      const executable = path.join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      if (await exists(executable)) {
        program = path.join(root, executable);
        args = ["-c", "import os,sys; assert os.path.realpath(sys.prefix)==os.path.realpath(sys.argv[1]), 'Non-relocatable review venv'", path.join(root, venv)];
        break;
      }
    }
  } else if (await exists("Cargo.toml")) program = "cargo";
  else if (await exists("go.mod")) { program = "go"; args = ["version"]; }
  if (!program) return; // Unknown project: no fabricated environment guarantee.
  const tool = p.tools.find(t => t.name === "run_command");
  if (!tool) throw new Error("Review execution tool unavailable");
  const command = { program, args, cwd: ".", intent: "inspect", timeoutMs: 30000,
    reason: "Check the private review interpreter/toolchain; no installation or test verdict." };
  await p.append("review.environment.command", command);
  const result = await tool.execute(command, p.context);
  await p.append("review.environment.result", result);
  const data = result.data as { lifecycle?: { cleanup?: string } } | undefined;
  if (["failed", "unconfirmed"].includes(data?.lifecycle?.cleanup ?? "")) throw new ReviewCleanupError(result.summary);
  if (!result.ok) throw new Error(`Review environment preflight unavailable: ${result.summary}`);
}
