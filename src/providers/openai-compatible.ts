import { z } from "zod";
import { randomUUID } from "node:crypto";

import type {
  ChatMessage,
  FunctionToolCall,
  ImageAttachment,
  ModelProvider,
  ModelRequest,
  ProviderConfig,
  ProviderName,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderUsage,
} from "../core/types.js";
import { projectModelInputMessages } from "../context/micro-compaction.js";
import {
  validateImageAttachmentCollection,
} from "../images/image-store.js";
import {
  providerImageCompatibilityIssue,
  validateProviderImageAttachments,
} from "../models/catalog.js";
import {
  thinkingEffortBufferedTimeoutMs,
  thinkingEffortStreamIdleTimeoutMs,
} from "../models/thinking.js";
import {
  ProviderError,
  redactImageDataUrls,
  redactSensitiveText,
  streamProviderError,
  type ProviderProgress,
} from "./errors.js";
import {
  describeTransportTimeout,
  HttpTransportError,
  postJsonWithNode,
  type JsonPostResponse,
  type JsonPostTransport,
} from "./http-transport.js";
import {
  ServerSentEventDecoder,
  SseDecodingError,
  isEventStreamContentType,
  type ServerSentEvent,
} from "./sse.js";

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_HISTORICAL_IMAGE_OMISSION_NOTE_CHARS = 600;

const functionToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

const chatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          tool_calls: z.array(functionToolCallSchema).optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
      // DeepSeek reports cache hits at the usage top level. Some Alibaba
      // regions have also returned a top-level cached_tokens compatibility
      // field, while the current OpenAI-compatible shape nests it below.
      prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
      cached_tokens: z.number().int().nonnegative().nullable().optional(),
      prompt_tokens_details: z
        .object({
          cached_tokens: z.number().int().nonnegative().nullable().optional(),
        })
        .passthrough()
        .nullable()
        .optional(),
      completion_tokens_details: z
        .object({
          reasoning_tokens: z.number().int().nonnegative().nullable().optional(),
        })
        .passthrough()
        .nullable()
        .optional(),
    })
    .passthrough()
    .optional(),
});

const chatCompletionChunkSchema = z.object({
  choices: z.array(z.object({
    index: z.number().int().nonnegative().optional(),
    finish_reason: z.string().nullable().optional(),
    delta: z.object({
      role: z.string().optional(),
      content: z.string().nullable().optional(),
      reasoning_content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(),
        id: z.string().optional(),
        type: z.string().optional(),
        function: z.object({
          name: z.string().nullable().optional(),
          arguments: z.string().nullable().optional(),
        }).passthrough().optional(),
      }).passthrough()).optional(),
    }).passthrough(),
  }).passthrough()).default([]),
  usage: chatCompletionSchema.shape.usage.nullable(),
}).passthrough();

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ChatStreamState {
  content: string;
  reasoning: string;
  finishReason?: string | null;
  usage?: ProviderUsage;
  done: boolean;
  readonly toolCalls: Map<number, PendingToolCall>;
}

type StreamEventPayload = ProviderStreamEvent extends infer Event
  ? Event extends { streamId: string; sequence: number }
    ? Omit<Event, "streamId" | "sequence">
    : never
  : never;

function normalizeChatUsage(
  value: z.infer<typeof chatCompletionSchema>["usage"],
): ProviderUsage | undefined {
  if (!value) return undefined;
  const usage: ProviderUsage = {
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    totalTokens: value.total_tokens,
    cachedInputTokens:
      value.prompt_tokens_details?.cached_tokens ??
      value.prompt_cache_hit_tokens ??
      value.cached_tokens ??
      undefined,
    reasoningTokens:
      value.completion_tokens_details?.reasoning_tokens ?? undefined,
  };
  return Object.values(usage).some((item) => item !== undefined)
    ? usage
    : undefined;
}

export interface ProviderRuntimeOptions {
  streamIdleTimeoutByEffort?: Readonly<Record<NonNullable<ModelRequest["thinkingEffort"]>, number>>;
  bufferedTimeoutByEffort?: Readonly<Record<NonNullable<ModelRequest["thinkingEffort"]>, number>>;
  transport?: JsonPostTransport;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  maxResponseBytes?: number;
  /** Resolve a validated local attachment immediately before an API request. */
  loadImage?: (attachment: ImageAttachment) => Promise<Buffer>;
  /** Unknown models default to false in the provider factory. */
  visionSupported?: boolean;
  supportsTemperature?: boolean;
  supportsStrictTools?: boolean;
  /** False for registry models that do not implement native function calling. */
  toolCallingSupported?: boolean;
  /** Endpoint capability loaded from the model registry. */
  supportsStreaming?: boolean;
  /** Endpoint supports stream_options.include_usage (not implied by SSE). */
  supportsStreamUsage?: boolean;
  /** Endpoint accepts the non-standard tool_stream Chat Completions flag. */
  toolStream?: boolean;
}

type CompletionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type CompletionMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | CompletionContentPart[] }
  | Extract<ChatMessage, { role: "assistant" }>
  | Extract<ChatMessage, { role: "tool" }>;

interface CompletionBody {
  model: string;
  messages: CompletionMessage[];
  stream: boolean;
  stream_options?: { include_usage: true };
  tool_stream?: true;
  tools?: ModelRequest["tools"];
  temperature?: number;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: ProviderName;
  readonly model: string;

  private readonly config: ProviderConfig;
  private readonly endpoint: URL;
  private readonly transport: JsonPostTransport;
  private readonly sleep: (
    delayMs: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  private readonly random: () => number;
  private readonly maxResponseBytes: number;
  private readonly loadImage?: (attachment: ImageAttachment) => Promise<Buffer>;
  private readonly visionSupported: boolean;
  private readonly streamIdleTimeoutByEffort?: ProviderRuntimeOptions["streamIdleTimeoutByEffort"];
  private readonly bufferedTimeoutByEffort?: ProviderRuntimeOptions["bufferedTimeoutByEffort"];
  private readonly supportsTemperature: boolean;
  private readonly supportsStrictTools: boolean;
  private readonly toolCallingSupported: boolean;
  private readonly supportsStreaming: boolean;
  private readonly supportsStreamUsage: boolean;
  private readonly toolStream: boolean;

  constructor(
    name: ProviderName,
    config: ProviderConfig,
    runtime: ProviderRuntimeOptions = {},
  ) {
    validateProviderConfig(name, config);
    this.name = name;
    this.model = config.model;
    this.config = { ...config };
    this.endpoint = chatCompletionsEndpoint(config.baseUrl, name);
    this.transport = runtime.transport ?? postJsonWithNode;
    this.sleep = runtime.sleep ?? abortableSleep;
    this.random = runtime.random ?? Math.random;
    this.maxResponseBytes =
      runtime.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.loadImage = runtime.loadImage;
    this.visionSupported = runtime.visionSupported ?? false;
    this.streamIdleTimeoutByEffort = runtime.streamIdleTimeoutByEffort;
    this.bufferedTimeoutByEffort = runtime.bufferedTimeoutByEffort;
    this.supportsTemperature = runtime.supportsTemperature ?? true;
    this.supportsStrictTools = runtime.supportsStrictTools ?? true;
    this.toolCallingSupported = runtime.toolCallingSupported ?? true;
    this.supportsStreaming = runtime.supportsStreaming ?? false;
    this.supportsStreamUsage = runtime.supportsStreamUsage ?? false;
    this.toolStream = runtime.toolStream ?? false;
  }

  async complete(request: ModelRequest): Promise<ProviderResponse> {
    if (!this.config.apiKey) {
      throw new ProviderError(
        `Missing API key for ${this.name}. Configure the provider before use.`,
        {
          provider: this.name,
          code: "missing_api_key",
        },
      );
    }

    const streamResponse = request.responseMode === "stream" && this.supportsStreaming;
    const body: CompletionBody = {
      model: this.model,
      messages: await this.toCompletionMessages(
        request.messages,
        request.currentTurnImageIds,
      ),
      stream: streamResponse,
      ...(streamResponse && this.supportsStreamUsage ? { stream_options: { include_usage: true as const } } : {}),
    };
    if (request.tools?.length && this.toolCallingSupported) {
      body.tools = this.runtimeTools(request.tools);
      if (streamResponse && this.toolStream) body.tool_stream = true;
    }
    if (request.temperature !== undefined && this.supportsTemperature) {
      body.temperature = request.temperature;
    }
    const effort = request.thinkingEffort ?? "none";
    const streamIdleTimeoutMs = this.streamIdleTimeoutByEffort?.[effort] ??
      thinkingEffortStreamIdleTimeoutMs(effort);
    const bufferedTimeoutMs = this.config.timeoutMs ?? this.bufferedTimeoutByEffort?.[effort] ??
      thinkingEffortBufferedTimeoutMs(effort);
    const timeoutMs = streamResponse ? streamIdleTimeoutMs : bufferedTimeoutMs;
    const timeoutMode = streamResponse ? "stream_semantic_idle" as const : "buffered_total" as const;
    if (
      request.maxRetries !== undefined &&
      (!Number.isSafeInteger(request.maxRetries) ||
        request.maxRetries < 0 ||
        request.maxRetries > 10)
    ) {
      throw this.error("Request maxRetries must be between 0 and 10", "invalid_request");
    }
    const maxRetries = request.maxRetries === undefined
      ? this.config.maxRetries
      : Math.min(this.config.maxRetries, request.maxRetries);

    let serialized: string;
    try {
      serialized = JSON.stringify(body);
    } catch {
      throw new ProviderError("Unable to serialize the model request", {
        provider: this.name,
        code: "invalid_request",
      });
    }

    let lastError: ProviderError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (request.signal?.aborted) {
        throw this.error("Request was canceled", "aborted");
      }

      let streamStarted = false;
      let streamSequence = 0;
      const streamId = `${this.name}-${randomUUID()}`;
      const decoder = new ServerSentEventDecoder();
      const streamState: ChatStreamState = {
        content: "",
        reasoning: "",
        toolCalls: new Map(),
        done: false,
      };
      const emit = (event: StreamEventPayload): void => {
        if (!request.onStreamEvent) return;
        try {
          request.onStreamEvent({
            ...event,
            streamId,
            sequence: ++streamSequence,
          } as ProviderStreamEvent);
        } catch {
          // Presentation observers are deliberately isolated from provider I/O.
        }
      };
      const consume = (event: ServerSentEvent): boolean => {
        if (event.data.trim() === "[DONE]") {
          const progressed = !streamState.done;
          streamState.done = true;
          return progressed;
        }
        let decoded: unknown;
        try { decoded = JSON.parse(event.data) as unknown; }
        catch { throw this.error("Provider returned an invalid Chat Completions SSE event", "invalid_response"); }
        if (decoded && typeof decoded === "object" && ("error" in decoded || event.event === "error")) {
          throw streamProviderError(this.name, decoded, this.config.apiKey);
        }
        if (streamState.done) throw this.error("Provider sent data after [DONE]", "invalid_response");
        const parsed = chatCompletionChunkSchema.safeParse(decoded);
        if (!parsed.success) throw this.error("Provider returned an unsupported Chat Completions SSE event", "invalid_response");
        return this.consumeStreamChunk(streamState, parsed.data, emit);
      };

      try {
        const response = await this.transport({
          url: this.endpoint,
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            accept: streamResponse ? "text/event-stream" : "application/json",
            "content-type": "application/json",
            "user-agent": "easy-code-agent/0.1",
          },
          body: serialized,
          timeoutMs,
          timeoutMode,
          ...(streamResponse ? { bufferedTimeoutMs } : {}),
          maxResponseBytes: this.maxResponseBytes,
          signal: request.signal,
          ...(streamResponse
            ? {
                onResponseStart: ({ statusCode, headers }: Pick<JsonPostResponse, "statusCode" | "headers">) => {
                  streamStarted = statusCode >= 200 && statusCode < 300 &&
                    isEventStreamContentType(headers["content-type"]);
                  if (streamStarted) emit({ kind: "started" });
                  return streamStarted ? "stream" as const : "buffered" as const;
                },
                onResponseChunk: (chunk: Buffer) => {
                  if (!streamStarted) return false;
                  let progressed = false;
                  for (const event of decoder.push(chunk)) progressed = consume(event) || progressed;
                  return progressed;
                },
              }
            : {}),
        });
        request.signal?.throwIfAborted();
        if (streamStarted) {
          for (const event of decoder.finish()) consume(event);
          const result = this.finishStream(streamState);
          if (result.usage) emit({ kind: "usage", usage: result.usage });
          emit({ kind: "completed", finishReason: result.finishReason ?? null });
          return result;
        }
        return this.parseResponse(response);
      } catch (error) {
        const providerError = this.normalizeError(
          error,
          request.signal,
          this.streamProgress(streamState),
          { streamIdleTimeoutMs, bufferedTimeoutMs },
        );
        lastError = providerError;
        if (streamStarted) {
          emit({ kind: "interrupted" });
          // Nothing has been submitted to Runtime or executed. The shared API
          // retry owner may retry; each attempt gets fresh state and identity.
        }
        if (!providerError.retryable || attempt >= maxRetries) {
          throw providerError;
        }
        const delay =
          providerError.retryAfterMs ?? this.retryDelayMs(attempt);
        try {
          await this.sleep(delay, request.signal);
        } catch (sleepError) {
          throw this.normalizeError(sleepError, request.signal);
        }
      }
    }

    throw (
      lastError ?? this.error("Provider request failed", "request_failed")
    );
  }

  private consumeStreamChunk(
    state: ChatStreamState,
    chunk: z.infer<typeof chatCompletionChunkSchema>,
    emit: (event: StreamEventPayload) => void,
  ): boolean {
    let progressed = false;
    const choice = chunk.choices.find((candidate) => (candidate.index ?? 0) === 0);
    if (choice) {
      if (state.finishReason != null &&
          (choice.delta.content || choice.delta.reasoning_content || choice.delta.tool_calls?.length ||
           choice.finish_reason != null && choice.finish_reason !== state.finishReason)) {
        throw this.error("Provider changed an already finished choice", "invalid_response");
      }
      const reasoning = choice.delta.reasoning_content ?? "";
      if (reasoning) {
        state.reasoning += reasoning;
        emit({ kind: "reasoning_delta", text: reasoning });
        progressed = true;
      }
      const content = choice.delta.content ?? "";
      if (content) {
        state.content += content;
        emit({ kind: "text_delta", text: content });
        progressed = true;
      }
      for (const fragment of choice.delta.tool_calls ?? []) {
        const pending = state.toolCalls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
        if (fragment.id) pending.id += fragment.id;
        if (fragment.function?.name) pending.name += fragment.function.name;
        if (fragment.function?.arguments) pending.arguments += fragment.function.arguments;
        state.toolCalls.set(fragment.index, pending);
        if (fragment.id || fragment.function?.name || fragment.function?.arguments) {
          progressed = true;
          emit({
            kind: "tool_call_delta",
            index: fragment.index,
            ...(fragment.id ? { id: fragment.id } : {}),
            ...(fragment.function?.name ? { name: fragment.function.name } : {}),
            ...(fragment.function?.arguments ? { arguments: fragment.function.arguments } : {}),
          });
        }
      }
      if (choice.finish_reason != null && choice.finish_reason !== state.finishReason) {
        state.finishReason = choice.finish_reason;
        progressed = true;
      }
    }
    const usage = normalizeChatUsage(chunk.usage ?? undefined);
    if (usage && JSON.stringify(usage) !== JSON.stringify(state.usage)) {
      state.usage = usage;
      progressed = true;
    }
    return progressed;
  }

  private streamProgress(state: ChatStreamState): ProviderProgress {
    return {
      reasoningChars: state.reasoning.length,
      textChars: state.content.length,
      toolArgumentChars: [...state.toolCalls.values()]
        .reduce((total, call) => total + call.arguments.length, 0),
    };
  }

  private finishStream(state: ChatStreamState): ProviderResponse {
    if (!state.done || !state.finishReason) {
      throw new ProviderError("Chat Completions stream ended without finish_reason and [DONE]", {
        provider: this.name, code: "incomplete_stream", retryable: true,
      });
    }
    const toolCalls: FunctionToolCall[] = [];
    for (const [, pending] of [...state.toolCalls.entries()].sort(([left], [right]) => left - right)) {
      const candidate = {
        id: pending.id,
        type: "function" as const,
        function: { name: pending.name, arguments: pending.arguments },
      };
      const parsed = functionToolCallSchema.safeParse(candidate);
      if (!parsed.success) throw this.error("Provider ended with an incomplete streamed tool call", "invalid_response");
      toolCalls.push(parsed.data);
    }
    const message: Extract<ChatMessage, { role: "assistant" }> = {
      role: "assistant",
      content: state.content ? redactImageDataUrls(state.content) : null,
      ...(state.reasoning ? { reasoning_content: redactImageDataUrls(state.reasoning) } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    return {
      message,
      finishReason: state.finishReason ?? null,
      ...(state.usage ? { usage: state.usage } : {}),
    };
  }

  private runtimeTools(tools: NonNullable<ModelRequest["tools"]>): NonNullable<ModelRequest["tools"]> {
    if (this.supportsStrictTools) return tools;
    return tools.map((tool) => {
      const { strict: _strict, ...definition } = tool.function;
      return { ...tool, function: definition };
    });
  }

  private async toCompletionMessages(
    messages: readonly ChatMessage[],
    currentTurnImageIds?: readonly string[],
  ): Promise<CompletionMessage[]> {
    // ContextManager applies this projection before budgeting. Repeat it at
    // the provider boundary as a fail-safe for callers that construct a
    // ModelRequest directly. The projection is idempotent and never mutates
    // durable Thread history.
    let providerMessages = projectModelInputMessages(messages);
    if (this.visionSupported) {
      try {
        const originalImages = messages.flatMap((message) =>
          message.role === "user" ? message.images ?? [] : [],
        );
        // Validate durable metadata even when a provider-specific constraint
        // causes an older attachment to be omitted. Aggregate limits are
        // checked after filtering because omitted bytes never reach the API.
        for (const image of originalImages) validateImageAttachmentCollection([image]);
        if (currentTurnImageIds !== undefined) {
          const currentImageIds = new Set(currentTurnImageIds);
          providerMessages = providerMessages.map((message) => {
            if (message.role !== "user" || !message.images?.length) return message;
            const compatible: ImageAttachment[] = [];
            const omitted: Array<{ image: ImageAttachment; issue: string }> = [];
            for (const image of message.images) {
              const issue = providerImageCompatibilityIssue(this.name, image);
              if (!currentImageIds.has(image.id) && issue) {
                omitted.push({ image, issue });
              } else {
                compatible.push(image);
              }
            }
            if (omitted.length === 0) return message;
            return {
              role: "user",
              content: appendHistoricalImageOmissionNote(message.content, omitted),
              ...(compatible.length ? { images: compatible } : {}),
            };
          });
        }
        const requestImages = providerMessages.flatMap((message) =>
          message.role === "user" ? message.images ?? [] : [],
        );
        validateImageAttachmentCollection(requestImages);
        validateProviderImageAttachments(this.name, requestImages);
      } catch (error) {
        throw this.error(
          error instanceof Error ? error.message : String(error),
          "invalid_images",
        );
      }
    }

    const output: CompletionMessage[] = [];
    for (const message of providerMessages) {
      if (message.role !== "user") {
        if (message.role === "assistant") {
          const { phase: _phase, ...completionMessage } = message;
          output.push(completionMessage);
        } else {
          output.push({ ...message });
        }
        continue;
      }

      const images = message.images ?? [];
      if (images.length === 0) {
        output.push({ role: "user", content: message.content });
        continue;
      }
      if (!this.visionSupported) {
        const omitted = images
          .map((image) => `[${image.label} omitted: ${this.model} cannot receive images]`)
          .join("\n");
        output.push({
          role: "user",
          content: [message.content, omitted].filter(Boolean).join("\n\n"),
        });
        continue;
      }
      if (!this.loadImage) {
        throw this.error("No local image loader is configured.", "invalid_config");
      }

      const hydrated = new Map<string, {
        readonly attachment: ImageAttachment;
        readonly image: Extract<CompletionContentPart, { type: "image_url" }>;
        used: boolean;
      }>();
      for (const attachment of images) {
        const data = await this.loadImage(attachment);
        if (data.length !== attachment.byteSize) {
          throw this.error(
            `Stored ${attachment.label} no longer matches its metadata.`,
            "image_integrity_error",
          );
        }
        hydrated.set(`[${attachment.label}]`, {
          attachment,
          image: {
            type: "image_url",
            image_url: {
              url: `data:${attachment.mediaType};base64,${data.toString("base64")}`,
            },
          },
          used: false,
        });
      }

      const content: CompletionContentPart[] = [];
      const orderedText: CompletionContentPart[] = [];
      const markerPattern = /\[Image #[1-9][0-9]{0,2}\]/gu;
      let cursor = 0;
      for (const match of message.content.matchAll(markerPattern)) {
        const marker = match[0];
        const position = match.index;
        const item = hydrated.get(marker);
        if (!item || item.used || position === undefined) continue;
        if (position > cursor) {
          orderedText.push({ type: "text", text: message.content.slice(cursor, position) });
        }
        orderedText.push({ type: "text", text: marker }, item.image);
        item.used = true;
        cursor = position + marker.length;
      }
      if (cursor < message.content.length) {
        orderedText.push({ type: "text", text: message.content.slice(cursor) });
      }

      // Images queued through /image or --image do not necessarily have an
      // inline marker. Preserve the previous behavior by placing those before
      // the user's text while still interleaving explicitly referenced images.
      for (const [marker, item] of hydrated) {
        if (item.used) continue;
        content.push({ type: "text", text: marker }, item.image);
      }
      content.push(...orderedText);
      output.push({ role: "user", content });
    }
    return output;
  }

  private parseResponse(response: JsonPostResponse): ProviderResponse {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const retryable = retryableStatus(response.statusCode);
      const apiMessage = extractApiErrorMessage(response.body);
      const requestId = headerValue(
        response.headers["x-request-id"] ?? response.headers["request-id"],
      );
      const suffix = requestId ? ` (request ${requestId})` : "";
      throw new ProviderError(
        `${this.name} API returned HTTP ${response.statusCode}${suffix}: ${apiMessage}`,
        {
          provider: this.name,
          code: "http_error",
          statusCode: response.statusCode,
          retryable,
          retryAfterMs: parseRetryAfter(response.headers["retry-after"]),
          secrets: [this.config.apiKey],
        },
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(response.body) as unknown;
    } catch {
      throw this.error(
        "Provider returned an invalid JSON response",
        "invalid_response",
      );
    }

    const parsed = chatCompletionSchema.safeParse(decoded);
    if (!parsed.success) {
      throw this.error(
        "Provider returned an unsupported Chat Completions response",
        "invalid_response",
      );
    }
    const choice = parsed.data.choices[0];
    if (!choice) {
      throw this.error(
        "Provider returned no Chat Completions choice",
        "invalid_response",
      );
    }

    const message: Extract<ChatMessage, { role: "assistant" }> = {
      role: "assistant",
      content: choice.message.content === undefined || choice.message.content === null
        ? null
        : redactImageDataUrls(choice.message.content),
    };
    if (choice.message.tool_calls) {
      message.tool_calls = choice.message.tool_calls;
    }
    if (choice.message.reasoning_content !== undefined) {
      message.reasoning_content = choice.message.reasoning_content === null
        ? null
        : redactImageDataUrls(choice.message.reasoning_content);
    }

    const result: ProviderResponse = {
      message,
      finishReason: choice.finish_reason ?? null,
    };
    const usage = normalizeChatUsage(parsed.data.usage);
    if (usage) result.usage = usage;
    return result;
  }

  private normalizeError(
    error: unknown,
    signal: AbortSignal | undefined,
    progress?: ProviderProgress,
    deadlines?: { streamIdleTimeoutMs: number; bufferedTimeoutMs: number },
  ): ProviderError {
    if (error instanceof ProviderError) return error;
    if (error instanceof SseDecodingError) return this.error(error.message, "invalid_response");
    if (signal?.aborted) return this.error("Request was canceled", "aborted");
    if (error instanceof HttpTransportError) {
      if (error.kind === "aborted") {
        return this.error("Request was canceled", "aborted");
      }
      if (error.kind === "stream_header_timeout") {
        return new ProviderError(
          deadlines ? describeTransportTimeout(error, deadlines) : error.message,
          {
            provider: this.name,
            code: "stream_header_timeout",
            retryable: true,
            progress,
          },
        );
      }
      if (error.kind === "stream_semantic_idle_timeout") {
        return new ProviderError(
          deadlines ? describeTransportTimeout(error, deadlines) : error.message,
          {
            provider: this.name,
            code: "stream_semantic_idle_timeout",
            retryable: true,
            progress,
          },
        );
      }
      if (error.kind === "buffered_total_timeout") {
        return new ProviderError(
          deadlines ? describeTransportTimeout(error, deadlines) : error.message,
          {
            provider: this.name,
            code: "buffered_total_timeout",
            retryable: true,
            progress,
          },
        );
      }
      if (error.kind === "response_too_large") {
        return this.error(error.message, "response_too_large");
      }
      return new ProviderError(`Provider network error: ${error.message}`, {
        provider: this.name,
        code: "network_error",
        retryable: true,
        secrets: [this.config.apiKey],
      });
    }
    return new ProviderError(
      `Provider request failed: ${redactSensitiveText(error, [this.config.apiKey])}`,
      {
        provider: this.name,
        code: "request_failed",
        retryable: true,
        secrets: [this.config.apiKey],
      },
    );
  }

  private error(message: string, code: string): ProviderError {
    return new ProviderError(message, {
      provider: this.name,
      code,
      secrets: [this.config.apiKey],
    });
  }

  private retryDelayMs(attempt: number): number {
    const base = Math.min(500 * 2 ** attempt, 5_000);
    return Math.round(base * (0.8 + this.random() * 0.4));
  }
}

function appendHistoricalImageOmissionNote(
  content: string,
  omitted: readonly { image: ImageAttachment; issue: string }[],
): string {
  const details = omitted
    .map(({ issue }) => issue)
    .join(" ");
  const prefix = "[Historical image attachment(s) omitted from this provider request: ";
  const suffix = " Local thread history is unchanged.]";
  const available = MAX_HISTORICAL_IMAGE_OMISSION_NOTE_CHARS - prefix.length - suffix.length;
  const boundedDetails = details.length <= available
    ? details
    : `${details.slice(0, Math.max(0, available - 1))}…`;
  const note = `${prefix}${boundedDetails}${suffix}`;
  return [content, note].filter(Boolean).join("\n\n");
}

function validateProviderConfig(
  provider: ProviderName,
  config: ProviderConfig,
): void {
  if (!config.model.trim()) {
    throw new ProviderError("Provider model cannot be empty", {
      provider,
      code: "invalid_config",
    });
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0)
  ) {
    throw new ProviderError("Provider timeout must be a positive integer", {
      provider,
      code: "invalid_config",
    });
  }
  if (
    !Number.isInteger(config.maxRetries) ||
    config.maxRetries < 0 ||
    config.maxRetries > 10
  ) {
    throw new ProviderError("Provider maxRetries must be between 0 and 10", {
      provider,
      code: "invalid_config",
    });
  }
}

function chatCompletionsEndpoint(
  baseUrl: string,
  provider: ProviderName,
): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderError("Provider base URL is invalid", {
      provider,
      code: "invalid_config",
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError("Provider base URL must use HTTP or HTTPS", {
      provider,
      code: "invalid_config",
    });
  }
  if (url.username || url.password) {
    throw new ProviderError("Provider base URL must not contain credentials", {
      provider,
      code: "invalid_config",
    });
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url;
}

function retryableStatus(statusCode: number): boolean {
  return (
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500
  );
}

function extractApiErrorMessage(body: string): string {
  try {
    const value = JSON.parse(body) as unknown;
    if (isRecord(value)) {
      const nested = value.error;
      if (isRecord(nested) && typeof nested.message === "string") {
        return nested.message;
      }
      if (typeof value.message === "string") return value.message;
    }
  } catch {
    // Fall through to a bounded plain-text description.
  }
  const trimmed = body.trim();
  return trimmed ? trimmed.slice(0, 1_000) : "No error details were returned";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = headerValue(value);
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 30_000);
  }
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.min(date - Date.now(), 30_000));
  }
  return undefined;
}

function abortableSleep(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HttpTransportError("aborted", "Request was canceled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new HttpTransportError("aborted", "Request was canceled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
