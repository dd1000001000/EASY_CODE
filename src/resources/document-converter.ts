import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const TEXT_MEDIA_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "application/xml", "text/xml"]);

function adapterPath(): string {
  return fileURLToPath(new URL("../../resources/document-converter/markitdown_adapter.py", import.meta.url));
}

function managedPython(dataDir: string): string {
  if (process.env.EASY_CODE_MARKITDOWN_PYTHON) return process.env.EASY_CODE_MARKITDOWN_PYTHON;
  return process.platform === "win32"
    ? path.join(dataDir, "runtimes", "markitdown", "Scripts", "python.exe")
    : path.join(dataDir, "runtimes", "markitdown", "bin", "python");
}

export class DocumentConverter {
  constructor(private readonly dataDir: string) {}

  async convert(data: Buffer, filename: string, mediaType: string, signal?: AbortSignal): Promise<string> {
    if (TEXT_MEDIA_TYPES.has(mediaType) || /\.(?:txt|md|markdown|csv|json|xml|ya?ml)$/iu.test(filename)) {
      if (data.includes(0)) throw new Error("The selected text document contains binary data.");
      return data.toString("utf8");
    }
    const python = managedPython(this.dataDir);
    try { await access(python); }
    catch { throw new Error("The document converter is not installed. Reinstall EASY CODE without --ignore-scripts."); }
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-document-"));
    const extension = path.extname(filename).slice(0, 16) || ".bin";
    const source = path.join(directory, `source${extension}`);
    const output = path.join(directory, "content.md");
    try {
      await writeFile(source, data, { mode: 0o600 });
      const result = await execa(python, [adapterPath()], {
        input: JSON.stringify({ inputPath: source, outputPath: output }),
        reject: false,
        windowsHide: true,
        signal,
        timeout: 5 * 60_000,
        maxBuffer: 1024 * 1024,
      });
      let response: { ok?: boolean; error?: string } = {};
      try { response = JSON.parse(result.stdout.trim()) as typeof response; } catch { /* Use bounded stderr below. */ }
      if (result.exitCode !== 0 || response.ok !== true) {
        throw new Error(response.error ?? (result.stderr.trim().slice(0, 2000) || "Document conversion failed."));
      }
      return await readFile(output, "utf8");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
