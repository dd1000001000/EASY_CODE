import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const EASY_CODE_DATA_ROOT_MARKER = ".easy-code-data-root.json";
export const EASY_CODE_DATA_ROOT_FORMAT_VERSION = 1;

interface DataRootMarker {
  readonly product: "easy-code-agent";
  readonly formatVersion: number;
}

const MARKER: DataRootMarker = Object.freeze({
  product: "easy-code-agent",
  formatVersion: EASY_CODE_DATA_ROOT_FORMAT_VERSION,
});

export function isEasyCodeDataRootMarker(value: unknown): value is DataRootMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.product === MARKER.product &&
    record.formatVersion === MARKER.formatVersion
  );
}

/** Establish an unambiguous ownership marker before private Runtime data is written. */
export function ensureEasyCodeDataRootMarker(dataDirectory: string): void {
  const resolvedDataDirectory = path.resolve(dataDirectory);
  const rootMetadata = lstatSync(resolvedDataDirectory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`Refusing to use a linked EASY CODE data directory: ${dataDirectory}`);
  }
  const markerPath = path.join(resolvedDataDirectory, EASY_CODE_DATA_ROOT_MARKER);
  try {
    writeFileSync(markerPath, `${JSON.stringify(MARKER, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  let parsed: unknown;
  try {
    const markerMetadata = lstatSync(markerPath);
    if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) throw new Error();
    parsed = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
  } catch {
    throw new Error(`Invalid EASY CODE data-root marker: ${markerPath}`);
  }
  if (!isEasyCodeDataRootMarker(parsed)) {
    throw new Error(`Refusing to use an unowned EASY CODE data directory: ${dataDirectory}`);
  }
}
