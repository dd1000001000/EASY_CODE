export type ExplicitShellKind = "cmd" | "powershell" | "posix";

const POSIX_SHELLS = new Set(["sh", "bash", "dash"]);
const POWERSHELL_HOSTS = new Set(["powershell", "pwsh"]);

type ShellLexeme =
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "operator"; readonly value: string }
  | { readonly kind: "newline"; readonly value: "\n" };

const SHELL_OPERATORS = [
  "&>>",
  "<<<",
  "<<-",
  ";;&",
  "&&",
  "||",
  "|&",
  "&>",
  ">>",
  "<<",
  "<&",
  ">&",
  ">|",
  ";;",
  ";&",
  ";",
  "|",
  "&",
  "(",
  ")",
  "{",
  "}",
  "<",
  ">",
] as const;

const COMMAND_SEPARATORS = new Set([
  ";",
  ";;",
  ";&",
  ";;&",
  "|",
  "|&",
  "&&",
  "||",
  "&",
  "(",
  ")",
  "{",
  "}",
]);
const REDIRECTION_OPERATORS = new Set(["<", ">", ">>", "<&", ">&", ">|", "&>", "&>>"]);
const HEREDOC_OPERATORS = new Set(["<<", "<<-", "<<<"]);

function isShellWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\v" || character === "\f";
}

/**
 * Tokenize bounded shell text for advisory verification-target attribution.
 * Quoted/escaped text stays within its word; this is not an execution policy.
 */
function lexShellCommand(value: string, kind: ExplicitShellKind): ShellLexeme[] {
  const result: ShellLexeme[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | undefined;

  const flushWord = (): void => {
    if (!wordStarted) return;
    result.push({ kind: "word", value: word });
    word = "";
    wordStarted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;

    if (quote) {
      if (character === quote) {
        // PowerShell escapes a quote inside the same quote style by doubling it.
        if (kind === "powershell" && value[index + 1] === quote) {
          word += quote;
          wordStarted = true;
          index += 1;
        } else {
          quote = undefined;
          wordStarted = true;
        }
        continue;
      }
      const isEscape =
        (kind === "posix" && quote === '"' && character === "\\") ||
        (kind === "powershell" && character === "`") ||
        (kind === "cmd" && character === "^");
      if (isEscape && index + 1 < value.length) {
        if (value[index + 1] === "\r" && value[index + 2] === "\n") index += 2;
        else if (value[index + 1] === "\n") index += 1;
        else {
          word += value[index + 1] as string;
          wordStarted = true;
          index += 1;
        }
        continue;
      }
      word += character;
      wordStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
      continue;
    }

    const escapeCharacter = kind === "posix" ? "\\" : kind === "powershell" ? "`" : "^";
    if (character === escapeCharacter && index + 1 < value.length) {
      if (value[index + 1] === "\r" && value[index + 2] === "\n") index += 2;
      else if (value[index + 1] === "\n") index += 1;
      else {
        word += value[index + 1] as string;
        wordStarted = true;
        index += 1;
      }
      continue;
    }

    // POSIX and PowerShell line comments only start at a token boundary.
    if ((kind === "posix" || kind === "powershell") && character === "#" && !wordStarted) {
      while (index + 1 < value.length && value[index + 1] !== "\r" && value[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (kind === "powershell" && character === "<" && value[index + 1] === "#" && !wordStarted) {
      const blockEnd = value.indexOf("#>", index + 2);
      if (blockEnd < 0) break;
      index = blockEnd + 1;
      continue;
    }

    if (character === "\r" || character === "\n") {
      flushWord();
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      result.push({ kind: "newline", value: "\n" });
      continue;
    }
    if (isShellWhitespace(character)) {
      flushWord();
      continue;
    }

    const operator = SHELL_OPERATORS.find((candidate) => value.startsWith(candidate, index));
    if (operator) {
      flushWord();
      result.push({ kind: "operator", value: operator });
      index += operator.length - 1;
      continue;
    }

    word += character;
    wordStarted = true;
  }
  flushWord();
  return result;
}

function executableBasename(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.replace(/\.(?:exe|cmd|bat|com)$/iu, "").toLowerCase();
}

function commandSegments(lexemes: readonly ShellLexeme[]): ShellLexeme[][] {
  const result: ShellLexeme[][] = [];
  let current: ShellLexeme[] = [];
  const flush = (): void => {
    if (current.length > 0) result.push(current);
    current = [];
  };
  for (const lexeme of lexemes) {
    if (
      lexeme.kind === "newline" ||
      (lexeme.kind === "operator" && COMMAND_SEPARATORS.has(lexeme.value))
    ) {
      flush();
    } else {
      current.push(lexeme);
    }
  }
  flush();
  return result;
}

function commandWords(segment: readonly ShellLexeme[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < segment.length; index += 1) {
    const lexeme = segment[index] as ShellLexeme;
    if (
      lexeme.kind === "word" &&
      /^\d+$/u.test(lexeme.value) &&
      segment[index + 1]?.kind === "operator" &&
      REDIRECTION_OPERATORS.has(segment[index + 1]?.value ?? "")
    ) {
      index += 1;
      if (segment[index + 1]?.kind === "word") index += 1;
      continue;
    }
    if (lexeme.kind === "operator" && REDIRECTION_OPERATORS.has(lexeme.value)) {
      if (segment[index + 1]?.kind === "word") index += 1;
      continue;
    }
    if (lexeme.kind === "word") result.push(lexeme.value);
  }
  return result;
}

function posixCommandIndex(words: readonly string[]): number {
  let index = 0;
  const controlWords = new Set(["!", "then", "do", "elif", "else"]);
  while (controlWords.has(words[index]?.toLowerCase() ?? "")) index += 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "")) index += 1;

  while (index < words.length) {
    const command = executableBasename(words[index] as string);
    if (["command", "builtin", "exec", "time", "nice"].includes(command)) {
      index += 1;
      while (words[index]?.startsWith("-")) index += 1;
      continue;
    }
    if (command === "env") {
      index += 1;
      while (words[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "")) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

export function explicitShellKind(programName: string): ExplicitShellKind | undefined {
  if (programName === "cmd") return "cmd";
  if (POWERSHELL_HOSTS.has(programName)) return "powershell";
  if (POSIX_SHELLS.has(programName)) return "posix";
  return undefined;
}

/** Add non-interactive/profile-safe flags without enabling an implicit Node shell. */
export function normalizeExplicitShellArgs(programName: string, args: readonly string[]): string[] {
  const kind = explicitShellKind(programName);
  if (kind === "cmd") {
    const lowerArgs = args.map((argument) => argument.toLowerCase());
    const commandIndex = lowerArgs.indexOf("/c");
    const hostArgs = commandIndex < 0 ? lowerArgs : lowerArgs.slice(0, commandIndex);
    return hostArgs.includes("/d") ? [...args] : ["/d", ...args];
  }
  if (kind === "powershell") {
    const lowerArgs = args.map((argument) => argument.toLowerCase());
    const commandIndex = lowerArgs.findIndex((argument) =>
      argument === "-command" || argument === "--command" || argument === "-c" || argument === "-file" || argument === "-f"
    );
    if (commandIndex < 0) return [...args];
    const prefix = lowerArgs.slice(0, commandIndex);
    const required = ["-NoLogo", "-NoProfile", "-NonInteractive"].filter(
      (flag) => !prefix.includes(flag.toLowerCase()),
    );
    // Match the already-authorized -Command capability for local script files.
    // This affects this child process only; never mutate user/machine policy.
    if (["-file", "-f"].includes(lowerArgs[commandIndex]!) &&
        !prefix.includes("-executionpolicy") && !prefix.includes("-ep")) required.push("-ExecutionPolicy", "Bypass");
    return [...required, ...args];
  }
  return [...args];
}

/** Bounded advisory extraction, never a proof of read-only behavior or permission. */
export function shellCommandWords(program: string, args: readonly string[]): string[][] {
  const kind = explicitShellKind(executableBasename(program));
  if (!kind) return [];
  const index = args.findIndex(arg => ["-c", "-command", "--command", "/c"].includes(arg.toLowerCase()));
  if (index < 0 || !args[index + 1]) return [];
  const lexemes = lexShellCommand(args[index + 1]!, kind);
  if (lexemes.some(token => token.kind === "operator" && HEREDOC_OPERATORS.has(token.value))) return [];
  return commandSegments(lexemes).map(commandWords).map(words => kind === "posix" ? words.slice(posixCommandIndex(words)) : words);
}

/** Identity extraction only: reject expansion/control flow rather than pretending
 * to evaluate a shell. This never changes execution or grants permission. */
export function literalPipelineCommands(program: string, args: readonly string[]): string[][] | undefined {
  const kind = explicitShellKind(executableBasename(program));
  if (!kind) return undefined;
  const index = args.findIndex(arg => ["-c", "-command", "--command", "/c"].includes(arg.toLowerCase()));
  const script = index >= 0 ? args[index + 1] : undefined;
  if (!script || /[\r\n$`%!*?{}()]/u.test(script)) return undefined;
  // Only a literal stdout pipeline and stderr-to-stdout redirection are known.
  const lexemes = lexShellCommand(script, kind);
  const tokens: ShellLexeme[] = [];
  for (let i = 0; i < lexemes.length; i++) {
    const item = lexemes[i]!;
    if (item.kind === "word" && item.value === "2" && lexemes[i + 1]?.kind === "operator" &&
        lexemes[i + 1]?.value === ">&" && lexemes[i + 2]?.kind === "word" && lexemes[i + 2]?.value === "1") { i += 2; continue; }
    tokens.push(item);
  }
  if (tokens.some(token => token.kind !== "word" && !(token.kind === "operator" && token.value === "|"))) return undefined;
  return commandSegments(tokens).map(commandWords);
}
