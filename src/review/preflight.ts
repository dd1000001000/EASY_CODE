import path from "node:path";
import { access } from "node:fs/promises";
import type { ReviewParticipant } from "./driver.js";
import { ReviewCleanupError } from "./errors.js";

/** Capability check, not a test verdict. Goes through the same command approval
 * and isolation boundary as every participant command. Never installs anything. */
export async function preflightReviewEnvironment(p: ReviewParticipant, containerRoot?: string): Promise<void> {
  const root = p.context.workspaceRoot;
  const exists = async (name: string) => access(path.join(root, name)).then(() => true, () => false);
  let program: string | undefined, args: string[] = ["--version"];
  if (await exists("package.json")) program = "node";
  else if (await exists("pyproject.toml") || await exists("setup.py") || await exists("manage.py")) {
    program = containerRoot ? "python3" : "python";
    if (containerRoot) {
      // The dependency volumes are not host directories. Discover interpreters
      // inside the approved command's container, never through host realpath.
      args = ["-I", "-c", "import os,subprocess,sys\nfor name in ('.venv','venv'):\n p=os.path.join(os.getcwd(),name)\n exe=os.path.join(p,'bin','python')\n if os.path.isfile(exe):\n  subprocess.run([exe,'-I','-c',\"import os,sys; assert os.path.realpath(sys.prefix)==os.path.realpath(sys.argv[1]), 'Non-relocatable review venv'\",p],check=True)\n  break\nelse: print(sys.version)"];
    } else for (const venv of [".venv", "venv"]) {
      const executable = path.join(venv, !containerRoot && process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      if (await exists(executable)) {
        program = containerRoot ? path.posix.join(containerRoot, venv, "bin/python") : path.join(root, executable);
        args = ["-c", "import os,sys; assert os.path.realpath(sys.prefix)==os.path.realpath(sys.argv[1]), 'Non-relocatable review venv'", containerRoot ? path.posix.join(containerRoot, venv) : path.join(root, venv)];
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
