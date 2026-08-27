import type {
  EasyCodeConfig,
  ModelProvider,
  ProviderName,
} from "../core/types.js";
import { DeepSeekProvider } from "./deepseek.js";
import { GlmProvider } from "./glm.js";
import { modelSupportsVision } from "../models/catalog.js";
import type { ProviderRuntimeOptions } from "./openai-compatible.js";
import { QwenProvider } from "./qwen.js";

export function createProvider(
  config: EasyCodeConfig,
  providerName: ProviderName = config.provider,
  modelOverride?: string,
  runtime?: ProviderRuntimeOptions,
): ModelProvider {
  const providerConfig = {
    ...config[providerName],
    model: modelOverride?.trim() || config[providerName].model,
  };
  const responseLimit = Math.max(
    1_048_576,
    Math.min(config.maxOutputChars * 8, 16 * 1024 * 1024),
  );
  const effectiveRuntime: ProviderRuntimeOptions = {
    ...runtime,
    maxResponseBytes: runtime?.maxResponseBytes ?? responseLimit,
    visionSupported:
      runtime?.visionSupported ??
      modelSupportsVision(providerName, providerConfig.model),
  };

  switch (providerName) {
    case "qwen":
      return new QwenProvider(providerConfig, effectiveRuntime);
    case "deepseek":
      return new DeepSeekProvider(providerConfig, effectiveRuntime);
    case "glm":
      return new GlmProvider(providerConfig, effectiveRuntime);
  }
}
