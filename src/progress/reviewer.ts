import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  ChatMessage,
  ModelProvider,
  ModelRequest,
  ProviderResponse,
  ProviderUsage,
  ThinkingEffort,
  ToolDefinition,
} from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { loadPromptBundleCatalog } from "../prompt-bundle/index.js";
import { safeJsonParse } from "../utils/json.js";

export const PROGRESS_REVIEW_TOOL_NAME = "submit_review_result";
export const MAX_PROGRESS_REVIEW_PACKET_CHARS = 64_000;
export const MAX_PROGRESS_REVIEW_OUTPUT_TOKENS = 6_144;

const MAX_REVIEW_SUMMARY_CHARS = 2_000;
const MAX_REVIEW_DETAIL_CHARS = 4_000;
const MAX_REVIEW_SIGNAL_CHARS = 2_000;
const MAX_REVIEW_ERROR_CHARS = 2_000;
const MAX_BINDING_LABEL_CHARS = 256;
const PACKET_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UNSAFE_REVIEW_TEXT =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/gu;
const UNSAFE_REVIEW_BINDING =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/u;

function normalizeReviewText(value: string): string {
  return redactSensitiveInformation(
    value
      .replace(/\r\n?/gu, "\n")
      .replace(UNSAFE_REVIEW_TEXT, " ")
      .replace(/[ \t]+/gu, " ")
      .replace(/ *\n */gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
  );
}

function boundedReviewText(maximum: number): z.ZodPipeline<
  z.ZodEffects<z.ZodString, string, string>,
  z.ZodString
> {
  return z
    .string()
    .max(maximum)
    .transform(normalizeReviewText)
    .pipe(z.string().min(1).max(maximum));
}

/**
 * Deliberately flat: providers receive no union or nested object schema. The
 * Runtime binds review/incident identity outside model-controlled arguments.
 */
export const progressReviewReportSchema = z
  .object({
    recommendation: z.enum(["run_experiment", "insufficient_evidence"]),
    summary: boundedReviewText(MAX_REVIEW_SUMMARY_CHARS),
    diagnosis: boundedReviewText(MAX_REVIEW_DETAIL_CHARS),
    evidence: boundedReviewText(MAX_REVIEW_DETAIL_CHARS),
    experiment: boundedReviewText(MAX_REVIEW_DETAIL_CHARS),
    expectedSignal: boundedReviewText(MAX_REVIEW_SIGNAL_CHARS),
    falsifyingSignal: boundedReviewText(MAX_REVIEW_SIGNAL_CHARS),
    // Optional only when reading pre-contract Journal records. Fresh reports
    // are required to provide these fields by parseReviewResponse below.
    experimentProgram: z.string().max(1024).optional(),
    experimentArgsJson: z.string().max(8000).optional(),
    experimentCwd: z.string().max(1024).optional(),
  })
  .strict().superRefine((report, context) => {
    if (report.recommendation !== "run_experiment" || report.experimentProgram === undefined) return;
    let args: unknown;
    try { args = JSON.parse(report.experimentArgsJson ?? ""); } catch { /* Invalid contract below. */ }
    if (!report.experimentProgram.trim() || /[\x00-\x1f]/u.test(report.experimentProgram) ||
        report.experimentCwd === undefined || !Array.isArray(args) || args.length > 256 ||
        args.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 16384)) {
      context.addIssue({ code: "custom", message: "Experiment requires a program, JSON string array of args, and cwd." });
    }
  });

export type ProgressReviewReport = z.infer<typeof progressReviewReportSchema>;

export interface ProgressReviewBinding {
  readonly reviewId: string;
  readonly incidentId: string;
  readonly intentRevision: number;
  readonly workspaceFingerprint: string;
  readonly progressWatermark: number;
  readonly packetDigest: string;
}

export interface ProgressReviewRequest {
  readonly binding: ProgressReviewBinding;
  /** Exact immutable packet whose SHA-256 is declared by binding.packetDigest. */
  readonly packet: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly maxOutputTokens?: number;
  /** Shared task budget may leave room for only the initial request. */
  readonly maxModelRequests?: 1 | 2;
  readonly signal?: AbortSignal;
}

export interface ProgressReviewModelRequestRecord {
  readonly ordinal: 1 | 2;
  readonly kind: "initial" | "schema_correction";
  readonly status: "completed" | "failed";
  readonly durationMs: number;
  readonly usage?: ProviderUsage;
  readonly error?: string;
}

export interface ProgressReviewModelRequestStart {
  readonly ordinal: 1 | 2;
  readonly kind: "initial" | "schema_correction";
}

export interface ProgressReviewAccounting {
  /** Zero when validation/profile loading fails before a Provider request. */
  readonly reviewAttempts: 0 | 1;
  readonly validReviews: 0 | 1;
  readonly reviewModelRequests: number;
  readonly reportedModelRequests: number;
  readonly unreportedModelRequests: number;
  readonly reviewInputTokens: number;
  readonly reviewOutputTokens: number;
  readonly reviewTotalTokens: number;
  readonly reviewCachedInputTokens: number;
  readonly reviewReasoningTokens: number;
  readonly reviewDurationMs: number;
  readonly requests: readonly ProgressReviewModelRequestRecord[];
}

export type ProgressReviewUnavailableReason =
  | "invalid_packet"
  | "profile_unavailable"
  | "provider_failure"
  | "invalid_report"
  | "interrupted";

export type ProgressReviewExecutionResult =
  | {
      readonly status: "completed";
      readonly binding: ProgressReviewBinding;
      readonly report: ProgressReviewReport;
      readonly accounting: ProgressReviewAccounting;
    }
  | {
      readonly status: "unavailable";
      readonly binding: ProgressReviewBinding;
      readonly reason: ProgressReviewUnavailableReason;
      readonly error: string;
      readonly accounting: ProgressReviewAccounting;
    };

export interface ProgressReviewerOptions {
  readonly provider: ModelProvider;
  /** Injectable monotonic clock for deterministic tests. */
  readonly nowMs?: () => number;
  /** Durable boundary invoked before the Provider can receive the request. */
  readonly onRequestStarted?: (
    request: Readonly<ProgressReviewModelRequestStart>,
  ) => Promise<void>;
  /** Durable request outcome, including bounded usage when the Provider returned it. */
  readonly onRequestFinished?: (
    request: Readonly<ProgressReviewModelRequestRecord>,
  ) => Promise<void>;
}

interface MutableAccounting {
  reviewAttempts: 0 | 1;
  validReviews: 0 | 1;
  reviewModelRequests: number;
  reportedModelRequests: number;
  reviewInputTokens: number;
  reviewOutputTokens: number;
  reviewTotalTokens: number;
  reviewCachedInputTokens: number;
  reviewReasoningTokens: number;
  reviewDurationMs: number;
  requests: ProgressReviewModelRequestRecord[];
}

interface ReviewerProfile {
  readonly messages: ChatMessage[];
  readonly tool: ToolDefinition;
  readonly correction: string;
}

interface ParsedReviewResponse {
  readonly report?: ProgressReviewReport;
  readonly error?: string;
}

class ProgressReviewProviderFailure extends Error {
  constructor(readonly causeValue: unknown) {
    super(errorText(causeValue));
    this.name = "ProgressReviewProviderFailure";
  }
}

/** Hash the exact packet text that will be sent to the isolated reviewer. */
export function progressReviewPacketDigest(packet: string): string {
  return `sha256:${createHash("sha256").update(packet, "utf8").digest("hex")}`;
}

/**
 * Reviewer-private function definition. Its name is intentionally absent from
 * the normal Agent Tool registry, so it cannot leak into main/child profiles.
 */
export function progressReviewToolDefinition(): ToolDefinition {
  const description = loadPromptBundleCatalog()
    .readText("runtime/progress-reviewer-tool.md")
    .trim();
  return {
    type: "function",
    function: {
      // ToolName is the registry's public-agent union. This private Provider
      // schema never enters that registry or AgentRuntime capability selection.
      name: PROGRESS_REVIEW_TOOL_NAME as ToolDefinition["function"]["name"],
      description,
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          recommendation: {
            type: "string",
            enum: ["run_experiment", "insufficient_evidence"],
          },
          summary: { type: "string", minLength: 1, maxLength: MAX_REVIEW_SUMMARY_CHARS },
          diagnosis: { type: "string", minLength: 1, maxLength: MAX_REVIEW_DETAIL_CHARS },
          evidence: { type: "string", minLength: 1, maxLength: MAX_REVIEW_DETAIL_CHARS },
          experiment: { type: "string", minLength: 1, maxLength: MAX_REVIEW_DETAIL_CHARS },
          experimentProgram: { type: "string", maxLength: 1024 },
          experimentArgsJson: { type: "string", maxLength: 8000 },
          experimentCwd: { type: "string", maxLength: 1024 },
          expectedSignal: {
            type: "string",
            minLength: 1,
            maxLength: MAX_REVIEW_SIGNAL_CHARS,
          },
          falsifyingSignal: {
            type: "string",
            minLength: 1,
            maxLength: MAX_REVIEW_SIGNAL_CHARS,
          },
        },
        required: [
          "recommendation",
          "summary",
          "diagnosis",
          "evidence",
          "experiment",
          "experimentProgram", "experimentArgsJson", "experimentCwd",
          "expectedSignal",
          "falsifyingSignal",
        ],
      },
    },
  };
}

/**
 * Execute one isolated reviewer attempt. A malformed first response receives
 * one format-only correction; it never creates another review attempt.
 */
export async function runProgressReviewer(
  request: Readonly<ProgressReviewRequest>,
  options: Readonly<ProgressReviewerOptions>,
): Promise<ProgressReviewExecutionResult> {
  const nowMs = options.nowMs ?? Date.now;
  const accounting = emptyAccounting();
  const invalidPacket = validateRequest(request);
  if (invalidPacket) {
    return unavailable(request.binding, "invalid_packet", invalidPacket, accounting);
  }

  // Runtime has already persisted progress.review.started before entering this
  // function. Profile failure is therefore still one charged review attempt,
  // even though no Provider request was dispatched.
  accounting.reviewAttempts = 1;

  let profile: ReviewerProfile;
  try {
    profile = loadReviewerProfile(request);
  } catch (error) {
    return unavailable(
      request.binding,
      "profile_unavailable",
      errorText(error),
      accounting,
    );
  }

  const attemptStartedAt = safeNow(nowMs);
  const maxTokens = request.maxOutputTokens ?? MAX_PROGRESS_REVIEW_OUTPUT_TOKENS;
  let first: ProviderResponse;
  try {
    first = await completeReviewRequest(
      options,
      request,
      profile,
      profile.messages,
      1,
      "initial",
      maxTokens,
      accounting,
      nowMs,
    );
  } catch (error) {
    accounting.reviewDurationMs = elapsed(attemptStartedAt, safeNow(nowMs));
    return unavailable(
      request.binding,
      request.signal?.aborted ? "interrupted" : "provider_failure",
      providerFailureText(error),
      accounting,
    );
  }

  const firstParsed = parseReviewResponse(first);
  if (firstParsed.report) {
    accounting.validReviews = 1;
    accounting.reviewDurationMs = elapsed(attemptStartedAt, safeNow(nowMs));
    return completed(request.binding, firstParsed.report, accounting);
  }

  if (request.maxModelRequests === 1) {
    accounting.reviewDurationMs = elapsed(attemptStartedAt, safeNow(nowMs));
    return unavailable(
      request.binding,
      "invalid_report",
      firstParsed.error ?? "Reviewer did not submit a valid structured report.",
      accounting,
    );
  }

  if (request.signal?.aborted) {
    accounting.reviewDurationMs = elapsed(attemptStartedAt, safeNow(nowMs));
    return unavailable(
      request.binding,
      "interrupted",
      "Review was interrupted before its format correction.",
      accounting,
    );
  }

  const correctionMessages = correctedMessages(
    profile.messages,
    first,
    profile.correction,
  );
  let corrected: ProviderResponse;
  try {
    corrected = await completeReviewRequest(
      options,
      request,
      profile,
      correctionMessages,
      2,
      "schema_correction",
      maxTokens,
      accounting,
      nowMs,
    );
  } catch (error) {
    accounting.reviewDurationMs = elapsed(attemptStartedAt, safeNow(nowMs));
    return unavailable(
      request.binding,
      request.signal?.aborted ? "interrupted" : "provider_failure",
      providerFailureText(error),
      accounting,
    );
  }

  const correctedParsed = parseReviewResponse(corrected);
  accounting.reviewDurationMs = elapsed(attemptStartedAt, safeNow(nowMs));
  if (!correctedParsed.report) {
    return unavailable(
      request.binding,
      "invalid_report",
      correctedParsed.error ?? "Reviewer did not submit a valid structured report.",
      accounting,
    );
  }
  accounting.validReviews = 1;
  return completed(request.binding, correctedParsed.report, accounting);
}

function loadReviewerProfile(request: Readonly<ProgressReviewRequest>): ReviewerProfile {
  const catalog = loadPromptBundleCatalog();
  const binding = JSON.stringify(request.binding);
  return {
    messages: [
      {
        role: "system",
        content: catalog.readText("runtime/progress-reviewer.md").trim(),
      },
      {
        role: "user",
        content: catalog.render("runtime/progress-reviewer-request.md", {
          binding,
          packet: request.packet,
        }).trim(),
      },
    ],
    tool: progressReviewToolDefinition(),
    correction: catalog.readText("runtime/progress-reviewer-correction.md").trim(),
  };
}

async function completeReviewRequest(
  options: Readonly<ProgressReviewerOptions>,
  request: Readonly<ProgressReviewRequest>,
  profile: Readonly<ReviewerProfile>,
  messages: readonly ChatMessage[],
  ordinal: 1 | 2,
  kind: ProgressReviewModelRequestRecord["kind"],
  maxTokens: number,
  accounting: MutableAccounting,
  nowMs: () => number,
): Promise<ProviderResponse> {
  const startedAt = safeNow(nowMs);
  await options.onRequestStarted?.({ ordinal, kind });
  accounting.reviewModelRequests += 1;
  const modelRequest: ModelRequest = {
    messages: cloneMessages(messages),
    tools: [cloneToolDefinition(profile.tool)],
    signal: request.signal,
    temperature: 0,
    maxTokens,
    // Every reviewer Provider dispatch has its own durable lifecycle event;
    // suppress hidden transport retries so accounting remains exact.
    maxRetries: 0,
    thinkingEffort: request.thinkingEffort,
  };
  try {
    const response = await options.provider.complete(modelRequest);
    const durationMs = elapsed(startedAt, safeNow(nowMs));
    addUsage(accounting, response.usage);
    const record: ProgressReviewModelRequestRecord = {
      ordinal,
      kind,
      status: "completed",
      durationMs,
      ...(response.usage ? { usage: { ...response.usage } } : {}),
    };
    accounting.requests.push(record);
    await options.onRequestFinished?.(record);
    return response;
  } catch (error) {
    const existing = accounting.requests.find(
      (candidate) => candidate.ordinal === ordinal,
    );
    if (existing) {
      throw new ProgressReviewProviderFailure(error);
    }
    const record: ProgressReviewModelRequestRecord = {
      ordinal,
      kind,
      status: "failed",
      durationMs: elapsed(startedAt, safeNow(nowMs)),
      error: errorText(error),
    };
    accounting.requests.push(record);
    await options.onRequestFinished?.(record);
    throw new ProgressReviewProviderFailure(error);
  }
}

function parseReviewResponse(response: Readonly<ProviderResponse>): ParsedReviewResponse {
  const calls = response.message.tool_calls ?? [];
  if (calls.length !== 1) {
    return {
      error: `Reviewer must call ${PROGRESS_REVIEW_TOOL_NAME} exactly once.`,
    };
  }
  const call = calls[0];
  if (call?.function.name !== PROGRESS_REVIEW_TOOL_NAME) {
    return { error: `Reviewer called an unavailable tool instead of ${PROGRESS_REVIEW_TOOL_NAME}.` };
  }
  try {
    const report = progressReviewReportSchema.parse(
      safeJsonParse(call.function.arguments),
    );
    if (report.recommendation === "run_experiment" && report.experimentProgram === undefined) {
      return { error: "Supply experimentProgram, experimentArgsJson (JSON array of strings), and experimentCwd to bind a real command. Otherwise choose insufficient_evidence." };
    }
    return { report };
  } catch (error) {
    return { error: errorText(error) };
  }
}

function correctedMessages(
  initial: readonly ChatMessage[],
  response: Readonly<ProviderResponse>,
  correction: string,
): ChatMessage[] {
  const messages = cloneMessages(initial);
  const toolCalls = response.message.tool_calls?.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { ...call.function },
  }));
  messages.push({
    role: "assistant",
    content: response.message.content,
    ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    ...(response.message.reasoning_content !== undefined
      ? { reasoning_content: response.message.reasoning_content }
      : {}),
  });
  for (const call of toolCalls ?? []) {
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      name: call.function.name,
      content: JSON.stringify({
        ok: false,
        error: "invalid_review_report",
      }),
    });
  }
  messages.push({ role: "user", content: correction });
  return messages;
}

function validateRequest(request: Readonly<ProgressReviewRequest>): string | undefined {
  if (!request.packet.trim()) return "Review packet is empty.";
  if (request.packet.length > MAX_PROGRESS_REVIEW_PACKET_CHARS) {
    return `Review packet exceeds ${MAX_PROGRESS_REVIEW_PACKET_CHARS} characters.`;
  }
  if (progressReviewPacketDigest(request.packet) !== request.binding.packetDigest) {
    return "Review packet digest does not match its immutable binding.";
  }
  if (!PACKET_DIGEST_PATTERN.test(request.binding.packetDigest)) {
    return "Review packet digest is invalid.";
  }
  if (!PACKET_DIGEST_PATTERN.test(request.binding.workspaceFingerprint)) {
    return "Workspace fingerprint is invalid.";
  }
  for (const [name, value] of [
    ["reviewId", request.binding.reviewId],
    ["incidentId", request.binding.incidentId],
    ["workspaceFingerprint", request.binding.workspaceFingerprint],
  ] as const) {
    if (
      !value ||
      value.length > MAX_BINDING_LABEL_CHARS ||
      UNSAFE_REVIEW_BINDING.test(value)
    ) {
      return `${name} is invalid.`;
    }
  }
  if (
    !Number.isSafeInteger(request.binding.intentRevision) ||
    request.binding.intentRevision < 0
  ) {
    return "intentRevision must be a non-negative safe integer.";
  }
  if (
    !Number.isSafeInteger(request.binding.progressWatermark) ||
    request.binding.progressWatermark < 0
  ) {
    return "progressWatermark must be a non-negative safe integer.";
  }
  if (
    request.thinkingEffort !== "none" &&
    request.thinkingEffort !== "low" &&
    request.thinkingEffort !== "medium" &&
    request.thinkingEffort !== "high"
  ) {
    return "Reviewer thinking effort is invalid.";
  }
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      request.maxOutputTokens > MAX_PROGRESS_REVIEW_OUTPUT_TOKENS)
  ) {
    return `maxOutputTokens must be an integer from 1 through ${MAX_PROGRESS_REVIEW_OUTPUT_TOKENS}.`;
  }
  if (
    request.maxModelRequests !== undefined &&
    request.maxModelRequests !== 1 &&
    request.maxModelRequests !== 2
  ) {
    return "maxModelRequests must be 1 or 2.";
  }
  return undefined;
}

function emptyAccounting(): MutableAccounting {
  return {
    reviewAttempts: 0,
    validReviews: 0,
    reviewModelRequests: 0,
    reportedModelRequests: 0,
    reviewInputTokens: 0,
    reviewOutputTokens: 0,
    reviewTotalTokens: 0,
    reviewCachedInputTokens: 0,
    reviewReasoningTokens: 0,
    reviewDurationMs: 0,
    requests: [],
  };
}

function addUsage(accounting: MutableAccounting, usage: ProviderUsage | undefined): void {
  if (!usage || Object.values(usage).every((value) => value === undefined)) return;
  accounting.reportedModelRequests += 1;
  const input = usage.promptTokens ?? 0;
  const output = usage.completionTokens ?? 0;
  accounting.reviewInputTokens += input;
  accounting.reviewOutputTokens += output;
  accounting.reviewTotalTokens += usage.totalTokens ?? input + output;
  accounting.reviewCachedInputTokens += usage.cachedInputTokens ?? 0;
  accounting.reviewReasoningTokens += usage.reasoningTokens ?? 0;
}

function completed(
  binding: Readonly<ProgressReviewBinding>,
  report: Readonly<ProgressReviewReport>,
  accounting: MutableAccounting,
): ProgressReviewExecutionResult {
  return {
    status: "completed",
    binding: { ...binding },
    report: { ...report },
    accounting: snapshotAccounting(accounting),
  };
}

function unavailable(
  binding: Readonly<ProgressReviewBinding>,
  reason: ProgressReviewUnavailableReason,
  error: string,
  accounting: MutableAccounting,
): ProgressReviewExecutionResult {
  return {
    status: "unavailable",
    binding: { ...binding },
    reason,
    error: normalizeReviewText(error).slice(0, MAX_REVIEW_ERROR_CHARS) || reason,
    accounting: snapshotAccounting(accounting),
  };
}

function snapshotAccounting(accounting: MutableAccounting): ProgressReviewAccounting {
  return {
    reviewAttempts: accounting.reviewAttempts,
    validReviews: accounting.validReviews,
    reviewModelRequests: accounting.reviewModelRequests,
    reportedModelRequests: accounting.reportedModelRequests,
    unreportedModelRequests:
      accounting.reviewModelRequests - accounting.reportedModelRequests,
    reviewInputTokens: accounting.reviewInputTokens,
    reviewOutputTokens: accounting.reviewOutputTokens,
    reviewTotalTokens: accounting.reviewTotalTokens,
    reviewCachedInputTokens: accounting.reviewCachedInputTokens,
    reviewReasoningTokens: accounting.reviewReasoningTokens,
    reviewDurationMs: accounting.reviewDurationMs,
    requests: accounting.requests.map((request) => ({
      ...request,
      ...(request.usage ? { usage: { ...request.usage } } : {}),
    })),
  };
}

function cloneMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        ...message,
        ...(message.tool_calls
          ? {
              tool_calls: message.tool_calls.map((call) => ({
                ...call,
                function: { ...call.function },
              })),
            }
          : {}),
      };
    }
    return { ...message };
  });
}

function cloneToolDefinition(tool: Readonly<ToolDefinition>): ToolDefinition {
  return JSON.parse(JSON.stringify(tool)) as ToolDefinition;
}

function errorText(error: unknown): string {
  return normalizeReviewText(error instanceof Error ? error.message : String(error))
    .slice(0, MAX_REVIEW_ERROR_CHARS) || "Unknown reviewer error.";
}

function providerFailureText(error: unknown): string {
  return error instanceof ProgressReviewProviderFailure
    ? errorText(error.causeValue)
    : errorText(error);
}

function safeNow(nowMs: () => number): number {
  const value = nowMs();
  return Number.isFinite(value) ? value : 0;
}

function elapsed(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}
