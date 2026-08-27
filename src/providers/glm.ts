import type {
  ModelRequest,
  ProviderConfig,
  ProviderResponse,
  ToolDefinition,
} from "../core/types.js";
import {
  OpenAICompatibleProvider,
  type ProviderRuntimeOptions,
} from "./openai-compatible.js";

/** Zhipu GLM's Chat Completions API is OpenAI-compatible. */
export class GlmProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig, runtime?: ProviderRuntimeOptions) {
    super("glm", config, runtime);
  }

  override complete(request: ModelRequest): Promise<ProviderResponse> {
    if (!request.tools?.length) return super.complete(request);
    return super.complete({
      ...request,
      // GLM documents OpenAI-compatible Function Calling but not OpenAI's
      // optional strict extension. EASY CODE still validates every tool input
      // locally, so omitting it preserves compatibility without weakening the
      // workspace boundary.
      tools: request.tools.map(withoutOpenAiStrictExtension),
    });
  }
}

function withoutOpenAiStrictExtension(tool: ToolDefinition): ToolDefinition {
  const { strict: _strict, ...functionDefinition } = tool.function;
  return { ...tool, function: functionDefinition };
}
