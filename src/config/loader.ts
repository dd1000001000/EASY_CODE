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
  PROVIDER_CATALOG,
  providerEnvironment,
} from "../models/catalog.js";
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
import {
  normalizeCurrentTomlConfig,
  type EasyCodeConfigLayer,
  type ProviderConfigLayer,
} from "./toml-format.js";
import { DEFAULT_RUNTIME_LIMITS } from "./runtime-limits.js";

type UnknownRecord = Record<string, unknown>;

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
    approvalModel: layer.approvalModel,
    dataDir: layer.dataDir,
    configDir: layer.configDir,
    cacheDir: layer.cacheDir,
    orchestrationEnabled: layer.orchestrationEnabled,
    subagentIsolation: layer.subagentIsolation,
    worktreeBaseMode: layer.worktreeBaseMode,
    worktreeRoot: layer.worktreeRoot,
  });

  const providers = Object.fromEntries(
    Object.entries(base.providers).map(([provider, providerConfig]) => [
      provider,
      applyProviderLayer(providerConfig, layer.providers?.[provider]),
    ]),
  );
  return {
    ...base,
    ...topLevel,
    limits: {
      ...base.limits, ...layer.limits,
      steps: layer.limits?.steps === undefined ? base.limits.steps
        : isRecord(layer.limits.steps) ? { ...base.limits.steps, ...layer.limits.steps }
          : layer.limits.steps,
      maxConcurrentSubagents: layer.limits?.maxConcurrentSubagents === undefined ? base.limits.maxConcurrentSubagents
        : isRecord(layer.limits.maxConcurrentSubagents) ? { ...base.limits.maxConcurrentSubagents, ...layer.limits.maxConcurrentSubagents }
          : layer.limits.maxConcurrentSubagents,
      providerTimeoutMs: layer.limits?.providerTimeoutMs === undefined ? base.limits.providerTimeoutMs
        : isRecord(layer.limits.providerTimeoutMs) ? { ...base.limits.providerTimeoutMs, ...layer.limits.providerTimeoutMs }
          : layer.limits.providerTimeoutMs,
    },
    providers,
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
    return normalizeCurrentTomlConfig(
      parseToml(source) as unknown,
      PROVIDER_CATALOG.map(({ provider }) => provider),
      DEFAULT_RUNTIME_LIMITS,
    );
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
  if (layer.approvalModel !== undefined) forbidden.push("approval_model");
  for (const [provider, providerLayer] of Object.entries(layer.providers ?? {})) {
    if (providerLayer.apiKey !== undefined) forbidden.push(`providers.${provider}.api_key`);
    if (providerLayer.baseUrl !== undefined) forbidden.push(`providers.${provider}.base_url`);
  }
  if (layer.configDir !== undefined) forbidden.push("config_dir");
  if (layer.dataDir !== undefined) forbidden.push("data_dir");
  if (layer.cacheDir !== undefined) forbidden.push("cache_dir");
  if (layer.worktreeRoot !== undefined) forbidden.push("worktree_root");
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
  const orchestrationValue = envValue(env, "EASY_CODE_ORCHESTRATION_ENABLED");
  if (orchestrationValue !== undefined && orchestrationValue !== "true" && orchestrationValue !== "false") {
    throw new EasyCodeConfigError("EASY_CODE_ORCHESTRATION_ENABLED must be true or false");
  }
  let limits: UnknownRecord | undefined;
  const encodedLimits = envValue(env, "EASY_CODE_LIMITS_JSON");
  if (encodedLimits) {
    try {
      const parsed: unknown = JSON.parse(encodedLimits);
      if (!isRecord(parsed)) throw new Error();
      limits = parsed;
    } catch { throw new EasyCodeConfigError("EASY_CODE_LIMITS_JSON must be a JSON object"); }
  }
  const providerLayers = Object.fromEntries(
    PROVIDER_CATALOG.map(({ provider }) => {
      const names = providerEnvironment(provider);
      return [provider, compact({
        apiKey: envValue(env, ...names.apiKey),
        baseUrl: envValue(env, ...names.baseUrl),
        model: envValue(env, ...names.model),
        timeoutMs: envInteger(env, ...names.timeoutMs),
        maxRetries: envInteger(env, ...names.maxRetries),
      })];
    }),
  );
  return compact({
    provider: envValue(env, "EASY_CODE_PROVIDER"),
    mode: envValue(env, "EASY_CODE_MODE"),
    thinkingEffort: envValue(env, "EASY_CODE_THINKING_EFFORT"),
    approvalPolicy: envValue(env, "EASY_CODE_APPROVAL_POLICY"),
    orchestrationEnabled: orchestrationValue === undefined ? undefined : orchestrationValue === "true",
    dataDir: envValue(env, "EASY_CODE_DATA_DIR"),
    configDir: envValue(env, "EASY_CODE_CONFIG_DIR"),
    cacheDir: envValue(env, "EASY_CODE_CACHE_DIR"),
    limits,
    subagentIsolation: envValue(env, "EASY_CODE_SUBAGENT_ISOLATION"),
    worktreeBaseMode: envValue(env, "EASY_CODE_WORKTREE_BASE_MODE"),
    worktreeRoot: envValue(env, "EASY_CODE_WORKTREE_ROOT"),
    providers: providerLayers,
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

  const entries = await Promise.all(
    PROVIDER_CATALOG.map(async ({ provider }) => [
      provider,
      compact({ apiKey: await read(provider, environment.providers?.[provider]?.apiKey) }),
    ] as const),
  );
  return { providers: Object.fromEntries(entries) };
}

function absoluteConfig(config: EasyCodeConfig, cwd: string): EasyCodeConfig {
  const providers = Object.fromEntries(Object.entries(config.providers).map(
    ([provider, providerConfig]) => [provider, {
      ...providerConfig,
      baseUrl: providerConfig.baseUrl.replace(/\/+$/, ""),
    }],
  ));
  return {
    ...config,
    workspaceRoot: path.resolve(cwd, config.workspaceRoot),
    dataDir: path.resolve(cwd, config.dataDir),
    configDir: path.resolve(cwd, config.configDir),
    cacheDir: path.resolve(cwd, config.cacheDir),
    worktreeRoot: path.resolve(cwd, config.worktreeRoot),
    providers,
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
      envValue(env, "EASY_CODE_WORKSPACE_ROOT") ??
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
