import { createHash } from "node:crypto";

import type {
  AgentMode,
  ImageAttachment,
  ProviderName,
  ThinkingEffort,
} from "../core/types.js";
import {
  PACKAGED_MODEL_CATALOG,
  PACKAGED_MODEL_CATALOG_SOURCE_HASH,
} from "./generated-catalog.js";

export interface ModelCatalogEntry {
  readonly id: string;
  readonly label: string;
  /**
   * `unknown` is intentionally conservative: EASY CODE will not send image
   * bytes until the provider documents that exact model identifier.
   */
  readonly vision: VisionSupport;
  readonly thinking: ThinkingProfile;
}

export type VisionSupport = "supported" | "unsupported" | "unknown";
export type ThinkingProfile =
  | "unsupported"
  | "qwen_budget"
  | "deepseek_effort"
  | "glm_forced_effort"
  | "glm_optional_effort";
export type ProviderAdapter = "qwen" | "deepseek" | "glm";
export type ProviderEnvironmentField = keyof ProviderEnvironmentCatalog;

export interface ProviderEnvironmentCatalog {
  readonly apiKey: readonly string[];
  readonly baseUrl: readonly string[];
  readonly model: readonly string[];
  readonly timeoutMs: readonly string[];
  readonly maxRetries: readonly string[];
}

export interface ProviderCatalogEntry {
  readonly provider: ProviderName;
  readonly label: string;
  readonly vendor: string;
  readonly adapter: ProviderAdapter;
  readonly credentialSlot: ProviderName;
  readonly configKey: `${ProviderName}.api-key`;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
  readonly environment: ProviderEnvironmentCatalog;
  readonly models: readonly ModelCatalogEntry[];
}

export interface BenchmarkProfile {
  readonly provider: ProviderName;
  readonly model: string;
  readonly mode: AgentMode;
  readonly thinkingEffort: ThinkingEffort;
}

export interface ModelCatalog {
  readonly catalogVersion: number;
  readonly providers: readonly ProviderCatalogEntry[];
  readonly profiles: Readonly<{
    sweBenchVerified50: BenchmarkProfile;
  }>;
}

export const PROVIDER_NAMES = [
  "qwen",
  "deepseek",
  "glm",
  "glm-coding-plan",
] as const satisfies readonly ProviderName[];
const PROVIDER_NAME_SET = new Set<string>(PROVIDER_NAMES);
const PROVIDER_ADAPTERS = new Set<ProviderAdapter>(["qwen", "deepseek", "glm"]);
const VISION_VALUES = new Set<VisionSupport>([
  "supported",
  "unsupported",
  "unknown",
]);
const THINKING_VALUES = new Set<ThinkingProfile>([
  "unsupported",
  "qwen_budget",
  "deepseek_effort",
  "glm_forced_effort",
  "glm_optional_effort",
]);
const ENVIRONMENT_FIELDS = [
  "apiKey",
  "baseUrl",
  "model",
  "timeoutMs",
  "maxRetries",
] as const satisfies readonly ProviderEnvironmentField[];
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/u;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function assertRecord(
  value: unknown,
  source: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  source: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${source} fields must be exactly: ${wanted.join(", ")}`);
  }
}

function requireNonEmptyString(value: unknown, source: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${source} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function requireHttpsBaseUrl(value: unknown, source: string): string {
  const result = requireNonEmptyString(value, source);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error(`${source} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    result.endsWith("/")
  ) {
    throw new Error(
      `${source} must be an HTTPS base URL without credentials, query, fragment, or trailing slash`,
    );
  }
  return result;
}

function parseEnvironment(
  value: unknown,
  source: string,
): ProviderEnvironmentCatalog {
  assertRecord(value, source);
  assertExactKeys(value, ENVIRONMENT_FIELDS, source);
  const parsed = Object.fromEntries(
    ENVIRONMENT_FIELDS.map((field) => {
      const names = value[field];
      if (!Array.isArray(names) || names.length === 0) {
        throw new Error(`${source}.${field} must be a non-empty array`);
      }
      const unique = new Set<string>();
      const validated = names.map((name, index) => {
        const result = requireNonEmptyString(name, `${source}.${field}[${index}]`);
        if (!ENVIRONMENT_NAME.test(result)) {
          throw new Error(`${source}.${field}[${index}] is not an environment variable name`);
        }
        if (unique.has(result)) {
          throw new Error(`${source}.${field} contains duplicate ${result}`);
        }
        unique.add(result);
        return result;
      });
      return [field, Object.freeze(validated)] as const;
    }),
  ) as unknown as ProviderEnvironmentCatalog;
  return Object.freeze(parsed);
}

function parseModel(value: unknown, source: string): ModelCatalogEntry {
  assertRecord(value, source);
  assertExactKeys(value, ["id", "label", "vision", "thinking"], source);
  const id = requireNonEmptyString(value.id, `${source}.id`);
  if (!MODEL_ID.test(id)) {
    throw new Error(`${source}.id must be a normalized model identifier`);
  }
  const label = requireNonEmptyString(value.label, `${source}.label`);
  if (!VISION_VALUES.has(value.vision as VisionSupport)) {
    throw new Error(`${source}.vision is unsupported`);
  }
  if (!THINKING_VALUES.has(value.thinking as ThinkingProfile)) {
    throw new Error(`${source}.thinking is unsupported`);
  }
  return Object.freeze({
    id,
    label,
    vision: value.vision as VisionSupport,
    thinking: value.thinking as ThinkingProfile,
  });
}

function parseProvider(value: unknown, index: number): ProviderCatalogEntry {
  const source = `model catalog providers[${index}]`;
  assertRecord(value, source);
  assertExactKeys(value, [
    "id",
    "label",
    "vendor",
    "adapter",
    "credentialSlot",
    "configKey",
    "defaultBaseUrl",
    "defaultModel",
    "environment",
    "models",
  ], source);
  const provider = requireNonEmptyString(value.id, `${source}.id`);
  if (!PROVIDER_NAME_SET.has(provider)) {
    throw new Error(`${source}.id is unsupported: ${provider}`);
  }
  const adapter = requireNonEmptyString(value.adapter, `${source}.adapter`);
  if (!PROVIDER_ADAPTERS.has(adapter as ProviderAdapter)) {
    throw new Error(`${source}.adapter is unsupported: ${adapter}`);
  }
  const expectedAdapter: ProviderAdapter = provider === "glm-coding-plan"
    ? "glm"
    : provider as ProviderAdapter;
  if (adapter !== expectedAdapter) {
    throw new Error(`${source}.adapter must be ${expectedAdapter}`);
  }
  if (value.credentialSlot !== provider) {
    throw new Error(`${source}.credentialSlot must equal its provider id`);
  }
  if (value.configKey !== `${provider}.api-key`) {
    throw new Error(`${source}.configKey must be ${provider}.api-key`);
  }
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new Error(`${source}.models must be a non-empty array`);
  }
  const models = value.models.map((model, modelIndex) =>
    parseModel(model, `${source}.models[${modelIndex}]`));
  const modelIds = new Set(models.map((model) => model.id));
  if (modelIds.size !== models.length) {
    throw new Error(`${source}.models contains duplicate model ids`);
  }
  const modelLabels = new Set(models.map((model) => model.label.toLowerCase()));
  if (modelLabels.size !== models.length) {
    throw new Error(`${source}.models contains duplicate model labels`);
  }
  if (
    provider === "glm-coding-plan" &&
    models.some((model) => model.vision !== "unsupported")
  ) {
    throw new Error(
      `${source}.models must disable direct vision for GLM Coding Plan`,
    );
  }
  const defaultModel = requireNonEmptyString(
    value.defaultModel,
    `${source}.defaultModel`,
  );
  if (!modelIds.has(defaultModel)) {
    throw new Error(`${source}.defaultModel is not present in models`);
  }
  return Object.freeze({
    provider: provider as ProviderName,
    label: requireNonEmptyString(value.label, `${source}.label`),
    vendor: requireNonEmptyString(value.vendor, `${source}.vendor`),
    adapter: adapter as ProviderAdapter,
    credentialSlot: provider as ProviderName,
    configKey: `${provider}.api-key` as `${ProviderName}.api-key`,
    defaultBaseUrl: requireHttpsBaseUrl(
      value.defaultBaseUrl,
      `${source}.defaultBaseUrl`,
    ),
    defaultModel,
    environment: parseEnvironment(value.environment, `${source}.environment`),
    models: Object.freeze(models),
  });
}

function parseProfile(
  value: unknown,
  providers: readonly ProviderCatalogEntry[],
): BenchmarkProfile {
  const source = "model catalog profiles.sweBenchVerified50";
  assertRecord(value, source);
  assertExactKeys(value, ["provider", "model", "mode", "thinkingEffort"], source);
  const provider = requireNonEmptyString(value.provider, `${source}.provider`);
  if (provider !== "glm-coding-plan") {
    throw new Error(`${source}.provider must be glm-coding-plan`);
  }
  const entry = providers.find((candidate) => candidate.provider === provider);
  if (!entry) throw new Error(`${source}.provider is unsupported: ${provider}`);
  const model = requireNonEmptyString(value.model, `${source}.model`);
  if (!entry.models.some((candidate) => candidate.id === model)) {
    throw new Error(`${source}.model is not in provider ${provider}`);
  }
  if (!(value.mode === "plan" || value.mode === "auto" || value.mode === "code")) {
    throw new Error(`${source}.mode is unsupported`);
  }
  if (!(value.thinkingEffort === "none" || value.thinkingEffort === "low" || value.thinkingEffort === "medium" || value.thinkingEffort === "high")) {
    throw new Error(`${source}.thinkingEffort is unsupported`);
  }
  return Object.freeze({
    provider: provider as ProviderName,
    model,
    mode: value.mode,
    thinkingEffort: value.thinkingEffort,
  });
}

/** Strictly parse the trusted, versioned provider/model catalog. */
export function parseModelCatalog(value: unknown): ModelCatalog {
  const source = "model catalog";
  assertRecord(value, source);
  assertExactKeys(value, ["catalogVersion", "providers", "profiles"], source);
  if (value.catalogVersion !== 1) {
    throw new Error("Unsupported model catalog version");
  }
  if (!Array.isArray(value.providers)) {
    throw new Error("model catalog providers must be an array");
  }
  const providers = value.providers.map(parseProvider);
  const ids = providers.map((entry) => entry.provider);
  if (
    ids.length !== PROVIDER_NAMES.length ||
    PROVIDER_NAMES.some((provider) => !ids.includes(provider)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error(
      `model catalog must contain each provider exactly once: ${PROVIDER_NAMES.join(", ")}`,
    );
  }

  // Environment aliases must never make standard GLM and Coding Plan inherit
  // each other's credentials, endpoints, model choices, or retry policy.
  const standardGlm = providers.find((entry) => entry.provider === "glm");
  const codingPlan = providers.find((entry) => entry.provider === "glm-coding-plan");
  if (!standardGlm || !codingPlan) throw new Error("model catalog GLM providers are missing");
  for (const field of ENVIRONMENT_FIELDS) {
    const standardNames = new Set(standardGlm.environment[field]);
    const overlap = codingPlan.environment[field].filter((name) => standardNames.has(name));
    if (overlap.length > 0) {
      throw new Error(
        `model catalog GLM environment.${field} overlaps Coding Plan: ${overlap.join(", ")}`,
      );
    }
  }

  assertRecord(value.profiles, "model catalog profiles");
  assertExactKeys(value.profiles, ["sweBenchVerified50"], "model catalog profiles");
  const profile = parseProfile(value.profiles.sweBenchVerified50, providers);
  return Object.freeze({
    catalogVersion: 1,
    providers: Object.freeze(providers),
    profiles: Object.freeze({ sweBenchVerified50: profile }),
  });
}

let activeModelCatalog = parseModelCatalog(PACKAGED_MODEL_CATALOG);

export let PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = activeModelCatalog.providers;
export let DEFAULT_MODEL_IDS: Readonly<Record<ProviderName, string>> =
  defaultModelIds(activeModelCatalog.providers);
export let BENCHMARK_PROFILES: ModelCatalog["profiles"] = activeModelCatalog.profiles;
export let ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES: readonly string[] =
  allApiKeyEnvironmentVariables(activeModelCatalog.providers);

function defaultModelIds(
  providers: readonly ProviderCatalogEntry[],
): Readonly<Record<ProviderName, string>> {
  return Object.freeze(Object.fromEntries(
    providers.map((entry) => [entry.provider, entry.defaultModel]),
  )) as Readonly<Record<ProviderName, string>>;
}

function allApiKeyEnvironmentVariables(
  providers: readonly ProviderCatalogEntry[],
): readonly string[] {
  return Object.freeze([
    ...new Set(providers.flatMap((entry) => entry.environment.apiKey)),
  ]);
}

/** Activate the verified installed catalog only if it matches this build exactly. */
export function activateInstalledModelCatalog(sourceText: string): void {
  const sourceHash = `sha256:${createHash("sha256").update(sourceText, "utf8").digest("hex")}`;
  if (sourceHash !== PACKAGED_MODEL_CATALOG_SOURCE_HASH) {
    throw new Error(
      `Installed model catalog hash mismatch: expected ${PACKAGED_MODEL_CATALOG_SOURCE_HASH}, received ${sourceHash}`,
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(sourceText) as unknown;
  } catch {
    throw new Error("Installed model catalog is not valid JSON");
  }
  const parsed = parseModelCatalog(parsedJson);
  const providers = parsed.providers;
  const models = defaultModelIds(providers);
  const apiKeyVariables = allApiKeyEnvironmentVariables(providers);
  activeModelCatalog = parsed;
  PROVIDER_CATALOG = providers;
  DEFAULT_MODEL_IDS = models;
  BENCHMARK_PROFILES = parsed.profiles;
  ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES = apiKeyVariables;
}

export function providerCatalogEntry(provider: ProviderName): ProviderCatalogEntry {
  const entry = PROVIDER_CATALOG.find((candidate) => candidate.provider === provider);
  if (!entry) throw new Error(`Unsupported provider: ${provider}`);
  return entry;
}

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && PROVIDER_NAME_SET.has(value);
}

export function providerLabel(provider: ProviderName): string {
  return providerCatalogEntry(provider).label;
}

export function providerEnvironment(provider: ProviderName): ProviderEnvironmentCatalog {
  return providerCatalogEntry(provider).environment;
}

export function providerApiKeyEnvironmentVariables(
  provider: ProviderName,
): readonly string[] {
  return providerEnvironment(provider).apiKey;
}

export function providerCredentialConfigKey(
  provider: ProviderName,
): `${ProviderName}.api-key` {
  return providerCatalogEntry(provider).configKey;
}

export function sweBenchVerified50Profile(): BenchmarkProfile {
  return BENCHMARK_PROFILES.sweBenchVerified50;
}

export function modelsForProvider(provider: ProviderName): readonly ModelCatalogEntry[] {
  return providerCatalogEntry(provider).models;
}

export function resolveCatalogModel(
  provider: ProviderName,
  value: string,
): ModelCatalogEntry | undefined {
  const normalized = value.trim().toLowerCase();
  return modelsForProvider(provider).find(
    (entry) => entry.id.toLowerCase() === normalized || entry.label.toLowerCase() === normalized,
  );
}

export function requireCatalogModel(provider: ProviderName, value: string): ModelCatalogEntry {
  const model = resolveCatalogModel(provider, value);
  if (model) return model;
  const supported = modelsForProvider(provider).map((entry) => entry.id).join(", ");
  throw new Error(
    `Model ${JSON.stringify(value)} is not in the ${providerLabel(provider)} catalog. ` +
      `Supported models: ${supported}`,
  );
}

export function modelVisionSupport(provider: ProviderName, model: string): VisionSupport {
  return resolveCatalogModel(provider, model)?.vision ?? "unknown";
}

export function modelSupportsVision(provider: ProviderName, model: string): boolean {
  return modelVisionSupport(provider, model) === "supported";
}

export function requireVisionModel(provider: ProviderName, model: string): void {
  const support = modelVisionSupport(provider, model);
  if (support === "supported") return;
  const models = modelsForProvider(provider)
    .filter((entry) => entry.vision === "supported")
    .map((entry) => entry.id)
    .join(", ");
  const reason = support === "unknown"
    ? "its image capability is not verified"
    : "it is text-only";
  const nextStep = models.length > 0
    ? `Choose an image-capable model with /model: ${models}`
    : "Remove the image or use /model to switch to a provider with direct image support.";
  throw new Error(
    `${providerLabel(provider)} model ${model} cannot accept images because ${reason}. ` + nextStep,
  );
}

/** Validate documented image-input constraints before a turn is persisted. */
export function validateProviderImageAttachments(
  provider: ProviderName,
  images: readonly ImageAttachment[],
): void {
  for (const attachment of images) {
    const issue = providerImageCompatibilityIssue(provider, attachment);
    if (issue) throw new Error(issue);
  }
}

/** Return the documented provider-specific incompatibility without mutating history. */
export function providerImageCompatibilityIssue(
  provider: ProviderName,
  attachment: ImageAttachment,
): string | undefined {
  if (provider !== "qwen") return undefined;
  const { width, height, mediaType, label } = attachment;
  if (width <= 10 || height <= 10) {
    return `${label} must be larger than 10x10 pixels for Alibaba Qwen.`;
  }
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  if (longEdge / shortEdge > 200) {
    return `${label} exceeds Alibaba Qwen's 200:1 aspect-ratio limit.`;
  }
  if (longEdge > 7_680 || shortEdge > 4_320) {
    return `${label} exceeds Alibaba Qwen's 8K image limit.`;
  }
  if (mediaType === "image/gif") {
    return `${label} uses GIF, which Alibaba Qwen does not accept.`;
  }
  if (longEdge > 4_096 && mediaType !== "image/png" && mediaType !== "image/jpeg") {
    return `${label} must use PNG or JPEG when its longest edge exceeds 4096 pixels for Alibaba Qwen.`;
  }
  return undefined;
}
