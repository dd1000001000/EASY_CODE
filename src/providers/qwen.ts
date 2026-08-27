import type { ProviderConfig } from "../core/types.js";
import {
  OpenAICompatibleProvider,
  type ProviderRuntimeOptions,
} from "./openai-compatible.js";

export class QwenProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig, runtime?: ProviderRuntimeOptions) {
    super("qwen", config, runtime);
  }
}
