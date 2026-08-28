import { z } from "zod";

import type {
  ChatMessage,
  ImageAttachment,
  ModelProvider,
  ModelRequest,
  ProviderConfig,
  ProviderName,
  ProviderResponse,
} from "../core/types.js";
import {
  validateImageAttachmentCollection,
} from "../images/image-store.js";
import {
  providerImageCompatibilityIssue,
  validateProviderImageAttachments,
} from "../models/catalog.js";
import {
  thinkingEffortTimeoutMs,
  thinkingRequestParameters,
  type ProviderThinkingParameters,
} from "../models/thinking.js";
import {
  ProviderError,
  redactImageDataUrls,
  redactSensitiveText,
} from "./errors.js";
import {
  HttpTransportError,
  postJsonWithNode,
  type JsonPostResponse,
  type JsonPostTransport,
} from "./http-transport.js";

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
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

export interface ProviderRuntimeOptions {
  transport?: JsonPostTransport;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  maxResponseBytes?: number;
  /** Resolve a validated local attachment immediately before an API request. */
  loadImage?: (attachment: ImageAttachment) => Promise<Buffer>;
  /** Unknown models default to false in the provider factory. */
  visionSupported?: boolean;
}

type CompletionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type CompletionMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | CompletionContentPart[] }
  | Extract<ChatMessage, { role: "assistant" }>
  | Extract<ChatMessage, { role: "tool" }>;

interface CompletionBody extends ProviderThinkingParameters {
  model: string;
  messages: CompletionMessage[];
  stream: false;
  tools?: ModelRequest["tools"];
  temperature?: number;
  max_tokens?: number;
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

    const body: CompletionBody = {
      model: this.model,
      messages: await this.toCompletionMessages(
        request.messages,
        request.currentTurnImageIds,
      ),
      stream: false,
    };
    if (request.tools?.length) body.tools = request.tools;
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    Object.assign(
      body,
      thinkingRequestParameters(this.name, this.model, request.thinkingEffort),
    );
    const timeoutMs = this.config.timeoutMs ??
      thinkingEffortTimeoutMs(request.thinkingEffort ?? "none");

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
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (request.signal?.aborted) {
        throw this.error("Request was canceled", "aborted");
      }

      try {
        const response = await this.transport({
          url: this.endpoint,
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            accept: "application/json",
            "content-type": "application/json",
            "user-agent": "easy-code-agent/0.1",
          },
          body: serialized,
          timeoutMs,
          maxResponseBytes: this.maxResponseBytes,
          signal: request.signal,
        });
        return this.parseResponse(response);
      } catch (error) {
        const providerError = this.normalizeError(
          error,
          request.signal,
          timeoutMs,
        );
        lastError = providerError;
        if (!providerError.retryable || attempt >= this.config.maxRetries) {
          throw providerError;
        }
        const delay =
          providerError.retryAfterMs ?? this.retryDelayMs(attempt);
        try {
          await this.sleep(delay, request.signal);
        } catch (sleepError) {
          throw this.normalizeError(sleepError, request.signal, timeoutMs);
        }
      }
    }

    throw (
      lastError ?? this.error("Provider request failed", "request_failed")
    );
  }

  private async toCompletionMessages(
    messages: readonly ChatMessage[],
    currentTurnImageIds?: readonly string[],
  ): Promise<CompletionMessage[]> {
    let providerMessages = messages;
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
          providerMessages = messages.map((message) => {
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
        output.push({ ...message });
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
    if (parsed.data.usage) {
      result.usage = {
        promptTokens: parsed.data.usage.prompt_tokens,
        completionTokens: parsed.data.usage.completion_tokens,
        totalTokens: parsed.data.usage.total_tokens,
      };
    }
    return result;
  }

  private normalizeError(
    error: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): ProviderError {
    if (error instanceof ProviderError) return error;
    if (signal?.aborted) return this.error("Request was canceled", "aborted");
    if (error instanceof HttpTransportError) {
      if (error.kind === "aborted") {
        return this.error("Request was canceled", "aborted");
      }
      if (error.kind === "timeout") {
        return new ProviderError(
          `Provider request timed out after ${timeoutMs}ms`,
          {
            provider: this.name,
            code: "timeout",
            retryable: true,
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
