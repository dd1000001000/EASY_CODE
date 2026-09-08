import path from "node:path";

const DIFF_COMMANDS = new Set(["diff", "show", "log", "diff-files", "diff-index", "diff-tree"]);
const GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);

/** A defense for direct Git invocations, not a sandbox for arbitrary child code.
 * Put fixed globals after caller settings, and diff flags just after the
 * subcommand so neither a path separator nor an option value can swallow them.
 * The same explicit helper-enabling options rejected by CommandPolicy are
 * rejected here too, rather than silently rewriting a possible option value. */
export function sandboxGitArgs(executable: string, args: readonly string[]): string[] {
  if (path.basename(executable).replace(/\.exe$/iu, "").toLowerCase() !== "git") return [...args];
  let commandIndex = 0;
  while (commandIndex < args.length && args[commandIndex]!.startsWith("-")) {
    const option = args[commandIndex]!;
    if (option === "--") return [...args]; // Let Git reject an unsupported global separator.
    commandIndex += GLOBAL_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  const global = args.slice(0, commandIndex);
  const command = args[commandIndex];
  const rest = args.slice(commandIndex);
  if (command && DIFF_COMMANDS.has(command)) {
    if (rest.some(arg => arg === "--ext-diff" || arg === "--textconv")) {
      throw new Error("Git external diff/textconv enabling options are disabled in the sandbox");
    }
    rest.splice(1, 0, "--no-ext-diff", "--no-textconv");
  }
  return [...global, "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "diff.trustExitCode=false", ...rest];
}

/** Applied to every target, including shells/interpreters, so inherited Git
 * helpers/config injections do not leak in. Child code can change its own env;
 * filesystem/network protection must continue to come from the OS sandbox. */
export function sandboxGitEnvironment(source: NodeJS.ProcessEnv, emptyGlobalConfig: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat",
    GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_CONFIG_KEY_2: "diff.trustExitCode", GIT_CONFIG_VALUE_2: "false" };
}
