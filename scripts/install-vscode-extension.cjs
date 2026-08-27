"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const EXTENSION_FILE = "easy-code-vscode.vsix";
const UNSAFE_CMD_PATH = /[\u0000\r\n"&|<>^%!]/u;

function pathKey(value, platform = process.platform) {
  const normalized = path.resolve(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(candidate, root, platform = process.platform) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  const normalized = platform === "win32" ? relative.toLowerCase() : relative;
  return normalized === "" || (!normalized.startsWith("..") && !path.isAbsolute(relative));
}

function addIfExecutable(output, candidate, rejectedRoots, platform) {
  if (!candidate || !path.isAbsolute(candidate)) return;
  const launchPath = path.resolve(candidate);
  let canonical;
  try {
    const info = fs.statSync(launchPath);
    if (!info.isFile()) return;
    canonical = fs.realpathSync.native(launchPath);
  } catch {
    return;
  }
  if (
    rejectedRoots.some(
      (root) => isInside(launchPath, root, platform) || isInside(canonical, root, platform),
    )
  ) return;
  if (
    /[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/iu.test(launchPath) ||
    /[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/iu.test(canonical)
  ) return;
  if (platform !== "win32") {
    try {
      fs.accessSync(canonical, fs.constants.X_OK);
    } catch {
      return;
    }
  }
  // Validate the canonical target, but execute through the path the operating
  // system exposed. Snap launchers under /snap/bin depend on their symlink name
  // being preserved as argv[0] and stop working when replaced with /usr/bin/snap.
  output.push(launchPath);
}

function isTrustedWindowsInstallLayout(candidate, environment) {
  const executable = path.win32.basename(candidate).toLowerCase();
  const productDirectory = path.win32.dirname(path.win32.dirname(candidate));
  const product = path.win32.basename(productDirectory).toLowerCase();
  const expectedProduct = executable === "code.cmd"
    ? "microsoft vs code"
    : executable === "code-insiders.cmd"
      ? "microsoft vs code insiders"
      : executable === "codium.cmd"
        ? "vscodium"
        : undefined;
  if (!expectedProduct || product !== expectedProduct) return false;
  const companionName = executable === "code.cmd"
    ? "Code.exe"
    : executable === "code-insiders.cmd"
      ? "Code - Insiders.exe"
      : "VSCodium.exe";
  try {
    if (!fs.statSync(path.win32.join(productDirectory, companionName)).isFile()) return false;
  } catch {
    return false;
  }
  const container = path.win32.dirname(productDirectory);
  const containerName = path.win32.basename(container).toLowerCase();
  if (containerName === "program files" || containerName === "program files (x86)") {
    return true;
  }
  const localPrograms = environment.LOCALAPPDATA &&
    path.win32.join(environment.LOCALAPPDATA, "Programs");
  return Boolean(localPrograms && isInside(productDirectory, localPrograms, "win32"));
}

function findVsCodeClis(options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.env || process.env;
  const packageRoot = path.resolve(options.packageRoot || path.join(__dirname, ".."));
  const rejectedRoots = [packageRoot];
  if (environment.INIT_CWD && path.isAbsolute(environment.INIT_CWD)) {
    // npm prepends workspace shims to PATH. Reject that executable directory,
    // not the whole invocation directory: INIT_CWD is commonly the user's home,
    // which also contains the default per-user VS Code install on Windows/macOS.
    rejectedRoots.push(
      path.resolve(environment.INIT_CWD, "node_modules", ".bin"),
    );
  }
  const candidates = [];

  if (environment.EASY_CODE_VSCODE_CLI && path.isAbsolute(environment.EASY_CODE_VSCODE_CLI)) {
    addIfExecutable(
      candidates,
      environment.EASY_CODE_VSCODE_CLI,
      rejectedRoots,
      platform,
    );
  }

  if (platform === "win32") {
    const roots = [
      environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Programs"),
      environment.ProgramFiles,
      environment["ProgramFiles(x86)"],
    ].filter(Boolean);
    for (const root of roots) {
      addIfExecutable(candidates, path.join(root, "Microsoft VS Code", "bin", "code.cmd"), rejectedRoots, platform);
      addIfExecutable(candidates, path.join(root, "Microsoft VS Code Insiders", "bin", "code-insiders.cmd"), rejectedRoots, platform);
      addIfExecutable(candidates, path.join(root, "VSCodium", "bin", "codium.cmd"), rejectedRoots, platform);
    }
    // VS Code is often installed on a non-system drive. Accept PATH discovery
    // only when it still has a standard Program Files or LocalAppData product
    // layout; npm's workspace/node_modules shims never satisfy this check.
    const pathValue = environment.PATH || environment.Path || "";
    for (const directory of pathValue.split(path.delimiter)) {
      if (!directory || !path.win32.isAbsolute(directory)) continue;
      for (const name of ["code.cmd", "code-insiders.cmd", "codium.cmd"]) {
        const candidate = path.win32.join(directory, name);
        if (!isTrustedWindowsInstallLayout(candidate, environment)) continue;
        addIfExecutable(candidates, candidate, rejectedRoots, platform);
      }
    }
  } else if (platform === "darwin") {
    const applicationRoots = ["/Applications"];
    if (environment.HOME && path.isAbsolute(environment.HOME)) {
      applicationRoots.push(path.join(environment.HOME, "Applications"));
    }
    for (const root of applicationRoots) {
      addIfExecutable(candidates, path.join(root, "Visual Studio Code.app/Contents/Resources/app/bin/code"), rejectedRoots, platform);
      addIfExecutable(candidates, path.join(root, "Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"), rejectedRoots, platform);
      addIfExecutable(candidates, path.join(root, "VSCodium.app/Contents/Resources/app/bin/codium"), rejectedRoots, platform);
    }
    for (const directory of ["/usr/local/bin", "/opt/homebrew/bin"]) {
      for (const name of ["code", "code-insiders", "codium"]) {
        addIfExecutable(candidates, path.join(directory, name), rejectedRoots, platform);
      }
    }
  } else if (platform === "linux") {
    for (const directory of ["/usr/bin", "/usr/local/bin", "/snap/bin"]) {
      for (const name of ["code", "code-insiders", "codium"]) {
        addIfExecutable(candidates, path.join(directory, name), rejectedRoots, platform);
      }
    }
    for (const name of ["com.visualstudio.code", "com.visualstudio.code.insiders", "com.vscodium.codium"]) {
      addIfExecutable(
        candidates,
        path.join("/var/lib/flatpak/exports/bin", name),
        rejectedRoots,
        platform,
      );
    }
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = pathKey(candidate, platform);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeInstallerEnvironment(source = process.env, platform = process.platform) {
  const allowed = platform === "win32"
    ? ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG"]
    : ["HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"];
  const output = {};
  for (const name of allowed) {
    if (source[name] !== undefined) output[name] = source[name];
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith("VSCODE_") && value !== undefined) output[name] = value;
  }
  output.PATH = platform === "darwin"
    ? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    : platform === "win32"
      ? path.win32.join(source.SystemRoot || source.WINDIR || "C:\\Windows", "System32")
      : "/usr/local/bin:/usr/bin:/bin:/snap/bin";
  return output;
}

function runVsCodeCli(program, args, options = {}) {
  const platform = options.platform || process.platform;
  const spawn = options.spawnSync || spawnSync;
  const common = {
    encoding: "utf8",
    timeout: options.timeoutMs || 20_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: safeInstallerEnvironment(options.env || process.env, platform),
  };
  if (platform === "win32" && /\.(?:cmd|bat)$/iu.test(program)) {
    const systemRoot = options.env?.SystemRoot || options.env?.WINDIR || process.env.SystemRoot || "C:\\Windows";
    const commandInterpreter = path.win32.join(systemRoot, "System32", "cmd.exe");
    const values = [program, ...args];
    if (values.some((value) => UNSAFE_CMD_PATH.test(value))) {
      return { status: null, error: new Error("Refusing an unsafe VS Code CLI path."), stdout: "", stderr: "" };
    }
    const command = `call ${values.map((value) => `"${value}"`).join(" ")}`;
    return spawn(commandInterpreter, ["/d", "/s", "/c", command], {
      ...common,
      // Node otherwise backslash-escapes the embedded quotes before cmd.exe
      // sees them, causing paths such as "Program Files" to be treated as a
      // literal command name including quote characters.
      windowsVerbatimArguments: true,
    });
  }
  return spawn(program, args, { ...common, shell: false });
}

function installBundledVsCodeExtension(options = {}) {
  const environment = options.env || process.env;
  const packageRoot = path.resolve(options.packageRoot || path.join(__dirname, ".."));
  const vsixPath = path.resolve(
    options.vsixPath || path.join(packageRoot, "vscode-extension", EXTENSION_FILE),
  );
  if (environment.EASY_CODE_SKIP_VSCODE_EXTENSION === "1") {
    return { skipped: true, reason: "disabled", installed: [], failed: [] };
  }
  try {
    if (!fs.statSync(vsixPath).isFile()) {
      return { skipped: true, reason: "missing-vsix", installed: [], failed: [] };
    }
  } catch {
    return { skipped: true, reason: "missing-vsix", installed: [], failed: [] };
  }

  const programs = options.programs || findVsCodeClis({
    env: environment,
    packageRoot,
    platform: options.platform,
  });
  if (!programs.length) {
    return { skipped: true, reason: "missing-vscode", installed: [], failed: [] };
  }

  const installed = [];
  const failed = [];
  const program = programs[0];
  const result = runVsCodeCli(
    program,
    ["--install-extension", vsixPath],
    {
      env: environment,
      platform: options.platform,
      spawnSync: options.spawnSync,
      timeoutMs: options.timeoutMs,
    },
  );
  if (result.status === 0) installed.push(program);
  else {
    const detail = result.error?.message || String(result.stderr || result.stdout || "unknown error").trim();
    failed.push({ program, detail });
  }
  return { skipped: false, installed, failed };
}

module.exports = {
  EXTENSION_FILE,
  findVsCodeClis,
  installBundledVsCodeExtension,
  isInside,
  runVsCodeCli,
  safeInstallerEnvironment,
  isTrustedWindowsInstallLayout,
};

if (require.main === module) {
  const result = installBundledVsCodeExtension();
  if (result.installed.length) {
    process.stdout.write(`EASY CODE: installed the VS Code image-paste extension into ${result.installed.length} installation(s).\n`);
  } else if (result.reason === "missing-vscode") {
    process.stdout.write("EASY CODE: VS Code CLI was not found; the bundled extension was not installed.\n");
  } else if (result.reason === "missing-vsix") {
    process.stderr.write("EASY CODE: bundled VS Code extension is missing.\n");
  }
  for (const failure of result.failed) {
    process.stderr.write(`EASY CODE: VS Code extension installation failed via ${failure.program}: ${failure.detail}\n`);
  }
  if (
    !result.installed.length &&
    (result.failed.length || result.reason === "missing-vsix" || result.reason === "missing-vscode")
  ) {
    process.exitCode = 1;
  }
}
