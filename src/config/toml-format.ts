import type { RuntimeLimits } from "./runtime-limits.js";

type UnknownRecord = Record<string, unknown>;

export interface ProviderConfigLayer extends UnknownRecord {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
  maxRetries?: unknown;
}

export interface EasyCodeConfigLayer {
  approvalModel?: unknown;
  provider?: unknown;
  mode?: unknown;
  thinkingEffort?: unknown;
  approvalPolicy?: unknown;
  dataDir?: unknown;
  configDir?: unknown;
  cacheDir?: unknown;
  limits?: UnknownRecord;
  orchestrationEnabled?: unknown;
  subagentIsolation?: unknown;
  worktreeBaseMode?: unknown;
  worktreeRoot?: unknown;
  providers?: Record<string, ProviderConfigLayer>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compact<T extends UnknownRecord>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`);
}

function assertOnlyKeys(
  value: UnknownRecord,
  allowed: ReadonlySet<string>,
  scope: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(`${scope} contains unsupported key(s): ${unknown.join(", ")}`);
  }
}

function providerLayer(value: unknown, scope: string): ProviderConfigLayer {
  if (!isRecord(value)) throw new Error(`${scope} must be a TOML table`);
  assertOnlyKeys(value, new Set(["api_key", "base_url", "model", "timeout_ms", "max_retries"]), scope);
  return compact({
    apiKey: value.api_key,
    baseUrl: value.base_url,
    model: value.model,
    timeoutMs: value.timeout_ms,
    maxRetries: value.max_retries,
  });
}

function limitsLayer(
  value: unknown,
  defaults: Readonly<RuntimeLimits>,
): UnknownRecord | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("limits must be a TOML table");
  const byExternalName = new Map(
    Object.keys(defaults).map((key) => [snakeCase(key), key]),
  );
  assertOnlyKeys(value, new Set(byExternalName.keys()), "limits");
  const result: UnknownRecord = {};
  for (const [externalName, raw] of Object.entries(value)) {
    const internalName = byExternalName.get(externalName)!;
    const expected = defaults[internalName as keyof RuntimeLimits];
    if (isRecord(expected)) {
      if (!isRecord(raw)) throw new Error(`limits.${externalName} must be a TOML table`);
      assertOnlyKeys(raw, new Set(Object.keys(expected)), `limits.${externalName}`);
      result[internalName] = { ...raw };
    } else {
      result[internalName] = raw;
    }
  }
  return result;
}

/**
 * Parse the one supported user/workspace TOML shape. External names are always
 * snake_case; Runtime code sees only camelCase. This is a format boundary, not
 * a compatibility merger.
 */
export function normalizeCurrentTomlConfig(
  value: unknown,
  providerIds: readonly string[],
  defaults: Readonly<RuntimeLimits>,
): EasyCodeConfigLayer {
  if (!isRecord(value)) throw new Error("Configuration root must be a TOML table");
  const topLevel = new Set([
    "approval_model", "provider", "mode", "thinking_effort", "approval_policy",
    "data_dir", "config_dir", "cache_dir", "limits", "orchestration_enabled",
    "subagent_isolation", "worktree_base_mode", "worktree_root", "providers",
  ]);
  assertOnlyKeys(value, topLevel, "configuration");

  const rawProviders = value.providers;
  if (rawProviders !== undefined && !isRecord(rawProviders)) {
    throw new Error("providers must be a TOML table");
  }
  const providers: Record<string, ProviderConfigLayer> = {};
  if (isRecord(rawProviders)) {
    assertOnlyKeys(rawProviders, new Set(providerIds), "providers");
    for (const [provider, raw] of Object.entries(rawProviders)) {
      providers[provider] = providerLayer(raw, `providers.${provider}`);
    }
  }

  return compact({
    approvalModel: value.approval_model,
    provider: value.provider,
    mode: value.mode,
    thinkingEffort: value.thinking_effort,
    approvalPolicy: value.approval_policy,
    dataDir: value.data_dir,
    configDir: value.config_dir,
    cacheDir: value.cache_dir,
    limits: limitsLayer(value.limits, defaults),
    orchestrationEnabled: value.orchestration_enabled,
    subagentIsolation: value.subagent_isolation,
    worktreeBaseMode: value.worktree_base_mode,
    worktreeRoot: value.worktree_root,
    providers,
  });
}
