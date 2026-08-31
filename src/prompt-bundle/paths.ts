import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The production prompt home is deliberately not configurable. Prompt assets
 * are installation resources, not workspace or model-controlled data.
 */
export function getEasyCodeHome(): string {
  return path.join(os.homedir(), ".easy_code");
}

export function getPackagedPromptBundleDirectory(): string {
  return fileURLToPath(new URL("../../resources/prompt-bundle/", import.meta.url));
}

export function promptBundleDirectoryName(bundleVersion: string): string {
  return `prompt-${bundleVersion}`;
}

