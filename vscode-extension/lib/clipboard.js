"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_OUTPUT_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 2500;

function parseWindowsClipboardResult(output) {
  return String(output)
    .split(/\r?\n/u)
    .some((line) => line.trim().toLowerCase() === "true");
}

function parseMacClipboardInfo(output) {
  const value = String(output).toLowerCase();
  return /(?:«class\s+(?:pngf|jpeg|jpg|gif[f ]|tiff|heic|webp)»|\b(?:png|jpeg|jpg|gif|tiff|heic|webp)\s+picture\b|\bpublic\.(?:png|jpeg|tiff|heic|webp)\b)/u.test(
    value,
  );
}

function parseLinuxClipboardTypes(output) {
  return String(output)
    .split(/\r?\n/u)
    // Keep this list exactly aligned with the CLI clipboard reader. Detecting
    // a format that the CLI cannot retrieve would swallow an ordinary paste
    // and replace it with a failing image event.
    .some((line) => /^image\/(?:png|jpeg|gif|webp)$/iu.test(line.trim()));
}

function helperEnvironment(platform, source = process.env) {
  const names =
    platform === "win32"
      ? ["SystemRoot", "WINDIR", "TEMP", "TMP"]
      : [
          "DBUS_SESSION_BUS_ADDRESS",
          "DISPLAY",
          "HOME",
          "LANG",
          "LC_ALL",
          "TMPDIR",
          "WAYLAND_DISPLAY",
          "XAUTHORITY",
          "XDG_RUNTIME_DIR",
        ];
  const result = {};
  for (const name of names) {
    if (source[name]) result[name] = source[name];
  }
  return result;
}

function runProgram(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      program,
      args,
      {
        cwd: os.tmpdir(),
        encoding: "utf8",
        env: options.env,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        timeout: HELPER_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function isPathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveExecutable(
  name,
  sourcePath = process.env.PATH ?? "",
  rejectedRoots = [],
) {
  const canonicalRejectedRoots = rejectedRoots
    .filter((root) => typeof root === "string" && path.isAbsolute(root))
    .map((root) => {
      try {
        return fs.realpathSync.native(root);
      } catch {
        return path.resolve(root);
      }
    });
  for (const directory of sourcePath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    try {
      const canonicalDirectory = fs.realpathSync.native(directory);
      if (canonicalRejectedRoots.some((root) => isPathInside(canonicalDirectory, root))) {
        continue;
      }
      const canonical = fs.realpathSync.native(path.join(canonicalDirectory, name));
      if (!isPathInside(canonical, canonicalDirectory)) continue;
      if (canonicalRejectedRoots.some((root) => isPathInside(canonical, root))) continue;
      if (!fs.statSync(canonical).isFile()) continue;
      fs.accessSync(canonical, fs.constants.X_OK);
      return canonical;
    } catch {
      // Try the next absolute PATH entry.
    }
  }
  return undefined;
}

async function clipboardHasImage(options = {}) {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.env ?? process.env;
  const run = options.runProgram ?? runProgram;
  const environment = helperEnvironment(platform, sourceEnv);

  if (platform === "win32") {
    const systemRoot = sourceEnv.SystemRoot || sourceEnv.WINDIR || "C:\\Windows";
    const powershell = path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "if ([Windows.Forms.Clipboard]::ContainsImage()) {",
      "  [Console]::Out.Write('true')",
      "} else {",
      "  [Console]::Out.Write('false')",
      "}",
    ].join("; ");
    try {
      const output = await run(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", script],
        { env: environment },
      );
      return parseWindowsClipboardResult(output);
    } catch {
      return false;
    }
  }

  if (platform === "darwin") {
    try {
      const output = await run(
        "/usr/bin/osascript",
        ["-e", 'try', "-e", 'clipboard info', "-e", 'on error', "-e", 'return ""', "-e", 'end try'],
        { env: environment },
      );
      return parseMacClipboardInfo(output);
    } catch {
      return false;
    }
  }

  if (platform === "linux") {
    const resolve = options.resolveExecutable ?? resolveExecutable;
    const sourcePath = sourceEnv.PATH ?? "";
    const wlPaste = resolve("wl-paste", sourcePath, options.rejectedRoots ?? []);
    if (wlPaste) {
      try {
        const output = await run(wlPaste, ["--list-types"], { env: environment });
        return parseLinuxClipboardTypes(output);
      } catch {
        // X11 may still be available when the Wayland helper cannot connect.
      }
    }
    const xclip = resolve("xclip", sourcePath, options.rejectedRoots ?? []);
    if (xclip) {
      try {
        const output = await run(
          xclip,
          ["-selection", "clipboard", "-t", "TARGETS", "-o"],
          { env: environment },
        );
        return parseLinuxClipboardTypes(output);
      } catch {
        return false;
      }
    }
  }

  return false;
}

module.exports = {
  clipboardHasImage,
  helperEnvironment,
  isPathInside,
  parseLinuxClipboardTypes,
  parseMacClipboardInfo,
  parseWindowsClipboardResult,
  resolveExecutable,
  runProgram,
};
