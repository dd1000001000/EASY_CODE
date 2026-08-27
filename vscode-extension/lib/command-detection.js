"use strict";

const path = require("node:path");

function tokenizeCommandLine(commandLine) {
  if (typeof commandLine !== "string") return [];
  const tokens = [];
  let token = "";
  let quote;

  for (const character of commandLine.trim()) {
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (token) tokens.push(token);
  return tokens;
}

function executableName(value) {
  const basename = path.win32.basename(value.replaceAll("/", "\\")).toLowerCase();
  return basename.replace(/\.(?:cmd|exe|bat|ps1)$/u, "");
}

function packageName(value) {
  return value.toLowerCase().replace(/@(?:latest|next|\d[^/]*)$/u, "");
}

function isEasyCodeExecutable(value) {
  return executableName(value) === "easy-code";
}

function isEasyCodePackage(value) {
  const name = packageName(value);
  return name === "easy-code" || name === "easy-code-agent";
}

function isEnvironmentAssignment(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function withoutEnvironmentPrefix(input) {
  const tokens = [...input];
  const executable = tokens[0] ? executableName(tokens[0]) : "";
  if (executable === "env" || executable === "cross-env") {
    tokens.shift();
    while (tokens[0]?.startsWith("-")) {
      const option = tokens.shift();
      if (["-u", "--unset", "-C", "--chdir"].includes(option)) tokens.shift();
    }
  }
  while (tokens[0] && isEnvironmentAssignment(tokens[0])) tokens.shift();
  return tokens;
}

function firstNonOption(tokens, start) {
  const optionsWithValues = new Set([
    "--cache",
    "--package",
    "--registry",
    "--userconfig",
    "-p",
  ]);
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") return tokens[index + 1];
    if (optionsWithValues.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

function isEasyCodeCommand(commandLine) {
  let tokens = tokenizeCommandLine(commandLine);
  if (tokens[0] === "&") tokens.shift();
  while (tokens[0] === "command" || tokens[0] === "exec") tokens.shift();
  tokens = withoutEnvironmentPrefix(tokens);
  if (tokens.length === 0) return false;

  const executable = executableName(tokens[0]);
  if (isEasyCodeExecutable(tokens[0])) return true;

  if (executable === "npx" || executable === "bunx") {
    const target = firstNonOption(tokens, 1);
    return Boolean(target && isEasyCodePackage(target));
  }
  if (executable === "npm" && tokens[1]?.toLowerCase() === "exec") {
    const target = firstNonOption(tokens, 2);
    return Boolean(target && (isEasyCodePackage(target) || isEasyCodeExecutable(target)));
  }
  if (
    (executable === "pnpm" || executable === "yarn") &&
    tokens[1]?.toLowerCase() === "dlx"
  ) {
    const target = firstNonOption(tokens, 2);
    return Boolean(target && isEasyCodePackage(target));
  }
  return false;
}

function packageScriptName(commandLine) {
  const tokens = withoutEnvironmentPrefix(tokenizeCommandLine(commandLine));
  const executable = tokens[0] ? executableName(tokens[0]) : "";
  const action = tokens[1]?.toLowerCase();
  if (executable === "npm") {
    if (action === "start") return "start";
    if (action === "run" || action === "run-script") return tokens[2];
  }
  if (executable === "pnpm" || executable === "yarn") {
    if (action === "start") return "start";
    if (action === "run") return tokens[2];
  }
  return undefined;
}

function isEasyCodePackageScript(commandLine, manifest) {
  const scriptName = packageScriptName(commandLine);
  if (!scriptName || !manifest || typeof manifest !== "object") return false;
  const scripts = manifest.scripts;
  if (!scripts || typeof scripts !== "object") return false;
  const script = scripts[scriptName];
  if (typeof script !== "string") return false;
  if (isEasyCodeCommand(script)) return true;
  return (
    manifest.name === "easy-code-agent" &&
    /(?:^|\s)node(?:\.exe)?\s+["']?(?:\.\.?[\\/])?dist[\\/]index\.js["']?(?:\s|$)/iu.test(script)
  );
}

module.exports = {
  isEasyCodeCommand,
  isEasyCodePackageScript,
  packageScriptName,
  tokenizeCommandLine,
};
