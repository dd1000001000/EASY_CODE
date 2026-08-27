import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "toml";
import { ZodError } from "zod";

import type {
  EasyCodeConfig,
  ProviderConfig,
  ProviderName,
} from "../core/types.js";
import {
  SystemKeyringCredentialStore,
  type ApiKeyCredentialStore,
} from "./credentials.js";
import {
  createDefaultEasyCodeConfig,
  resolveEasyCodePaths,
  type EasyCodePaths,
} from "./defaults.js";
import { validateEasyCodeConfig } from "./schema.js";

type UnknownRecord = Record<string, unknown>;

interface ProviderConfigLayer extends UnknownRecord {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
  maxRetries?: unknown;
}

interface EasyCodeConfigLayer {
  provider?: unknown;
  mode?: unknown;
  thinkingEffort?: unknown;
  approvalPolicy?: unknown;
  dataDir?: unknown;
  configDir?: unknown;
  cacheDir?: unknown;
  maxSteps?: unknown;
  maxContextChars?: unknown;
  maxOutputChars?: unknown;
  commandTimeoutMs?: unknown;
  qwen?: ProviderConfigLayer;
  deepseek?: ProviderConfigLayer;
  glm?: ProviderConfigLayer;
}

export interface LoadEasyCodeConfigOptions {
  /** Workspace selection is resolved before workspace-local configuration is read. */
  workspaceRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  appName?: string;
  configDir?: string;
  dataDir?: string;
  cacheDir?: string;
  userConfigPath?: string;
  workspaceConfigPath?: string;
  /** Set to false in isolated tests or provide a custom credential store. */
  credentialStore?: ApiKeyCredentialStore | false;
}

export class EasyCodeConfigError extends Error {
  readonly configPath?: string;

  constructor(message: string, configPath?: string) {
    super(message);
    this.name = "EasyCodeConfigError";
    this.configPath = configPath;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(record: UnknownRecord, key: string): UnknownRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function field(record: UnknownRecord, camel: string, snake: string): unknown {
  return firstDefined(record[camel], record[snake]);
}

function providerLayer(raw: UnknownRecord): ProviderConfigLayer {
  return compact({
    apiKey: field(raw, "apiKey", "api_key"),
    baseUrl: field(raw, "baseUrl", "base_url"),
    model: raw.model,
    timeoutMs: field(raw, "timeoutMs", "timeout_ms"),
    maxRetries: field(raw, "maxRetries", "max_retries"),
  });
}

function normalizeConfigLayer(value: unknown): EasyCodeConfigLayer {
  if (!isRecord(value)) {
    throw new EasyCodeConfigError("Configuration root must be a TOML table");
  }

  const limits = recordAt(value, "limits");
  const paths = recordAt(value, "paths");
  const providers = recordAt(value, "providers");
  const nestedQwen = recordAt(providers, "qwen");
  const nestedDeepSeek = recordAt(providers, "deepseek");
  const directQwen = recordAt(value, "qwen");
  const directDeepSeek = recordAt(value, "deepseek");
  const nestedGlm = recordAt(providers, "glm");
  const directGlm = recordAt(value, "glm");

  return compact({
    provider: value.provider,
    mode: value.mode,
    thinkingEffort: field(value, "thinkingEffort", "thinking_effort"),
    approvalPolicy: field(value, "approvalPolicy", "approval_policy"),
    dataDir: firstDefined(
      field(value, "dataDir", "data_dir"),
      field(paths, "dataDir", "data_dir"),
    ),
    configDir: firstDefined(
      field(value, "configDir", "config_dir"),
      field(paths, "configDir", "config_dir"),
    ),
    cacheDir: firstDefined(
      field(value, "cacheDir", "cache_dir"),
      field(paths, "cacheDir", "cache_dir"),
    ),
    maxSteps: firstDefined(
      field(value, "maxSteps", "max_steps"),
      field(limits, "maxSteps", "max_steps"),
    ),
    maxContextChars: firstDefined(
      field(value, "maxContextChars", "max_context_chars"),
      field(limits, "maxContextChars", "max_context_chars"),
    ),
    maxOutputChars: firstDefined(
      field(value, "maxOutputChars", "max_output_chars"),
      field(limits, "maxOutputChars", "max_output_chars"),
    ),
    commandTimeoutMs: firstDefined(
      field(value, "commandTimeoutMs", "command_timeout_ms"),
      field(limits, "commandTimeoutMs", "command_timeout_ms"),
    ),
    qwen: providerLayer({ ...nestedQwen, ...directQwen }),
    deepseek: providerLayer({ ...nestedDeepSeek, ...directDeepSeek }),
    glm: providerLayer({ ...nestedGlm, ...directGlm }),
  });
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function applyProviderLayer(
  base: ProviderConfig,
  layer: ProviderConfigLayer | undefined,
): ProviderConfig {
  if (!layer) return base;
  return { ...base, ...compact(layer) } as ProviderConfig;
}

function applyLayer(
  base: EasyCodeConfig,
  layer: EasyCodeConfigLayer,
): EasyCodeConfig {
  const topLevel = compact({
    provider: layer.provider,
    mode: layer.mode,
    thinkingEffort: layer.thinkingEffort,
    approvalPolicy: layer.approvalPolicy,
    dataDir: layer.dataDir,
    configDir: layer.configDir,
    cacheDir: layer.cacheDir,
    maxSteps: layer.maxSteps,
    maxContextChars: layer.maxContextChars,
    maxOutputChars: layer.maxOutputChars,
    commandTimeoutMs: layer.commandTimeoutMs,
  });

  return {
    ...base,
    ...topLevel,
    qwen: applyProviderLayer(base.qwen, layer.qwen),
    deepseek: applyProviderLayer(base.deepseek, layer.deepseek),
    glm: applyProviderLayer(base.glm, layer.glm),
  } as EasyCodeConfig;
}

async function readTomlLayer(configPath: string): Promise<EasyCodeConfigLayer> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    const code = isNodeError(error) ? ` (${error.code})` : "";
    throw new EasyCodeConfigError(
      `Unable to read configuration file${code}: ${configPath}`,
      configPath,
    );
  }

  try {
    return normalizeConfigLayer(parseToml(source) as unknown);
  } catch (error) {
    if (error instanceof EasyCodeConfigError) throw error;
    // Parser messages can echo source lines, which could contain an API key.
    throw new EasyCodeConfigError(
      `Unable to parse TOML configuration file: ${configPath}`,
      configPath,
    );
  }
}

function assertSafeWorkspaceLayer(
  layer: EasyCodeConfigLayer,
  configPath: string,
): void {
  const forbidden: string[] = [];
  if (layer.qwen?.apiKey !== undefined) forbidden.push("qwen.api_key");
  if (layer.deepseek?.apiKey !== undefined) {
    forbidden.push("deepseek.api_key");
  }
  if (layer.glm?.apiKey !== undefined) forbidden.push("glm.api_key");
  if (layer.qwen?.baseUrl !== undefined) forbidden.push("qwen.base_url");
  if (layer.deepseek?.baseUrl !== undefined) {
    forbidden.push("deepseek.base_url");
  }
  if (layer.glm?.baseUrl !== undefined) forbidden.push("glm.base_url");
  if (layer.configDir !== undefined) forbidden.push("config_dir");
  if (layer.dataDir !== undefined) forbidden.push("data_dir");
  if (layer.cacheDir !== undefined) forbidden.push("cache_dir");
  if (forbidden.length) {
    throw new EasyCodeConfigError(
      `Workspace configuration cannot set trust-root fields: ${forbidden.join(", ")}`,
      configPath,
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function envInteger(
  env: NodeJS.ProcessEnv,
  ...names: string[]
): number | undefined {
  const value = envValue(env, ...names);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new EasyCodeConfigError(
      `Environment variable ${names[0]} must be a non-negative integer`,
    );
  }
  return Number(value);
}

function environmentLayer(env: NodeJS.ProcessEnv): EasyCodeConfigLayer {
  return compact({
    provider: envValue(env, "EASY_CODE_PROVIDER"),
    mode: envValue(env, "EASY_CODE_MODE"),
    thinkingEffort: envValue(env, "EASY_CODE_THINKING_EFFORT"),
    approvalPolicy: envValue(env, "EASY_CODE_APPROVAL_POLICY"),
    dataDir: envValue(env, "EASY_CODE_DATA_DIR"),
    configDir: envValue(env, "EASY_CODE_CONFIG_DIR"),
    cacheDir: envValue(env, "EASY_CODE_CACHE_DIR"),
    maxSteps: envInteger(env, "EASY_CODE_MAX_STEPS"),
    maxContextChars: envInteger(env, "EASY_CODE_MAX_CONTEXT_CHARS"),
    maxOutputChars: envInteger(env, "EASY_CODE_MAX_OUTPUT_CHARS"),
    commandTimeoutMs: envInteger(env, "EASY_CODE_COMMAND_TIMEOUT_MS"),
    qwen: compact({
      apiKey: envValue(env, "QWEN_API_KEY", "DASHSCOPE_API_KEY"),
      baseUrl: envValue(env, "QWEN_BASE_URL", "DASHSCOPE_BASE_URL"),
      model: envValue(env, "QWEN_MODEL"),
      timeoutMs: envInteger(env, "QWEN_TIMEOUT_MS"),
      maxRetries: envInteger(env, "QWEN_MAX_RETRIES"),
    }),
    deepseek: compact({
      apiKey: envValue(env, "DEEPSEEK_API_KEY"),
      baseUrl: envValue(env, "DEEPSEEK_BASE_URL"),
      model: envValue(env, "DEEPSEEK_MODEL"),
      timeoutMs: envInteger(env, "DEEPSEEK_TIMEOUT_MS"),
      maxRetries: envInteger(env, "DEEPSEEK_MAX_RETRIES"),
    }),
    glm: compact({
      apiKey: envValue(env, "ZAI_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"),
      baseUrl: envValue(env, "GLM_BASE_URL", "ZAI_BASE_URL", "ZHIPUAI_BASE_URL"),
      model: envValue(env, "GLM_MODEL"),
      timeoutMs: envInteger(env, "GLM_TIMEOUT_MS"),
      maxRetries: envInteger(env, "GLM_MAX_RETRIES"),
    }),
  });
}

async function credentialLayer(
  store: ApiKeyCredentialStore | false,
  environment: EasyCodeConfigLayer,
): Promise<EasyCodeConfigLayer> {
  if (store === false) return {};

  const read = async (
    provider: ProviderName,
    environmentValue: unknown,
  ): Promise<string | undefined> => {
    // An environment key has highest priority and avoids touching the system
    // credential store at all for that provider.
    if (environmentValue !== undefined) return undefined;
    try {
      return await store.get(provider);
    } catch {
      // Starting the agent should remain possible on headless/keyring-less
      // systems. The config command reports keyring failures explicitly.
      return undefined;
    }
  };

  const [qwenApiKey, deepseekApiKey, glmApiKey] = await Promise.all([
    read("qwen", environment.qwen?.apiKey),
    read("deepseek", environment.deepseek?.apiKey),
    read("glm", environment.glm?.apiKey),
  ]);
  return {
    qwen: compact({ apiKey: qwenApiKey }),
    deepseek: compact({ apiKey: deepseekApiKey }),
    glm: compact({ apiKey: glmApiKey }),
  };
}

function absoluteConfig(config: EasyCodeConfig, cwd: string): EasyCodeConfig {
  return {
    ...config,
    workspaceRoot: path.resolve(cwd, config.workspaceRoot),
    dataDir: path.resolve(cwd, config.dataDir),
    configDir: path.resolve(cwd, config.configDir),
    cacheDir: path.resolve(cwd, config.cacheDir),
    qwen: {
      ...config.qwen,
      baseUrl: config.qwen.baseUrl.replace(/\/+$/, ""),
    },
    deepseek: {
      ...config.deepseek,
      baseUrl: config.deepseek.baseUrl.replace(/\/+$/, ""),
    },
    glm: {
      ...config.glm,
      baseUrl: config.glm.baseUrl.replace(/\/+$/, ""),
    },
  };
}

function validationMessage(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
    .join("; ");
}

/**
 * Load defaults, user TOML, workspace TOML, system credentials, and finally
 * environment values. Explicit path options are applied last.
 * Explicit loader path/workspace options determine where configuration is found.
 */
export async function loadEasyCodeConfig(
  options: LoadEasyCodeConfigOptions = {},
): Promise<EasyCodeConfig> {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const generatedPaths = resolveEasyCodePaths(options.appName ?? "easy-code");
  const paths: EasyCodePaths = {
    configDir: path.resolve(
      options.configDir ??
        envValue(env, "EASY_CODE_CONFIG_DIR") ??
        generatedPaths.configDir,
    ),
    dataDir: path.resolve(
      options.dataDir ??
        envValue(env, "EASY_CODE_DATA_DIR") ??
        generatedPaths.dataDir,
    ),
    cacheDir: path.resolve(
      options.cacheDir ??
        envValue(env, "EASY_CODE_CACHE_DIR") ??
        generatedPaths.cacheDir,
    ),
  };
  const workspaceRoot = path.resolve(
    options.workspaceRoot ??
      envValue(env, "EASY_CODE_WORKSPACE_ROOT", "EASY_CODE_WORKSPACE") ??
      cwd,
  );

  const userConfigPath = path.resolve(
    options.userConfigPath ?? path.join(paths.configDir, "config.toml"),
  );
  const workspaceConfigPath = path.resolve(
    options.workspaceConfigPath ??
      path.join(workspaceRoot, ".easycode", "config.toml"),
  );

  const [userLayer, workspaceLayer] = await Promise.all([
    readTomlLayer(userConfigPath),
    readTomlLayer(workspaceConfigPath),
  ]);
  assertSafeWorkspaceLayer(workspaceLayer, workspaceConfigPath);
  const environment = environmentLayer(env);
  const credentials = await credentialLayer(
    options.credentialStore ?? new SystemKeyringCredentialStore(),
    environment,
  );

  let config = createDefaultEasyCodeConfig(workspaceRoot, paths);
  config = applyLayer(config, userLayer);
  config = applyLayer(config, workspaceLayer);
  config = applyLayer(config, credentials);
  config = applyLayer(config, environment);
  config = applyLayer(
    config,
    compact({
      configDir: options.configDir,
      dataDir: options.dataDir,
      cacheDir: options.cacheDir,
    }),
  );
  // Workspace selection is an invocation concern and cannot be redirected by a file.
  config.workspaceRoot = workspaceRoot;
  config = absoluteConfig(config, cwd);

  try {
    return validateEasyCodeConfig(config);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new EasyCodeConfigError(
        `Invalid EASY CODE configuration: ${validationMessage(error)}`,
      );
    }
    throw error;
  }
}

/**
 * Inspect whether a legacy user TOML contains a provider API key without
 * returning that key to callers. Configuration commands never modify this file.
 */
export async function hasLegacyUserApiKey(
  configPath: string,
  provider: ProviderName,
): Promise<boolean> {
  const layer = await readTomlLayer(path.resolve(configPath));
  const value = layer[provider]?.apiKey;
  return typeof value === "string" && value.trim().length > 0;
}
