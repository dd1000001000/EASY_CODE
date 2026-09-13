import { lstat, readFile } from "node:fs/promises";
import { assertPlainAncestors } from "./ownership.js";

/** Bounded host metadata, never a redirected file or a private-key reader. */
export async function readJson(file: string): Promise<any> {
  assertPlainAncestors(file);
  const info = await lstat(file);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("Invalid metadata: " + file);
  return JSON.parse(await readFile(file, "utf8"));
}
