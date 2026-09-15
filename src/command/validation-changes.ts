import type { FileChangeRecord } from "../core/types.js";
import type { WorkspaceDeltaSummary } from "./types.js";
import { isValidationConfigPath, isValidationTestPath } from "../progress/validation-paths.js";
import { sha256 } from "../utils/hash.js";

/** Detect only known original-test/configuration mutations. Added tests are
 * evidence, but they do not replace an original test oracle. */
export function targetedValidationChanges(
  history: readonly FileChangeRecord[],
  delta: Readonly<WorkspaceDeltaSummary>,
): { baselineDigest: string; changedPaths: string[] } | undefined {
  const prior = new Map<string, { first: FileChangeRecord; last: FileChangeRecord }>();
  for (const record of history) {
    if (record.status !== "applied" && record.status !== "verified") continue;
    const name = record.path.replaceAll("\\", "/");
    const entry = prior.get(name);
    if (entry) entry.last = record;
    else prior.set(name, { first: record, last: record });
  }
  const changed = new Set<string>();
  for (const [name, { first, last }] of prior) {
    if (!isValidationConfigPath(name) && !isValidationTestPath(name)) continue;
    if (!isValidationConfigPath(name) && first.operation === "create") continue;
    if (last.operation === "delete" || last.operation === "deleted_by_command" ||
        first.beforeHash !== last.afterHash) changed.add(name);
  }
  for (const original of [...delta.updated, ...delta.deleted]) {
    const name = original.replaceAll("\\", "/");
    if (isValidationConfigPath(name) || isValidationTestPath(name) &&
        prior.get(name)?.first.operation !== "create") changed.add(name);
  }
  for (const created of delta.created) {
    const name = created.replaceAll("\\", "/");
    if (isValidationConfigPath(name)) changed.add(name);
  }
  if (!changed.size) return undefined;
  const changedPaths = [...changed].sort().slice(0, 32);
  return { baselineDigest: sha256(JSON.stringify([...prior]
    .filter(([name]) => changed.has(name))
    .map(([name, { first }]) => [name, first.operation, first.beforeHash ?? null]).sort())),
    changedPaths };
}
