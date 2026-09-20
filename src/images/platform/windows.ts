import path from "node:path";
import { MAX_IMAGE_BYTES } from "../image-store.js";
import type { ClipboardPlatformHost, ClipboardPlatformReader, ClipboardExecutionContext } from "../clipboard-platform.js";
import { clipboardError, isClipboardAbort } from "../clipboard-platform.js";

const powershellArgs = (script: string): string[] =>
  ["-STA", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];

export function windowsClipboard(host: ClipboardPlatformHost): ClipboardPlatformReader {
  const powershell = (): Promise<string> => host.resolveFixedProgram(
    path.win32.join(host.windowsRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "win32");
  return {
    async readImage(execution: ClipboardExecutionContext): Promise<Buffer> {
      try {
        const script = [
          "Add-Type -AssemblyName System.Windows.Forms",
          "Add-Type -AssemblyName System.Drawing",
          "$image = [System.Windows.Forms.Clipboard]::GetImage()",
          "if ($null -eq $image) { [Console]::Error.Write('The clipboard does not contain an image.'); exit 3 }",
          "$stream = New-Object System.IO.MemoryStream",
          "try {",
          "  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)",
          "  $bytes = $stream.ToArray()",
          "  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
          "} finally { $stream.Dispose(); $image.Dispose() }",
        ].join("; ");
        return await host.run(await powershell(), powershellArgs(script), MAX_IMAGE_BYTES, execution);
      } catch (error) {
        if (isClipboardAbort(error)) throw error;
        throw new Error(`Unable to read an image from the Windows clipboard. ${clipboardError(error)}`);
      }
    },
    async readText(execution: ClipboardExecutionContext): Promise<Buffer> {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$text = [System.Windows.Forms.Clipboard]::GetText()",
        "if ([string]::IsNullOrEmpty($text)) { exit 3 }",
        "$bytes = [System.Text.Encoding]::UTF8.GetBytes($text)",
        "[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
      ].join("; ");
      return host.run(await powershell(), powershellArgs(script), 1024 * 1024, execution);
    },
  };
}
