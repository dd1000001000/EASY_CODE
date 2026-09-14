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
  ACTIVE_MODEL_REGISTRY_HASH,
  DEFAULT_PROVIDER_NAME,
  PROVIDER_CATALOG,
  DEFAULT_MODEL_IDS,
  providerCatalogEntry,
} from "../models/catalog.js";

export const DEFAULT_QWEN_BASE_URL = providerCatalogEntry("qwen").defaultBaseUrl;
export const DEFAULT_QWEN_MODEL = DEFAULT_MODEL_IDS.qwen!;
export const DEFAULT_DEEPSEEK_BASE_URL =
  providerCatalogEntry("deepseek").defaultBaseUrl;
export const DEFAULT_DEEPSEEK_MODEL = DEFAULT_MODEL_IDS.deepseek!;
export const DEFAULT_KIMI_BASE_URL = providerCatalogEntry("kimi").defaultBaseUrl;
export const DEFAULT_KIMI_MODEL = DEFAULT_MODEL_IDS.kimi!;
export const DEFAULT_GLM_BASE_URL = providerCatalogEntry("glm").defaultBaseUrl;
export const DEFAULT_GLM_CODING_PLAN_BASE_URL =
  providerCatalogEntry("glm-coding-plan").defaultBaseUrl;
export const DEFAULT_GLM_MODEL = DEFAULT_MODEL_IDS.glm!;
export const DEFAULT_GLM_CODING_PLAN_MODEL =
  DEFAULT_MODEL_IDS["glm-coding-plan"]!;

export const DEFAULT_PROVIDER_MAX_RETRIES = defaultRuntimeLimits().maxProviderRetries;

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
    timeoutMs: entry.requestTimeoutMs,
    maxRetries: Math.min(entry.maxRetries, DEFAULT_PROVIDER_MAX_RETRIES),
  };
}

export function createDefaultEasyCodeConfig(
  workspaceRoot: string,
  paths: EasyCodePaths = resolveEasyCodePaths(),
): EasyCodeConfig {
  const providers = Object.fromEntries(
    PROVIDER_CATALOG.map(({ provider }) => [provider, createDefaultProviderConfig(provider)]),
  );
  const defaultProvider = DEFAULT_PROVIDER_NAME;
  if (!defaultProvider) throw new Error("The model registry does not define a provider");
  return {
    provider: defaultProvider,
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
    providers,
    modelRegistryHash: ACTIVE_MODEL_REGISTRY_HASH,
  };
}
