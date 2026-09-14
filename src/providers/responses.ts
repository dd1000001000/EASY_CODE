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
} from "../core/types.js";
import { projectModelInputMessages } from "../context/micro-compaction.js";
import { validateImageAttachmentCollection } from "../images/image-store.js";
import { providerImageCompatibilityIssue, resolveCatalogModel, validateProviderImageAttachments } from "../models/catalog.js";
import { thinkingEffortBufferedTimeoutMs, thinkingEffortStreamIdleTimeoutMs } from "../models/thinking.js";
import { ProviderError, redactImageDataUrls, redactSensitiveText, streamProviderError } from "./errors.js";
import { HttpTransportError, postJsonWithNode, type JsonPostResponse } from "./http-transport.js";
import type { ProviderRuntimeOptions } from "./openai-compatible.js";
import { ServerSentEventDecoder, SseDecodingError, isEventStreamContentType, type ServerSentEvent } from "./sse.js";

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_HISTORICAL_IMAGE_OMISSION_NOTE_CHARS = 600;

const responseSchema = z.object({
  status: z.string().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).passthrough().nullable().optional(),
  output: z.array(z.object({ type: z.string() }).passthrough()).default([]),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).passthrough().optional(),
    output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

type ResponseInput = Record<string, unknown>;

type StreamEventPayload = ProviderStreamEvent extends infer Event
  ? Event extends { streamId: string; sequence: number }
    ? Omit<Event, "streamId" | "sequence">
    : never
  : never;

interface ResponsesStreamState {
  content: string;
  reasoning: string;
  completed?: unknown;
  status?: string;
  readonly toolItems: Map<string, { id: string; callId: string; name: string; arguments: string }>;
}

/** Generic implementation of the OpenAI Responses wire API. */
export class ResponsesProvider implements ModelProvider {
  readonly name: ProviderName;
  readonly model: string;
  private readonly endpoint: URL;
  private readonly maxResponseBytes: number;
  private readonly supportsStreaming: boolean;

  constructor(
    name: ProviderName,
    private readonly config: ProviderConfig,
    private readonly runtime: ProviderRuntimeOptions = {},
  ) {
    this.name = name;
    this.model = config.model;
    this.endpoint = endpoint(config.baseUrl, name);
    this.maxResponseBytes = runtime.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.supportsStreaming = runtime.supportsStreaming ?? false;
  }

  async complete(request: ModelRequest): Promise<ProviderResponse> {
    if (!this.config.apiKey) throw this.error(`Missing API key for ${this.name}. Configure the provider before use.`, "missing_api_key");
    const streamResponse = request.responseMode === "stream" && this.supportsStreaming;
    const body: Record<string, unknown> = {
      model: this.model,
      input: await this.toInput(request.messages, request.currentTurnImageIds),
      stream: streamResponse,
    };
    if (request.tools?.length && this.runtime.toolCallingSupported !== false) {
      body.tools = request.tools.map(({ function: tool }) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(this.runtime.supportsStrictTools === false || tool.strict === undefined ? {} : { strict: tool.strict }),
      }));
      body.parallel_tool_calls = true;
    }
    if (request.temperature !== undefined && this.runtime.supportsTemperature !== false) body.temperature = request.temperature;
    // outputReserveTokens is a local context-accounting reservation. It is not
    // an API generation limit and must never leak onto either wire protocol.
    const model = resolveCatalogModel(this.name, this.model);
    if (model?.reasoning && request.thinkingEffort && request.thinkingEffort !== "none") {
      body.reasoning = { effort: request.thinkingEffort, summary: "auto" };
    }

    let serialized: string;
    try { serialized = JSON.stringify(body); }
    catch { throw this.error("Unable to serialize the model request", "invalid_request"); }
    const effort = request.thinkingEffort ?? "none";
    const timeoutMs = streamResponse
      ? this.runtime.streamIdleTimeoutByEffort?.[effort] ?? thinkingEffortStreamIdleTimeoutMs(effort)
      : this.config.timeoutMs ?? this.runtime.bufferedTimeoutByEffort?.[effort] ??
        thinkingEffortBufferedTimeoutMs(effort);
    const timeoutMode = streamResponse ? "stream_idle" as const : "buffered_total" as const;
    const requestedRetries = request.maxRetries ?? this.config.maxRetries;
    if (!Number.isSafeInteger(requestedRetries) || requestedRetries < 0 || requestedRetries > 10) throw this.error("Request maxRetries must be between 0 and 10", "invalid_request");
    const maxRetries = Math.min(this.config.maxRetries, requestedRetries);
    let lastError: ProviderError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let streamStarted = false;
      let streamSequence = 0;
      const streamId = `${this.name}-${randomUUID()}`;
      const decoder = new ServerSentEventDecoder();
      const streamState: ResponsesStreamState = {
        content: "",
        reasoning: "",
        toolItems: new Map(),
      };
      const emit = (event: StreamEventPayload): void => {
        if (!request.onStreamEvent) return;
        try {
          request.onStreamEvent({ ...event, streamId, sequence: ++streamSequence } as ProviderStreamEvent);
        } catch {
          // Presentation observers are isolated from provider I/O.
        }
      };
      const consume = (event: ServerSentEvent): void => this.consumeStreamEvent(streamState, event, emit);
      try {
        const response = await (this.runtime.transport ?? postJsonWithNode)({
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
          maxResponseBytes: this.maxResponseBytes,
          signal: request.signal,
          ...(streamResponse
            ? {
                onResponseStart: ({ statusCode, headers }: Pick<JsonPostResponse, "statusCode" | "headers">) => {
                  streamStarted = statusCode >= 200 && statusCode < 300 &&
                    isEventStreamContentType(headers["content-type"]);
                  if (streamStarted) emit({ kind: "started" });
                },
                onResponseChunk: (chunk: Buffer) => {
                  if (!streamStarted) return;
                  for (const event of decoder.push(chunk)) consume(event);
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
        return this.parse(response);
      } catch (error) {
        const normalized = this.normalizeError(error, request.signal, timeoutMs);
        lastError = normalized;
        if (streamStarted) {
          emit({ kind: "interrupted" });
        }
        if (!normalized.retryable || attempt >= maxRetries) throw normalized;
        await (this.runtime.sleep ?? sleep)(normalized.retryAfterMs ?? retryDelay(attempt, this.runtime.random?.() ?? Math.random()), request.signal);
      }
    }
    throw lastError ?? this.error("Provider request failed", "request_failed");
  }

  private consumeStreamEvent(
    state: ResponsesStreamState,
    event: ServerSentEvent,
    emit: (event: StreamEventPayload) => void,
  ): void {
    if (!event.data.trim() || event.data.trim() === "[DONE]") return;
    let value: unknown;
    try { value = JSON.parse(event.data) as unknown; }
    catch { throw this.error("Provider returned an invalid Responses SSE event", "invalid_response"); }
    if (!isRecord(value)) throw this.error("Provider returned an unsupported Responses SSE event", "invalid_response");
    const type = typeof value.type === "string" ? value.type : event.event;
    if (type === "error" || type === "response.failed" || "error" in value) {
      throw streamProviderError(this.name, value, this.config.apiKey);
    }
    if (state.status !== undefined) {
      throw this.error("Provider sent another event after the Responses terminal event", "invalid_response");
    }
    if (type === "response.output_text.delta" && typeof value.delta === "string") {
      state.content += value.delta;
      emit({ kind: "text_delta", text: value.delta });
      return;
    }
    if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") &&
        typeof value.delta === "string") {
      state.reasoning += value.delta;
      emit({ kind: "reasoning_delta", text: value.delta });
      return;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      if (isRecord(value.item) && value.item.type === "function_call") {
        const key = typeof value.output_index === "number"
          ? String(value.output_index)
          : typeof value.item.id === "string" ? value.item.id : String(state.toolItems.size);
        const prior = state.toolItems.get(key) ?? { id: "", callId: "", name: "", arguments: "" };
        const next = {
          id: typeof value.item.id === "string" ? value.item.id : prior.id,
          callId: typeof value.item.call_id === "string" ? value.item.call_id : prior.callId,
          name: typeof value.item.name === "string" ? value.item.name : prior.name,
          arguments: typeof value.item.arguments === "string" ? value.item.arguments : prior.arguments,
        };
        state.toolItems.set(key, next);
        emit({ kind: "tool_call_delta", index: Number(key) || 0, id: next.callId || next.id, name: next.name, arguments: next.arguments });
      }
      return;
    }
    if (type === "response.function_call_arguments.delta" && typeof value.delta === "string") {
      const key = typeof value.output_index === "number"
        ? String(value.output_index)
        : typeof value.item_id === "string" ? value.item_id : "0";
      const prior = state.toolItems.get(key) ?? { id: typeof value.item_id === "string" ? value.item_id : "", callId: "", name: "", arguments: "" };
      prior.arguments += value.delta;
      state.toolItems.set(key, prior);
      emit({ kind: "tool_call_delta", index: Number(key) || 0, arguments: value.delta });
      return;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      if (!isRecord(value.response) || value.response.status !== type.slice("response.".length) ||
          !Array.isArray(value.response.output)) {
        throw this.error("Provider returned an invalid Responses terminal event", "invalid_response");
      }
      state.completed = value.response;
      state.status = type.slice("response.".length);
    }
  }

  private finishStream(state: ResponsesStreamState): ProviderResponse {
    if (state.completed !== undefined) {
      return this.parse({ statusCode: 200, headers: {}, body: JSON.stringify(state.completed) });
    }
    throw new ProviderError("Responses stream ended without a terminal event", {
      provider: this.name, code: "incomplete_stream", retryable: true,
    });
  }

  private async toInput(messages: readonly ChatMessage[], currentTurnImageIds?: readonly string[]): Promise<ResponseInput[]> {
    let projected = projectModelInputMessages(messages);
    if (this.runtime.visionSupported) {
      try {
        const originalImages = messages.flatMap((message) => message.role === "user" ? message.images ?? [] : []);
        for (const image of originalImages) validateImageAttachmentCollection([image]);
        if (currentTurnImageIds !== undefined) {
          const currentIds = new Set(currentTurnImageIds);
          projected = projected.map((message) => {
            if (message.role !== "user" || !message.images?.length) return message;
            const compatible: ImageAttachment[] = [];
            const omitted: Array<{ image: ImageAttachment; issue: string }> = [];
            for (const image of message.images) {
              const issue = providerImageCompatibilityIssue(this.name, image);
              if (!currentIds.has(image.id) && issue) omitted.push({ image, issue });
              else compatible.push(image);
            }
            if (!omitted.length) return message;
            return {
              role: "user",
              content: appendHistoricalImageOmissionNote(message.content, omitted),
              ...(compatible.length ? { images: compatible } : {}),
            };
          });
        }
        const requestImages = projected.flatMap((message) => message.role === "user" ? message.images ?? [] : []);
        validateImageAttachmentCollection(requestImages);
        validateProviderImageAttachments(this.name, requestImages);
      } catch (error) {
        throw this.error(error instanceof Error ? error.message : String(error), "invalid_images");
      }
    }
    const output: ResponseInput[] = [];
    for (const message of projected) {
      if (message.role === "assistant") {
        if (message.content) output.push({ role: "assistant", content: message.content });
        for (const call of message.tool_calls ?? []) output.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
        continue;
      }
      if (message.role === "tool") {
        output.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
        continue;
      }
      if (message.role === "system") {
        output.push({ role: "system", content: message.content });
        continue;
      }
      const attachments = message.images ?? [];
      if (!attachments.length) {
        output.push({ role: "user", content: message.content });
        continue;
      }
      if (!this.runtime.visionSupported) {
        output.push({ role: "user", content: `${message.content}\n\n${attachments.map((image) => `[${image.label} omitted: ${this.model} cannot receive images]`).join("\n")}` });
        continue;
      }
      if (!this.runtime.loadImage) throw this.error("No local image loader is configured.", "invalid_config");
      const content: ResponseInput[] = [{ type: "input_text", text: message.content }];
      for (const attachment of attachments) {
        const bytes = await this.runtime.loadImage(attachment);
        if (bytes.length !== attachment.byteSize) throw this.error(`Stored ${attachment.label} no longer matches its metadata.`, "image_integrity_error");
        content.push({ type: "input_image", image_url: `data:${attachment.mediaType};base64,${bytes.toString("base64")}` });
      }
      output.push({ role: "user", content });
    }
    return output;
  }

  private parse(response: JsonPostResponse): ProviderResponse {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ProviderError(`${this.name} API returned HTTP ${response.statusCode}: ${apiError(response.body)}`, {
        provider: this.name,
        code: "http_error",
        statusCode: response.statusCode,
        retryable: retryableStatus(response.statusCode),
        secrets: [this.config.apiKey],
      });
    }
    let decoded: unknown;
    try { decoded = JSON.parse(response.body) as unknown; }
    catch { throw this.error("Provider returned an invalid JSON response", "invalid_response"); }
    const parsed = responseSchema.safeParse(decoded);
    if (!parsed.success) throw this.error("Provider returned an unsupported Responses response", "invalid_response");
    const text: string[] = [];
    const reasoning: string[] = [];
    const toolCalls: FunctionToolCall[] = [];
    for (const item of parsed.data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") text.push(part.text);
      } else if (item.type === "function_call") {
        if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name || typeof item.arguments !== "string") {
          throw this.error("Provider returned an incomplete function call", "invalid_response");
        }
        toolCalls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
      } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
        for (const part of item.summary) if (isRecord(part) && typeof part.text === "string") reasoning.push(part.text);
      }
    }
    const message: Extract<ChatMessage, { role: "assistant" }> = { role: "assistant", content: text.length ? redactImageDataUrls(text.join("")) : null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (reasoning.length) message.reasoning_content = redactImageDataUrls(reasoning.join("\n"));
    const incompleteReason = parsed.data.incomplete_details?.reason;
    const finishReason = incompleteReason === "max_output_tokens"
      ? "length"
      : parsed.data.status === "incomplete" ? "incomplete"
      : incompleteReason ?? (parsed.data.status === "completed" ? "stop" : parsed.data.status ?? null);
    const result: ProviderResponse = { message, finishReason };
    if (parsed.data.usage) result.usage = {
      promptTokens: parsed.data.usage.input_tokens,
      completionTokens: parsed.data.usage.output_tokens,
      totalTokens: parsed.data.usage.total_tokens,
      cachedInputTokens: parsed.data.usage.input_tokens_details?.cached_tokens,
      reasoningTokens: parsed.data.usage.output_tokens_details?.reasoning_tokens,
    };
    return result;
  }

  private normalizeError(error: unknown, signal: AbortSignal | undefined, timeoutMs: number): ProviderError {
    if (error instanceof ProviderError) return error;
    if (error instanceof SseDecodingError) return this.error(error.message, "invalid_response");
    if (signal?.aborted) return this.error("Request was canceled", "aborted");
    if (error instanceof HttpTransportError) {
      if (error.kind === "aborted") return this.error("Request was canceled", "aborted");
      if (error.kind === "stream_idle_timeout") return new ProviderError(`Provider stream was idle for ${timeoutMs}ms`, { provider: this.name, code: "stream_idle_timeout", retryable: true });
      if (error.kind === "buffered_total_timeout") return new ProviderError(`Buffered provider request exceeded ${timeoutMs}ms`, { provider: this.name, code: "buffered_total_timeout", retryable: true });
      if (error.kind === "response_too_large") return this.error(error.message, "response_too_large");
      return new ProviderError(`Provider network error: ${error.message}`, { provider: this.name, code: "network_error", retryable: true, secrets: [this.config.apiKey] });
    }
    return new ProviderError(`Provider request failed: ${redactSensitiveText(error, [this.config.apiKey])}`, { provider: this.name, code: "request_failed", retryable: true, secrets: [this.config.apiKey] });
  }
  private error(message: string, code: string): ProviderError { return new ProviderError(message, { provider: this.name, code, secrets: [this.config.apiKey] }); }
}

function endpoint(baseUrl: string, provider: string): URL {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ProviderError("Provider base URL is invalid", { provider, code: "invalid_config" }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ProviderError("Provider base URL must use HTTP or HTTPS", { provider, code: "invalid_config" });
  if (url.username || url.password) throw new ProviderError("Provider base URL must not contain credentials", { provider, code: "invalid_config" });
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/responses`; url.search = ""; url.hash = ""; return url;
}
function retryableStatus(code: number): boolean { return code === 408 || code === 409 || code === 425 || code === 429 || code >= 500; }
function apiError(body: string): string {
  try { const value = JSON.parse(body) as unknown; if (isRecord(value)) { if (isRecord(value.error) && typeof value.error.message === "string") return value.error.message; if (typeof value.message === "string") return value.message; } } catch { /* bounded fallback */ }
  return body.trim().slice(0, 1_000) || "No error details were returned";
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function appendHistoricalImageOmissionNote(content: string, omitted: readonly { image: ImageAttachment; issue: string }[]): string {
  const details = omitted.map(({ issue }) => issue).join(" ");
  const prefix = "[Historical image attachment(s) omitted from this provider request: ";
  const suffix = " Local thread history is unchanged.]";
  const available = MAX_HISTORICAL_IMAGE_OMISSION_NOTE_CHARS - prefix.length - suffix.length;
  const bounded = details.length <= available ? details : `${details.slice(0, Math.max(0, available - 1))}…`;
  return [content, `${prefix}${bounded}${suffix}`].filter(Boolean).join("\n\n");
}
function retryDelay(attempt: number, random: number): number { return Math.round(Math.min(500 * 2 ** attempt, 5_000) * (0.8 + random * 0.4)); }
function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new HttpTransportError("aborted", "Request was canceled")); return; }
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new HttpTransportError("aborted", "Request was canceled")); }, { once: true });
  });
}
