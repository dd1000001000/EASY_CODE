import type {
  EasyCodeConfig,
  ModelProvider,
  ProviderName,
} from "../core/types.js";
import {
  modelSupportsVision,
  providerCatalogEntry,
  resolveCatalogModel,
} from "../models/catalog.js";
import type { ProviderRuntimeOptions } from "./openai-compatible.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { ResponsesProvider } from "./responses.js";

export function createProvider(
  config: EasyCodeConfig,
  providerName: ProviderName = config.provider,
  modelOverride?: string,
  runtime?: ProviderRuntimeOptions,
): ModelProvider {
  const registeredConfig = config.providers[providerName];
  if (!registeredConfig) throw new Error(`Provider ${providerName} is not configured`);
  const providerConfig = {
    ...registeredConfig,
    // Standalone adapters retain their cap; every agent call explicitly sends
    // maxRetries=0 and uses the shared Runtime retry policy instead.
    maxRetries: Math.min(registeredConfig.maxRetries, config.limits.maxProviderRetries),
    model: modelOverride?.trim() || registeredConfig.model,
  };
  const effectiveRuntime: ProviderRuntimeOptions = {
    ...runtime,
    timeoutByEffort: config.limits.providerTimeoutMs,
    maxResponseBytes: runtime?.maxResponseBytes ?? config.limits.providerResponseMaxBytes,
    visionSupported:
      runtime?.visionSupported ??
      modelSupportsVision(providerName, providerConfig.model),
    supportsTemperature:
      runtime?.supportsTemperature ?? providerCatalogEntry(providerName).supportsTemperature,
    supportsStrictTools:
      runtime?.supportsStrictTools ?? providerCatalogEntry(providerName).supportsStrictTools,
    toolCallingSupported:
      runtime?.toolCallingSupported ??
      (resolveCatalogModel(providerName, providerConfig.model)?.toolCalling ?? true),
  };

  switch (providerCatalogEntry(providerName).wireApi) {
    case "chat_completions":
      return new OpenAICompatibleProvider(providerName, providerConfig, effectiveRuntime);
    case "responses":
      return new ResponsesProvider(providerName, providerConfig, effectiveRuntime);
  }
}
