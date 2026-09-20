import path from "node:path";
import { MAX_IMAGE_BYTES } from "../image-store.js";
import { chooseClipboardMediaType, chooseClipboardTextType } from "../clipboard-media.js";
import type { ClipboardPlatformHost, ClipboardPlatformReader, ClipboardExecutionContext } from "../clipboard-platform.js";
import { clipboardError, isClipboardAbort } from "../clipboard-platform.js";

export function linuxClipboard(host: ClipboardPlatformHost): ClipboardPlatformReader {
  const wslPowerShell = async (): Promise<string> => {
    const match = /^([A-Za-z]):\\(.*)$/u.exec(host.windowsRoot());
    const root = match ? `/mnt/${match[1]?.toLowerCase()}/${(match[2] ?? "").replace(/\\/gu, "/")}` : "/mnt/c/Windows";
    return host.resolveFixedProgram(path.posix.join(root, "System32/WindowsPowerShell/v1.0/powershell.exe"), "linux");
  };
  const readWslImage = async (execution: ClipboardExecutionContext): Promise<Buffer> => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms", "Add-Type -AssemblyName System.Drawing",
      "$image = [System.Windows.Forms.Clipboard]::GetImage()",
      "if ($null -eq $image) { [Console]::Error.Write('The clipboard does not contain an image.'); exit 3 }",
      "$stream = New-Object System.IO.MemoryStream", "try {",
      "  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)",
      "  $bytes = $stream.ToArray()", "  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
      "} finally { $stream.Dispose(); $image.Dispose() }",
    ].join("; ");
    return host.run(await wslPowerShell(), ["-STA", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], MAX_IMAGE_BYTES, execution);
  };
  const readWslText = async (execution: ClipboardExecutionContext): Promise<Buffer> => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms", "$text = [System.Windows.Forms.Clipboard]::GetText()",
      "if ([string]::IsNullOrEmpty($text)) { exit 3 }", "$bytes = [System.Text.Encoding]::UTF8.GetBytes($text)",
      "[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
    ].join("; ");
    return host.run(await wslPowerShell(), ["-STA", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], 1024 * 1024, execution);
  };
  const readLinuxImage = async (execution: ClipboardExecutionContext): Promise<Buffer> => {
    const attempts: Array<() => Promise<Buffer>> = [
      async () => {
        const program = await host.resolveUnixHelper("wl-paste");
        const types = await host.run(program, ["--list-types"], 64 * 1024, execution);
        const mediaType = chooseClipboardMediaType(types.toString("utf8"));
        if (!mediaType) throw new Error("The Wayland clipboard does not contain a supported image.");
        return host.run(program, ["--no-newline", "--type", mediaType], MAX_IMAGE_BYTES, execution);
      },
      async () => {
        const program = await host.resolveUnixHelper("xclip");
        const types = await host.run(program, ["-selection", "clipboard", "-t", "TARGETS", "-o"], 64 * 1024, execution);
        const mediaType = chooseClipboardMediaType(types.toString("utf8"));
        if (!mediaType) throw new Error("The X11 clipboard does not contain a supported image.");
        return host.run(program, ["-selection", "clipboard", "-t", mediaType, "-o"], MAX_IMAGE_BYTES, execution);
      },
    ];
    const errors: string[] = [];
    for (const attempt of attempts) {
      try { return await attempt(); }
      catch (error) { if (isClipboardAbort(error)) throw error; errors.push(clipboardError(error)); }
    }
    throw new Error("Unable to read an image from the Linux clipboard. Install wl-clipboard " +
      "for Wayland or xclip for X11. " + (errors.at(-1) ?? ""));
  };
  const readLinuxText = async (execution: ClipboardExecutionContext): Promise<Buffer> => {
    const errors: string[] = [];
    try {
      const program = await host.resolveUnixHelper("wl-paste");
      const types = await host.run(program, ["--list-types"], 64 * 1024, execution);
      const mediaType = chooseClipboardTextType(types.toString("utf8"));
      if (!mediaType) throw new Error("The Wayland clipboard does not contain text.");
      return await host.run(program, ["--no-newline", "--type", mediaType], 1024 * 1024, execution);
    } catch (error) { if (isClipboardAbort(error)) throw error; errors.push(clipboardError(error)); }
    try {
      const program = await host.resolveUnixHelper("xclip");
      const types = await host.run(program, ["-selection", "clipboard", "-t", "TARGETS", "-o"], 64 * 1024, execution);
      const mediaType = chooseClipboardTextType(types.toString("utf8"));
      if (!mediaType) throw new Error("The X11 clipboard does not contain text.");
      return await host.run(program, ["-selection", "clipboard", "-t", mediaType, "-o"], 1024 * 1024, execution);
    } catch (error) { if (isClipboardAbort(error)) throw error; errors.push(clipboardError(error)); }
    throw new Error("Unable to read text from the Linux clipboard. Install wl-clipboard " +
      "for Wayland or xclip for X11. " + (errors.at(-1) ?? ""));
  };
  const isWsl = Boolean(host.sourceEnv.WSL_DISTRO_NAME || host.sourceEnv.WSL_INTEROP);
  return {
    async readImage(execution) {
      if (isWsl) {
        try { return await readWslImage(execution); }
        catch (error) { if (isClipboardAbort(error)) throw error; }
      }
      return readLinuxImage(execution);
    },
    async readText(execution) {
      if (isWsl) {
        try { return await readWslText(execution); }
        catch (error) { if (isClipboardAbort(error)) throw error; }
      }
      return readLinuxText(execution);
    },
  };
}
