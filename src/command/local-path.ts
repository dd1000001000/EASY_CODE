import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";

/** Resolve links locally without asking the OS to traverse a UNC/device link first. */
export async function resolveLocalCommandPath(input: string, base: string, depth = 0): Promise<string> {
  if (depth > 40) throw new Error("Too many symbolic links in command path");
  if (/^(?:\\\\|\/\/)/u.test(input) || input.includes("\0")) {
    throw new Error("Network/device command paths are not accepted");
  }
  if (process.platform !== "win32" && /^[a-z]:[\\/]/iu.test(input)) throw new Error("Foreign absolute command path");
  const absolute = path.resolve(base, input);
  let current = path.parse(absolute).root;
  const segments = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    if ((await lstat(current)).isSymbolicLink()) {
      const destination = await readlink(current);
      // Check the raw destination before normalization could hide a remote prefix.
      const target = await resolveLocalCommandPath(destination, path.dirname(current), depth + 1);
      return resolveLocalCommandPath(path.join(target, ...segments.slice(index + 1)), base, depth + 1);
    }
  }
  return path.normalize(await realpath(absolute));
}
