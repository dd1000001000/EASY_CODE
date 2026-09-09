import type {
  EasyCodeConfig,
  ModelProvider,
  ProviderName,
} from "../core/types.js";
import { DeepSeekProvider } from "./deepseek.js";
import { GlmProvider } from "./glm.js";
import {
  modelSupportsVision,
  providerCatalogEntry,
} from "../models/catalog.js";
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
    // Standalone adapters retain their cap; every agent call explicitly sends
    // maxRetries=0 and uses the shared Runtime retry policy instead.
    maxRetries: Math.min(config[providerName].maxRetries, config.limits.maxProviderRetries),
    model: modelOverride?.trim() || config[providerName].model,
  };
  const effectiveRuntime: ProviderRuntimeOptions = {
    ...runtime,
    timeoutByEffort: config.limits.providerTimeoutMs,
    maxResponseBytes: runtime?.maxResponseBytes ?? config.limits.providerResponseMaxBytes,
    visionSupported:
      runtime?.visionSupported ??
      modelSupportsVision(providerName, providerConfig.model),
  };

  switch (providerCatalogEntry(providerName).adapter) {
    case "qwen":
      return new QwenProvider(providerConfig, effectiveRuntime);
    case "deepseek":
      return new DeepSeekProvider(providerConfig, effectiveRuntime);
    case "glm": {
      if (providerName !== "glm" && providerName !== "glm-coding-plan") {
        throw new Error(`Provider ${providerName} cannot use the GLM adapter`);
      }
      return new GlmProvider(
        providerConfig,
        effectiveRuntime,
        providerName,
      );
    }
  }
}
