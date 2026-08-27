import path from "node:path";
import envPaths from "env-paths";

import type { EasyCodeConfig, ProviderConfig } from "../core/types.js";

export const DEFAULT_QWEN_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_QWEN_MODEL = "qwen3-coder-plus";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";

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
  provider: "qwen" | "deepseek",
): ProviderConfig {
  return provider === "qwen"
    ? {
        baseUrl: DEFAULT_QWEN_BASE_URL,
        model: DEFAULT_QWEN_MODEL,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
        maxRetries: DEFAULT_PROVIDER_MAX_RETRIES,
      }
    : {
        baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
        model: DEFAULT_DEEPSEEK_MODEL,
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
  };
}
