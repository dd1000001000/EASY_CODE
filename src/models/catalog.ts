import type { ImageAttachment, ProviderName } from "../core/types.js";

export interface ModelCatalogEntry {
  readonly id: string;
  readonly label: string;
  /**
   * `unknown` is intentionally conservative: EASY CODE will not send image
   * bytes until the provider documents that exact model identifier.
   */
  readonly vision: VisionSupport;
}

export type VisionSupport = "supported" | "unsupported" | "unknown";

export interface ProviderCatalogEntry {
  readonly provider: ProviderName;
  readonly label: string;
  readonly models: readonly ModelCatalogEntry[];
}

const DEEPSEEK_MODELS: readonly ModelCatalogEntry[] = [
  {
    id: "deepseek-v4-flash",
    label: "deepseek-v4-flash",
    vision: "unsupported",
  },
  {
    id: "deepseek-v4-pro",
    label: "deepseek-v4-pro",
    vision: "unsupported",
  },
  {
    id: "deepseek-v4-flash-vision-exp",
    label: "deepseek-v4-flash-vision-exp",
    vision: "supported",
  },
];

const QWEN_MODELS: readonly ModelCatalogEntry[] = [
  { id: "qwen3.7-max", label: "Qwen3.7-Max", vision: "unsupported" },
  { id: "qwen3.7-plus", label: "Qwen3.7-Plus", vision: "supported" },
  { id: "qwen3.6-max", label: "Qwen3.6-Max", vision: "unsupported" },
  { id: "qwen3.6-plus", label: "Qwen3.6-Plus", vision: "supported" },
  { id: "qwen3.5-plus", label: "Qwen3.5-Plus", vision: "supported" },
  { id: "qwen3.5-flash", label: "Qwen3.5-Flash", vision: "supported" },
  { id: "qwen3-max", label: "Qwen3-Max", vision: "unsupported" },
  { id: "qwen3-vl-plus", label: "Qwen3-VL-Plus", vision: "supported" },
  { id: "qwen3-vl-flash", label: "Qwen3-VL-Flash", vision: "supported" },
];

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { provider: "deepseek", label: "DeepSeek", models: DEEPSEEK_MODELS },
  { provider: "qwen", label: "Alibaba Qwen", models: QWEN_MODELS },
];

export const DEFAULT_MODEL_IDS: Readonly<Record<ProviderName, string>> = {
  qwen: "qwen3.7-max",
  deepseek: "deepseek-v4-pro",
};

export function providerCatalogEntry(provider: ProviderName): ProviderCatalogEntry {
  const entry = PROVIDER_CATALOG.find((candidate) => candidate.provider === provider);
  if (!entry) throw new Error(`Unsupported provider: ${provider}`);
  return entry;
}

export function providerLabel(provider: ProviderName): string {
  return providerCatalogEntry(provider).label;
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
    (entry) =>
      entry.id.toLowerCase() === normalized ||
      entry.label.toLowerCase() === normalized,
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

export function modelVisionSupport(
  provider: ProviderName,
  model: string,
): VisionSupport {
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
  throw new Error(
    `${providerLabel(provider)} model ${model} cannot accept images because ${reason}. ` +
      `Choose an image-capable model with /model: ${models}`,
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
  if (
    longEdge > 4_096 &&
    mediaType !== "image/png" &&
    mediaType !== "image/jpeg"
  ) {
    return `${label} must use PNG or JPEG when its longest edge exceeds 4096 pixels for Alibaba Qwen.`;
  }
  return undefined;
}
