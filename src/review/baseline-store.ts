import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { sha256 } from "../utils/hash.js";

/** Runtime-private CAS, never exposed through actor file or memory tools. */
export class ValidationBaselineStore {
  constructor(private readonly directory: string) {}
  async put(hash: string, bytes: Buffer): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(hash) || sha256(bytes) !== hash) throw new Error("Invalid baseline blob");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { await writeFile(path.join(this.directory, hash), bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await this.get(hash))) throw new Error("Baseline archive collision"); }
  }
  async get(hash: string): Promise<Buffer | undefined> {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid baseline identity");
    try { const bytes = await readFile(path.join(this.directory, hash)); return sha256(bytes) === hash ? bytes : undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
}
