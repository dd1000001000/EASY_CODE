import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "toml";
import { z } from "zod";

import type { AgentMode, ImageAttachment, ProviderName, ThinkingEffort } from "../core/types.js";

export type WireApi = "chat_completions" | "responses";
export type VisionSupport = "supported" | "unsupported" | "unknown";

export interface ModelCatalogEntry {
  readonly alias: string;
  /** Exact model identifier sent over the wire. */
  readonly id: string;
  readonly label: string;
  readonly vision: VisionSupport;
  readonly reasoning: boolean;
  readonly toolCalling: boolean;
  readonly contextWindowTokens?: number;
}

export interface ProviderEnvironmentCatalog {
  readonly apiKey: readonly string[];
  readonly baseUrl: readonly string[];
  readonly model: readonly string[];
  readonly timeoutMs: readonly string[];
  readonly maxRetries: readonly string[];
}

export interface ProviderImageConstraints {
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly maxLongEdge?: number;
  readonly maxShortEdge?: number;
  readonly maxAspectRatio?: number;
  readonly blockedMediaTypes: readonly string[];
  readonly largeImageThreshold?: number;
  readonly largeImageMediaTypes: readonly string[];
}

export interface ProviderCatalogEntry {
  readonly provider: ProviderName;
  readonly label: string;
  readonly vendor: string;
  readonly wireApi: WireApi;
  readonly credentialSlot: ProviderName;
  readonly configKey: `${string}.api-key`;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
  readonly requestTimeoutMs?: number;
  readonly maxRetries: number;
  readonly supportsTemperature: boolean;
  readonly supportsStrictTools: boolean;
  readonly imageConstraints?: ProviderImageConstraints;
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
  readonly defaultModelAlias: string;
  readonly providers: readonly ProviderCatalogEntry[];
  readonly profiles: Readonly<{ sweBenchVerified50: BenchmarkProfile }>;
  readonly sourceHash: string;
}

const idSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const providerIdSchema = z.string().trim().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const envSchema = z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/u);
const imageConstraintsSchema = z.object({
  min_width: z.number().int().positive().optional(),
  min_height: z.number().int().positive().optional(),
  max_long_edge: z.number().int().positive().optional(),
  max_short_edge: z.number().int().positive().optional(),
  max_aspect_ratio: z.number().positive().optional(),
  blocked_media_types: z.array(z.string().trim().regex(/^image\/[a-z0-9.+-]+$/u)).default([]),
  large_image_threshold: z.number().int().positive().optional(),
  large_image_media_types: z.array(z.string().trim().regex(/^image\/[a-z0-9.+-]+$/u)).default([]),
}).strict()
  .refine(
    (value) => value.large_image_threshold === undefined || value.large_image_media_types.length > 0,
    "large_image_media_types is required with large_image_threshold",
  )
  .refine(
    (value) => value.max_long_edge === undefined || value.max_short_edge === undefined || value.max_short_edge <= value.max_long_edge,
    "max_short_edge cannot exceed max_long_edge",
  );
const providerSchema = z.object({
  name: z.string().trim().min(1),
  base_url: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "must be an HTTPS URL without credentials, query, or fragment"),
  env_key: envSchema,
  env_key_aliases: z.array(envSchema).default([]),
  wire_api: z.enum(["chat_completions", "responses"]),
  request_timeout_ms: z.number().int().positive().optional(),
  max_retries: z.number().int().min(0).max(10).default(3),
  supports_temperature: z.boolean().default(true),
  supports_strict_tools: z.boolean().default(true),
  image_constraints: imageConstraintsSchema.optional(),
}).strict();
const modelSchema = z.object({
  name: z.string().trim().min(1),
  provider: providerIdSchema,
  model: z.string().trim().min(1),
  context_window: z.number().int().min(4096).optional(),
  input_modalities: z.array(z.enum(["text", "image"])).min(1),
  tool_calling: z.boolean().default(true),
  reasoning: z.boolean().default(false),
}).strict();
const profileSchema = z.object({
  model: idSchema,
  mode: z.enum(["plan", "auto", "code"]),
  thinking_effort: z.enum(["none", "low", "medium", "high"]),
}).strict();
const registrySchema = z.object({
  schema_version: z.literal(1),
  default_model: idSchema,
  providers: z.record(providerIdSchema, providerSchema),
  models: z.record(idSchema, modelSchema),
  profiles: z.object({ swe_bench_verified_50: profileSchema }).strict().optional(),
}).strict();

const packagedRegistryCandidates = [
  fileURLToPath(new URL("../../resources/models.default.toml", import.meta.url)),
  fileURLToPath(new URL("../../../resources/models.default.toml", import.meta.url)),
];
const packagedRegistryPath = packagedRegistryCandidates.find(existsSync) ?? packagedRegistryCandidates[0]!;
export const USER_MODEL_REGISTRY_PATH = path.join(os.homedir(), ".easy_code", "models.toml");
export const PACKAGED_MODEL_REGISTRY_SOURCE = readFileSync(packagedRegistryPath, "utf8");

function envPrefix(provider: string): string {
  return provider.replace(/[^a-z0-9]+/giu, "_").toUpperCase();
}

function parseSource(source: string, sourceName: string): ModelCatalog {
  let document: unknown;
  try { document = parseToml(source) as unknown; }
  catch { throw new Error(`Unable to parse model registry TOML: ${sourceName}`); }
  const parsed = registrySchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid model registry ${sourceName}: ${issue?.path.join(".") || "root"}: ${issue?.message || "invalid value"}`);
  }

  const modelsByProvider = new Map<string, ModelCatalogEntry[]>();
  for (const [alias, model] of Object.entries(parsed.data.models)) {
    if (!parsed.data.providers[model.provider]) throw new Error(`Model ${alias} references unknown provider ${model.provider}`);
    const entries = modelsByProvider.get(model.provider) ?? [];
    if (entries.some((entry) => entry.id === model.model)) throw new Error(`Provider ${model.provider} defines model ${model.model} more than once`);
    entries.push(Object.freeze({
      alias,
      id: model.model,
      label: model.name,
      vision: model.input_modalities.includes("image") ? "supported" : "unsupported",
      reasoning: model.reasoning,
      toolCalling: model.tool_calling,
      ...(model.context_window === undefined ? {} : { contextWindowTokens: model.context_window }),
    }));
    modelsByProvider.set(model.provider, entries);
  }
  const defaultEntry = parsed.data.models[parsed.data.default_model];
  if (!defaultEntry) throw new Error(`default_model ${parsed.data.default_model} is not defined`);

  const credentialEnvironmentOwners = new Map<string, string>();
  for (const [provider, value] of Object.entries(parsed.data.providers)) {
    for (const environmentName of [value.env_key, ...value.env_key_aliases]) {
      const owner = credentialEnvironmentOwners.get(environmentName);
      if (owner) throw new Error(`Credential environment variable ${environmentName} is shared by providers ${owner} and ${provider}`);
      credentialEnvironmentOwners.set(environmentName, provider);
    }
  }

  const providers = Object.entries(parsed.data.providers).map(([provider, value]) => {
    const models = modelsByProvider.get(provider) ?? [];
    if (models.length === 0) throw new Error(`Provider ${provider} has no models`);
    const defaultForProvider = provider === defaultEntry.provider
      ? models.find((entry) => entry.alias === parsed.data.default_model) ?? models[0]!
      : models[0]!;
    const prefix = envPrefix(provider);
    return Object.freeze({
      provider,
      label: value.name,
      vendor: value.name,
      wireApi: value.wire_api,
      credentialSlot: provider,
      configKey: `${provider}.api-key` as `${string}.api-key`,
      defaultBaseUrl: value.base_url.replace(/\/+$/u, ""),
      defaultModel: defaultForProvider.id,
      ...(value.request_timeout_ms === undefined ? {} : { requestTimeoutMs: value.request_timeout_ms }),
      maxRetries: value.max_retries,
      supportsTemperature: value.supports_temperature,
      supportsStrictTools: value.supports_strict_tools,
      ...(value.image_constraints
        ? {
            imageConstraints: Object.freeze({
              ...(value.image_constraints.min_width === undefined ? {} : { minWidth: value.image_constraints.min_width }),
              ...(value.image_constraints.min_height === undefined ? {} : { minHeight: value.image_constraints.min_height }),
              ...(value.image_constraints.max_long_edge === undefined ? {} : { maxLongEdge: value.image_constraints.max_long_edge }),
              ...(value.image_constraints.max_short_edge === undefined ? {} : { maxShortEdge: value.image_constraints.max_short_edge }),
              ...(value.image_constraints.max_aspect_ratio === undefined ? {} : { maxAspectRatio: value.image_constraints.max_aspect_ratio }),
              blockedMediaTypes: Object.freeze([...value.image_constraints.blocked_media_types]),
              ...(value.image_constraints.large_image_threshold === undefined ? {} : { largeImageThreshold: value.image_constraints.large_image_threshold }),
              largeImageMediaTypes: Object.freeze([...value.image_constraints.large_image_media_types]),
            }),
          }
        : {}),
      environment: Object.freeze({
        apiKey: Object.freeze([value.env_key, ...value.env_key_aliases]),
        baseUrl: Object.freeze([`EASY_CODE_${prefix}_BASE_URL`, `${prefix}_BASE_URL`]),
        model: Object.freeze([`EASY_CODE_${prefix}_MODEL`, `${prefix}_MODEL`]),
        timeoutMs: Object.freeze([`EASY_CODE_${prefix}_TIMEOUT_MS`, `${prefix}_TIMEOUT_MS`]),
        maxRetries: Object.freeze([`EASY_CODE_${prefix}_MAX_RETRIES`, `${prefix}_MAX_RETRIES`]),
      }),
      models: Object.freeze(models),
    });
  });

  const profile = parsed.data.profiles?.swe_bench_verified_50;
  const profileModel = profile ? parsed.data.models[profile.model] : undefined;
  if (profile && !profileModel) throw new Error(`Benchmark profile references unknown model alias ${profile.model}`);
  if (profileModel && !profileModel.tool_calling) throw new Error(`Benchmark profile model ${profile!.model} must support tool calling`);
  const fallbackProfile: BenchmarkProfile = Object.freeze({ provider: defaultEntry.provider, model: defaultEntry.model, mode: "code", thinkingEffort: "high" });
  return Object.freeze({
    catalogVersion: 1,
    defaultModelAlias: parsed.data.default_model,
    providers: Object.freeze(providers),
    profiles: Object.freeze({
      sweBenchVerified50: profile && profileModel
        ? Object.freeze({ provider: profileModel.provider, model: profileModel.model, mode: profile.mode, thinkingEffort: profile.thinking_effort })
        : fallbackProfile,
    }),
    sourceHash: `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`,
  });
}

// Imports are deterministic and side-effect free. CLI startup explicitly calls
// ensureUserModelRegistry() before it builds commands or creates an app.
let activeModelCatalog = parseSource(PACKAGED_MODEL_REGISTRY_SOURCE, packagedRegistryPath);
export let PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = activeModelCatalog.providers;
export let PROVIDER_NAMES: readonly string[] = Object.freeze(PROVIDER_CATALOG.map(({ provider }) => provider));
export let DEFAULT_MODEL_IDS: Readonly<Record<string, string>> = defaultModelIds(PROVIDER_CATALOG);
export let BENCHMARK_PROFILES: ModelCatalog["profiles"] = activeModelCatalog.profiles;
export let ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES: readonly string[] = allApiKeyVariables(PROVIDER_CATALOG);
export let ACTIVE_MODEL_REGISTRY_HASH = activeModelCatalog.sourceHash;
export let DEFAULT_PROVIDER_NAME: ProviderName = providerForDefaultModel(activeModelCatalog);

function defaultModelIds(providers: readonly ProviderCatalogEntry[]): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(providers.map((entry) => [entry.provider, entry.defaultModel])));
}
function allApiKeyVariables(providers: readonly ProviderCatalogEntry[]): readonly string[] {
  return Object.freeze([...new Set(providers.flatMap((entry) => entry.environment.apiKey))]);
}
function providerForDefaultModel(catalog: ModelCatalog): ProviderName {
  const provider = catalog.providers.find((entry) =>
    entry.models.some((model) => model.alias === catalog.defaultModelAlias));
  if (!provider) throw new Error("The model registry default model has no provider");
  return provider.provider;
}

export function activateModelRegistry(source: string, sourceName = USER_MODEL_REGISTRY_PATH): ModelCatalog {
  const parsed = parseSource(source, sourceName);
  activeModelCatalog = parsed;
  PROVIDER_CATALOG = parsed.providers;
  PROVIDER_NAMES = Object.freeze(parsed.providers.map(({ provider }) => provider));
  DEFAULT_MODEL_IDS = defaultModelIds(parsed.providers);
  BENCHMARK_PROFILES = parsed.profiles;
  ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES = allApiKeyVariables(parsed.providers);
  ACTIVE_MODEL_REGISTRY_HASH = parsed.sourceHash;
  DEFAULT_PROVIDER_NAME = providerForDefaultModel(parsed);
  return parsed;
}

/** Compatibility alias retained for old embedders. The input is now TOML. */
export function activateInstalledModelCatalog(sourceText: string): void { activateModelRegistry(sourceText, "installed model registry"); }

export async function ensureUserModelRegistry(registryPath = USER_MODEL_REGISTRY_PATH): Promise<string> {
  await mkdir(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  try { await writeFile(registryPath, PACKAGED_MODEL_REGISTRY_SOURCE, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await chmod(registryPath, 0o600).catch(() => undefined);
  const source = await readFile(registryPath, "utf8");
  activateModelRegistry(source, registryPath);
  return registryPath;
}

export function parseModelCatalog(value: unknown): ModelCatalog {
  if (typeof value !== "string") throw new Error("Model registry must be TOML text");
  return parseSource(value, "model registry");
}
export function providerCatalogEntry(provider: ProviderName): ProviderCatalogEntry {
  const entry = PROVIDER_CATALOG.find((candidate) => candidate.provider === provider);
  if (!entry) throw new Error(`Unsupported provider: ${provider}`);
  return entry;
}
export function isProviderName(value: unknown): value is ProviderName { return typeof value === "string" && PROVIDER_CATALOG.some((entry) => entry.provider === value); }
/** Syntax-only check for durable history whose registry may no longer be active. */
export function isProviderIdentifier(value: unknown): value is ProviderName { return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value); }
export function providerLabel(provider: ProviderName): string { return providerCatalogEntry(provider).label; }
export function providerEnvironment(provider: ProviderName): ProviderEnvironmentCatalog { return providerCatalogEntry(provider).environment; }
export function providerApiKeyEnvironmentVariables(provider: ProviderName): readonly string[] { return providerEnvironment(provider).apiKey; }
export function providerCredentialConfigKey(provider: ProviderName): `${string}.api-key` { return providerCatalogEntry(provider).configKey; }
export function sweBenchVerified50Profile(): BenchmarkProfile { return BENCHMARK_PROFILES.sweBenchVerified50; }
export function modelsForProvider(provider: ProviderName): readonly ModelCatalogEntry[] { return providerCatalogEntry(provider).models; }
export function resolveCatalogModel(provider: ProviderName, value: string): ModelCatalogEntry | undefined {
  const normalized = value.trim().toLowerCase();
  return modelsForProvider(provider).find((entry) => entry.id.toLowerCase() === normalized || entry.alias.toLowerCase() === normalized || entry.label.toLowerCase() === normalized);
}
export function effectiveContextWindow(provider: ProviderName, model: string, configured?: number): number | undefined {
  if (!configured) return undefined;
  const documented = resolveCatalogModel(provider, model)?.contextWindowTokens;
  return documented ? Math.min(configured, documented) : configured;
}
export function requireCatalogModel(provider: ProviderName, value: string): ModelCatalogEntry {
  const model = resolveCatalogModel(provider, value);
  if (model) return model;
  const supported = modelsForProvider(provider).map((entry) => entry.id).join(", ");
  throw new Error(`Model ${JSON.stringify(value)} is not in the ${providerLabel(provider)} registry. Supported models: ${supported}`);
}
export function modelVisionSupport(provider: ProviderName, model: string): VisionSupport { return resolveCatalogModel(provider, model)?.vision ?? "unknown"; }
export function modelSupportsVision(provider: ProviderName, model: string): boolean { return modelVisionSupport(provider, model) === "supported"; }
export function requireVisionModel(provider: ProviderName, model: string): void {
  const support = modelVisionSupport(provider, model);
  if (support === "supported") return;
  const models = modelsForProvider(provider).filter((entry) => entry.vision === "supported").map((entry) => entry.id).join(", ");
  throw new Error(`${providerLabel(provider)} model ${model} cannot accept images because ${support === "unknown" ? "its image capability is not verified" : "it is text-only"}. ${models ? `Choose an image-capable model with /model: ${models}` : "Remove the image or select another provider."}`);
}
export function validateProviderImageAttachments(provider: ProviderName, images: readonly ImageAttachment[]): void {
  for (const attachment of images) { const issue = providerImageCompatibilityIssue(provider, attachment); if (issue) throw new Error(issue); }
}
export function providerImageCompatibilityIssue(provider: ProviderName, attachment: ImageAttachment): string | undefined {
  const entry = providerCatalogEntry(provider);
  const constraints = entry.imageConstraints;
  if (!constraints) return undefined;
  const { width, height, mediaType, label } = attachment;
  if (constraints.minWidth !== undefined && width < constraints.minWidth) return `${label} must be at least ${constraints.minWidth} pixels wide for ${entry.label}.`;
  if (constraints.minHeight !== undefined && height < constraints.minHeight) return `${label} must be at least ${constraints.minHeight} pixels high for ${entry.label}.`;
  const longEdge = Math.max(width, height); const shortEdge = Math.min(width, height);
  if (constraints.maxAspectRatio !== undefined && longEdge / shortEdge > constraints.maxAspectRatio) return `${label} exceeds ${entry.label}'s ${constraints.maxAspectRatio}:1 aspect-ratio limit.`;
  if (constraints.maxLongEdge !== undefined && longEdge > constraints.maxLongEdge) return `${label} exceeds ${entry.label}'s ${constraints.maxLongEdge}-pixel long-edge limit.`;
  if (constraints.maxShortEdge !== undefined && shortEdge > constraints.maxShortEdge) return `${label} exceeds ${entry.label}'s ${constraints.maxShortEdge}-pixel short-edge limit.`;
  if (constraints.blockedMediaTypes.includes(mediaType)) return `${label} uses ${mediaType}, which ${entry.label} does not accept.`;
  if (constraints.largeImageThreshold !== undefined && longEdge > constraints.largeImageThreshold && !constraints.largeImageMediaTypes.includes(mediaType)) return `${label} must use ${constraints.largeImageMediaTypes.join(" or ")} when its longest edge exceeds ${constraints.largeImageThreshold} pixels for ${entry.label}.`;
  return undefined;
}
