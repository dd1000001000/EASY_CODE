import path from "node:path";

/** Classify only paths already observed in the change journal or command delta. */
export function isValidationConfigPath(name: string): boolean {
  const basename = path.posix.basename(name.replaceAll("\\", "/"));
  return /^(?:conftest\.py|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|package\.json|(?:jest|vitest|playwright)\.config\.[^.]+|(?:run)?tests?\.[^.]+|manage\.py|Makefile)$/iu.test(basename);
}

export function isValidationTestPath(name: string): boolean {
  const normalized = name.replaceAll("\\", "/");
  if (isValidationConfigPath(normalized)) return false;
  return /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|$)/iu.test(normalized) ||
    /(?:^|\/)(?:test_.+|.+_test)\.py$/iu.test(normalized) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(normalized);
}
