import type {
  ChatMessage,
  ImageAttachment,
  ModelProvider,
  ProviderUsage,
  ThinkingEffort,
  ToolDefinition,
} from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { loadPromptBundleCatalog } from "../prompt-bundle/index.js";
import { documentToolSchema } from "../tools/metadata.js";

export interface AutoModeSelection {
  readonly kind: "route";
  mode: "plan" | "code";
  reason: string;
  readonly attempts: readonly AutoRouteAttempt[];
}

export interface AutoDirectResponse {
  readonly kind: "direct_response";
  readonly content: string;
  readonly reasoningContent?: string;
  readonly attempts: readonly AutoRouteAttempt[];
}

export type AutoRouteDecision = AutoModeSelection | AutoDirectResponse;

export interface AutoRouteAttempt {
  readonly attempt: number;
  readonly outcome: AutoRouteDecision["kind"] | "invalid";
  readonly usage?: ProviderUsage;
  readonly finishReason?: string | null;
}

export interface AutoRouteContext {
  readonly workingSummary?: string;
  readonly priorMessages?: readonly ChatMessage[];
}

export const MAX_AUTO_ROUTE_CONTEXT_CHARS = 12_000;
export const MAX_AUTO_DIRECT_RESPONSE_CHARS = 12_000;
const MAX_AUTO_DIRECT_REASONING_CHARS = 64_000;
const MAX_AUTO_ROUTE_CURRENT_REQUEST_CHARS = 16_000;
const MAX_AUTO_ROUTE_SUMMARY_CHARS = 3_000;
const MAX_AUTO_ROUTE_MESSAGE_CHARS = 3_500;
const MAX_AUTO_ROUTE_MESSAGES = 10;
const MAX_AUTO_ROUTE_REASON_CHARS = 300;
const AUTO_ROUTE_ATTEMPTS = 2;
const SELECT_MODE_TOOL_NAME = "select_mode";
const RESPOND_DIRECTLY_TOOL_NAME = "respond_directly";

/**
 * `select_mode` is a Runtime-only control tool. It is deliberately defined
 * beside the routing protocol rather than registered as an executable tool.
 */
function selectModeTool(): ToolDefinition {
  return {
    type: "function" as const,
    function: {
      name: SELECT_MODE_TOOL_NAME,
      strict: true,
      ...documentToolSchema(SELECT_MODE_TOOL_NAME, {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: {
            type: "string",
            enum: ["plan", "code"],
          },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: MAX_AUTO_ROUTE_REASON_CHARS,
          },
        },
        required: ["mode", "reason"],
      }),
    },
  };
}

/**
 * `respond_directly` lets the controller finish a bounded, tool-free request
 * without paying for a second main-agent model call. Like `select_mode`, it is
 * parsed by the Runtime and is never exposed as an executable agent tool.
 */
function respondDirectlyTool(): ToolDefinition {
  return {
    type: "function" as const,
    function: {
      // This Runtime-only control name deliberately does not expand the durable
      // ToolName union: providers serialize ToolDefinition names as strings.
      name: RESPOND_DIRECTLY_TOOL_NAME as ToolDefinition["function"]["name"],
      strict: true,
      ...documentToolSchema(RESPOND_DIRECTLY_TOOL_NAME, {
        type: "object",
        additionalProperties: false,
        properties: {
          content: {
            type: "string",
            minLength: 1,
            maxLength: MAX_AUTO_DIRECT_RESPONSE_CHARS,
          },
        },
        required: ["content"],
      }),
    },
  };
}

/** The verified controller schemas offered to the Auto routing request. */
export function autoRouteToolDefinitions(): readonly ToolDefinition[] {
  return Object.freeze([selectModeTool(), respondDirectlyTool()]);
}

export class AutoRouteSelectionError extends Error {
  readonly code = "auto_route_selection_failed";
  readonly attempts: readonly AutoRouteAttempt[];

  constructor(attempts: readonly AutoRouteAttempt[] = []) {
    super(
      `Auto mode could not route or answer directly because the model did not return exactly one valid ${SELECT_MODE_TOOL_NAME} or ${RESPOND_DIRECTLY_TOOL_NAME} tool call after ${AUTO_ROUTE_ATTEMPTS} attempts.`,
    );
    this.name = "AutoRouteSelectionError";
    this.attempts = [...attempts];
  }
}

/** Preserve completed attempt usage when a later controller request fails. */
export class AutoRouteRequestError extends Error {
  readonly code = "auto_route_request_failed";
  readonly attempts: readonly AutoRouteAttempt[];
  readonly originalError: unknown;

  constructor(error: unknown, attempts: readonly AutoRouteAttempt[]) {
    const message = error instanceof Error ? error.message : String(error);
    super(message);
    this.name = "AutoRouteRequestError";
    this.originalError = error;
    this.attempts = [...attempts];
  }
}

function sanitizeRouteContextText(value: string): string {
  return redactSensitiveInformation(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu, " ")
    .trim();
}

function boundedRouteText(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  const marker = loadPromptBundleCatalog().readText(
    "controllers/prior-context-truncated.md",
  );
  if (limit <= marker.length + 4) return value.slice(0, limit);
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`;
}

export function buildAutoRouteContext(
  context: AutoRouteContext | undefined,
): string {
  if (!context) return "";
  const sections: string[] = [];
  const summary = sanitizeRouteContextText(
    boundedRouteText(
      context.workingSummary ?? "",
      MAX_AUTO_ROUTE_SUMMARY_CHARS * 2,
    ),
  );
  if (summary) {
    sections.push(loadPromptBundleCatalog().render("controllers/thread-summary.md", {
      content: boundedRouteText(summary, MAX_AUTO_ROUTE_SUMMARY_CHARS),
    }).trimEnd());
  }

  const eligible = (context.priorMessages ?? [])
    .filter((message): message is Extract<ChatMessage, { role: "user" | "assistant" }> =>
      message.role === "user" || message.role === "assistant",
    )
    .filter((message) => Boolean(message.content?.trim()))
    .slice(-MAX_AUTO_ROUTE_MESSAGES)
    .map((message) => {
      const content = boundedRouteText(
        sanitizeRouteContextText(
          boundedRouteText(
            message.content ?? "",
            MAX_AUTO_ROUTE_MESSAGE_CHARS * 2,
          ),
        ),
        MAX_AUTO_ROUTE_MESSAGE_CHARS,
      );
      return loadPromptBundleCatalog().render(
        message.role === "user"
          ? "controllers/prior-user.md"
          : "controllers/prior-assistant.md",
        { content },
      ).trimEnd();
    });

  let remaining = MAX_AUTO_ROUTE_CONTEXT_CHARS - sections.join("\n\n").length;
  const selected: string[] = [];
  for (let index = eligible.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const entry = eligible[index];
    if (!entry) continue;
    const bounded = boundedRouteText(entry, remaining);
    selected.unshift(bounded);
    remaining -= bounded.length + 2;
  }
  sections.push(...selected);
  if (!sections.length) return "";
  const emptyWrapper = loadPromptBundleCatalog().render("controllers/prior-thread-context.md", {
    content: "",
  }).trimEnd();
  const contentBudget = Math.max(
    0,
    MAX_AUTO_ROUTE_CONTEXT_CHARS - (emptyWrapper.length),
  );
  return loadPromptBundleCatalog().render("controllers/prior-thread-context.md", {
    content: boundedRouteText(sections.join("\n\n"), contentBudget),
  }).trimEnd();
}

function buildRouterMessages(
  userInput: string,
  images: readonly ImageAttachment[],
  context: AutoRouteContext | undefined,
  retry: boolean,
  controllerPolicy: string | undefined,
): ChatMessage[] {
  const priorContext = buildAutoRouteContext(context);
  const currentRequest = boundedRouteText(
    sanitizeRouteContextText(
      boundedRouteText(userInput, MAX_AUTO_ROUTE_CURRENT_REQUEST_CHARS * 2),
    ),
    MAX_AUTO_ROUTE_CURRENT_REQUEST_CHARS,
  );
  const catalog = loadPromptBundleCatalog();
  const retryInstruction = retry
    ? catalog.readText("controllers/auto-router-retry.md").trimEnd()
    : "";
  const controllerPolicyPrefix = controllerPolicy?.trim()
    ? catalog.render("controllers/auto-router-policy-prefix.md", {
        controllerPolicy: controllerPolicy.trim(),
      })
    : "";
  return [
    {
      role: "system",
      content: catalog.render("controllers/auto-router.md", {
        controllerPolicyPrefix,
        retryInstruction,
      }).trimEnd(),
    },
    {
      role: "user",
      content: priorContext
        ? `${priorContext}\n\n${catalog.render("controllers/current-request.md", {
            content: currentRequest,
          }).trimEnd()}`
        : currentRequest,
      ...(images.length ? { images: [...images] } : {}),
    },
  ];
}

type ParsedAutoRouteDecision =
  | Omit<AutoModeSelection, "attempts">
  | Omit<AutoDirectResponse, "attempts">;

function parseAutoRouteDecision(
  message: Extract<ChatMessage, { role: "assistant" }>,
): ParsedAutoRouteDecision | undefined {
  const calls = message.tool_calls;
  if (!calls || calls.length !== 1) return undefined;
  const call = calls[0];
  if (
    !call ||
    call.type !== "function" ||
    (call.function.name !== SELECT_MODE_TOOL_NAME &&
      call.function.name !== RESPOND_DIRECTLY_TOOL_NAME)
  ) {
    return undefined;
  }

  let input: unknown;
  try {
    input = JSON.parse(call.function.arguments) as unknown;
  } catch {
    return undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (call.function.name === RESPOND_DIRECTLY_TOOL_NAME) {
    if (keys.length !== 1 || keys[0] !== "content") return undefined;
    if (typeof record.content !== "string") return undefined;
    if (record.content.length > MAX_AUTO_DIRECT_RESPONSE_CHARS) return undefined;
    const content = sanitizeRouteContextText(record.content);
    if (!content || content.length > MAX_AUTO_DIRECT_RESPONSE_CHARS) return undefined;
    const reasoningContent = message.reasoning_content?.trim()
      ? boundedRouteText(
          sanitizeRouteContextText(message.reasoning_content),
          MAX_AUTO_DIRECT_REASONING_CHARS,
        )
      : undefined;
    return {
      kind: "direct_response",
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
    };
  }

  if (keys.length !== 2 || keys[0] !== "mode" || keys[1] !== "reason") {
    return undefined;
  }
  if (record.mode !== "plan" && record.mode !== "code") return undefined;
  if (typeof record.reason !== "string") return undefined;
  const reason = sanitizeRouteContextText(record.reason);
  if (!reason || reason.length > MAX_AUTO_ROUTE_REASON_CHARS) return undefined;
  return {
    kind: "route",
    mode: record.mode,
    reason,
  };
}

function routeAttempt(
  attempt: number,
  outcome: AutoRouteAttempt["outcome"],
  response: Awaited<ReturnType<ModelProvider["complete"]>>,
): AutoRouteAttempt {
  return {
    attempt,
    outcome,
    ...(response.usage ? { usage: { ...response.usage } } : {}),
    ...(response.finishReason !== undefined
      ? { finishReason: response.finishReason }
      : {}),
  };
}

export async function determineAutoRoute(
  provider: ModelProvider,
  userInput: string,
  signal?: AbortSignal,
  images: readonly ImageAttachment[] = [],
  thinkingEffort?: ThinkingEffort,
  context?: AutoRouteContext,
  controllerPolicy?: string,
): Promise<AutoRouteDecision> {
  const attempts: AutoRouteAttempt[] = [];
  for (let attempt = 0; attempt < AUTO_ROUTE_ATTEMPTS; attempt += 1) {
    let response: Awaited<ReturnType<ModelProvider["complete"]>>;
    try {
      response = await provider.complete({
        messages: buildRouterMessages(
          userInput,
          images,
          context,
          attempt > 0,
          controllerPolicy,
        ),
        tools: [...autoRouteToolDefinitions()],
        signal,
        temperature: 0,
        thinkingEffort,
      });
    } catch (error) {
      if (attempts.length > 0) {
        throw new AutoRouteRequestError(error, attempts);
      }
      throw error;
    }
    const decision = parseAutoRouteDecision(response.message);
    attempts.push(
      routeAttempt(attempt + 1, decision?.kind ?? "invalid", response),
    );
    if (decision) return { ...decision, attempts: [...attempts] };
  }
  throw new AutoRouteSelectionError(attempts);
}
