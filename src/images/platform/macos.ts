import path from "node:path";
import { MAX_IMAGE_BYTES } from "../image-store.js";
import type { ClipboardPlatformHost, ClipboardPlatformReader, ClipboardExecutionContext } from "../clipboard-platform.js";
import { clipboardError, isClipboardAbort } from "../clipboard-platform.js";

export function macosClipboard(host: ClipboardPlatformHost): ClipboardPlatformReader {
  const writeImage = async (clipboardClass: "PNGf" | "TIFF", target: string, execution: ClipboardExecutionContext): Promise<void> => {
    const script = [
      "on run argv", "set outputPath to item 1 of argv",
      `set imageData to the clipboard as «class ${clipboardClass}»`,
      "set fileRef to open for access POSIX file outputPath with write permission",
      "try", "set eof fileRef to 0", "write imageData to fileRef", "close access fileRef",
      "on error errorMessage", "try", "close access fileRef", "end try",
      "error errorMessage", "end try", "end run",
    ];
    const args = script.flatMap((line) => ["-e", line]);
    args.push(target);
    await host.run(await host.resolveFixedProgram("/usr/bin/osascript", "darwin"), args, 64 * 1024, execution);
  };
  return {
    async readImage(execution: ClipboardExecutionContext): Promise<Buffer> {
      try {
        const pngPath = path.join(execution.cwd, "clipboard.png");
        try {
          await writeImage("PNGf", pngPath, execution);
          return await host.readTemporaryFile(pngPath, MAX_IMAGE_BYTES, execution.signal);
        } catch (error) {
          if (isClipboardAbort(error)) throw error;
          const tiffPath = path.join(execution.cwd, "clipboard.tiff");
          await writeImage("TIFF", tiffPath, execution);
          await host.run(await host.resolveFixedProgram("/usr/bin/sips", "darwin"),
            ["-s", "format", "png", tiffPath, "--out", pngPath], 64 * 1024, execution);
          return await host.readTemporaryFile(pngPath, MAX_IMAGE_BYTES, execution.signal);
        }
      } catch (error) {
        if (isClipboardAbort(error)) throw error;
        throw new Error(`Unable to read an image from the macOS clipboard. ${clipboardError(error)}`);
      }
    },
    async readText(execution: ClipboardExecutionContext): Promise<Buffer> {
      return host.run(await host.resolveFixedProgram("/usr/bin/pbpaste", "darwin"), [], 1024 * 1024, execution);
    },
  };
}
