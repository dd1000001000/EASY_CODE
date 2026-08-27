import path from "node:path";
import envPaths from "env-paths";

import {
  DEFAULT_THINKING_EFFORT,
  type EasyCodeConfig,
  type ProviderConfig,
  type ProviderName,
} from "../core/types.js";
import { DEFAULT_MODEL_IDS } from "../models/catalog.js";

export const DEFAULT_QWEN_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_QWEN_MODEL = DEFAULT_MODEL_IDS.qwen;
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = DEFAULT_MODEL_IDS.deepseek;
export const DEFAULT_GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const DEFAULT_GLM_MODEL = DEFAULT_MODEL_IDS.glm;

export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
export const DEFAULT_PROVIDER_MAX_RETRIES = 2;

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
  const defaults = provider === "qwen"
    ? { baseUrl: DEFAULT_QWEN_BASE_URL, model: DEFAULT_QWEN_MODEL }
    : provider === "deepseek"
      ? { baseUrl: DEFAULT_DEEPSEEK_BASE_URL, model: DEFAULT_DEEPSEEK_MODEL }
      : { baseUrl: DEFAULT_GLM_BASE_URL, model: DEFAULT_GLM_MODEL };
  return {
    ...defaults,
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
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
    maxSteps: 40,
    maxContextChars: 320_000,
    maxOutputChars: 64_000,
    commandTimeoutMs: 120_000,
    qwen: createDefaultProviderConfig("qwen"),
    deepseek: createDefaultProviderConfig("deepseek"),
    glm: createDefaultProviderConfig("glm"),
  };
}
