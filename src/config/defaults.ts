import path from "node:path";
import envPaths from "env-paths";
import { defaultRuntimeLimits } from "./runtime-limits.js";

import {
  DEFAULT_THINKING_EFFORT,
  type EasyCodeConfig,
  type ProviderConfig,
  type ProviderName,
} from "../core/types.js";
import {
  DEFAULT_MODEL_IDS,
  providerCatalogEntry,
} from "../models/catalog.js";
import {
  DEFAULT_BASE_CONTEXT_CHAR_LIMIT,
  DEFAULT_BASE_STEP_LIMIT,
  THINKING_EFFORT_TIMEOUT_MS,
} from "../models/thinking.js";

export const DEFAULT_QWEN_BASE_URL = providerCatalogEntry("qwen").defaultBaseUrl;
export const DEFAULT_QWEN_MODEL = DEFAULT_MODEL_IDS.qwen;
export const DEFAULT_DEEPSEEK_BASE_URL =
  providerCatalogEntry("deepseek").defaultBaseUrl;
export const DEFAULT_DEEPSEEK_MODEL = DEFAULT_MODEL_IDS.deepseek;
export const DEFAULT_GLM_BASE_URL = providerCatalogEntry("glm").defaultBaseUrl;
export const DEFAULT_GLM_CODING_PLAN_BASE_URL =
  providerCatalogEntry("glm-coding-plan").defaultBaseUrl;
export const DEFAULT_GLM_MODEL = DEFAULT_MODEL_IDS.glm;
export const DEFAULT_GLM_CODING_PLAN_MODEL =
  DEFAULT_MODEL_IDS["glm-coding-plan"];

/** Backward-compatible name for the default none/low request timeout. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = THINKING_EFFORT_TIMEOUT_MS.none;
export const DEFAULT_PROVIDER_MAX_RETRIES = defaultRuntimeLimits().maxProviderRetries;
/** Configurable none/low thinking-effort step budget. */
export const DEFAULT_BASE_MAX_STEPS = DEFAULT_BASE_STEP_LIMIT;
/** Configurable none/low thinking-effort context-character budget. */
export const DEFAULT_BASE_MAX_CONTEXT_CHARS = DEFAULT_BASE_CONTEXT_CHAR_LIMIT;

export interface EasyCodePaths {
  configDir: string;
  dataDir: string;
  cacheDir: string;
}

export function resolveEasyCodePaths(appName = "easy-code"): EasyCodePaths {
  const paths = envPaths(appName, { suffix: "" });
  return {
    configDir: paths.config,
    dataDir: paths.data,
    cacheDir: paths.cache,
  };
}

export function createDefaultProviderConfig(
  provider: ProviderName,
): ProviderConfig {
  const entry = providerCatalogEntry(provider);
  return {
    baseUrl: entry.defaultBaseUrl,
    model: entry.defaultModel,
    maxRetries: DEFAULT_PROVIDER_MAX_RETRIES,
  };
}

export function createDefaultEasyCodeConfig(
  workspaceRoot: string,
  paths: EasyCodePaths = resolveEasyCodePaths(),
): EasyCodeConfig {
  return {
    provider: "qwen",
    mode: "auto",
    thinkingEffort: DEFAULT_THINKING_EFFORT,
    approvalPolicy: "safe",
    workspaceRoot: path.resolve(workspaceRoot),
    dataDir: path.resolve(paths.dataDir),
    configDir: path.resolve(paths.configDir),
    cacheDir: path.resolve(paths.cacheDir),
    limits: defaultRuntimeLimits(),
    orchestrationEnabled: false,
    subagentIsolation: "auto",
    worktreeBaseMode: "current-snapshot",
    worktreeRoot: path.join(path.resolve(paths.dataDir), "worktrees"),
    qwen: createDefaultProviderConfig("qwen"),
    deepseek: createDefaultProviderConfig("deepseek"),
    glm: createDefaultProviderConfig("glm"),
    "glm-coding-plan": createDefaultProviderConfig("glm-coding-plan"),
  };
}
