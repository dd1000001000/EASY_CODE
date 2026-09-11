import type { ToolContent, ToolExecutionResult } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { projectText } from "../utils/bounded-text.js";
import { jsonForModel } from "../utils/json.js";

const MAX_CONTENT_ITEMS = 64;
const SAFE_REFERENCE = /^[A-Za-z0-9._:-]{1,256}$/u;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, room: number, field: string): string {
  if (typeof value !== "string") throw new Error(`Tool content ${field} must be text`);
  return projectText(redactSensitiveInformation(value), Math.max(0, room)).text;
}

function structured(value: unknown, room: number): unknown {
  let encoded: string;
  try {
    encoded = jsonForModel(value);
  } catch {
    throw new Error("Tool structured content must be finite JSON data");
  }
  const redacted = redactSensitiveInformation(encoded);
  if (redacted.length > room) {
    return { truncated: true, originalChars: redacted.length };
  }
  try {
    return JSON.parse(redacted) as unknown;
  } catch {
    throw new Error("Tool structured content could not be safely normalized");
  }
}

function normalizeItem(item: unknown, room: number): ToolContent {
  if (!object(item) || typeof item.type !== "string") throw new Error("Tool content item is invalid");
  if (item.type === "text") return { type: "text", text: boundedText(item.text, room, "text") };
  if (item.type === "structured") return { type: "structured", value: structured(item.value, room) };
  if (item.type === "image") {
    if (typeof item.attachmentId !== "string" || !SAFE_REFERENCE.test(item.attachmentId)) {
      throw new Error("Tool image content has an invalid attachment identity");
    }
    return { type: "image", attachmentId: item.attachmentId };
  }
  if (item.type === "artifact") {
    if (typeof item.evidenceId !== "string" || !SAFE_REFERENCE.test(item.evidenceId)) {
      throw new Error("Tool artifact content has an invalid evidence identity");
    }
    return { type: "artifact", evidenceId: item.evidenceId };
  }
  if (item.type === "resource") {
    const uri = boundedText(item.uri, Math.min(room, 2_048), "resource URI");
    if (!uri) throw new Error("Tool resource content has an empty URI");
    const title = item.title === undefined
      ? undefined
      : boundedText(item.title, Math.min(room, 512), "resource title");
    return { type: "resource", uri, ...(title === undefined ? {} : { title }) };
  }
  throw new Error(`Unsupported tool content type ${item.type}`);
}

/** Validate, redact, and bound rich content before it crosses Runtime boundaries. */
export function normalizeToolContentResult(
  result: ToolExecutionResult,
  maximumChars: number,
): ToolExecutionResult {
  if (result.content === undefined) return result;
  if (!Array.isArray(result.content)) throw new Error("Tool result content must be an array");
  if (result.content.length > MAX_CONTENT_ITEMS) throw new Error(`Tool result content exceeds ${MAX_CONTENT_ITEMS} items`);
  const content: ToolContent[] = [];
  // Reserve brackets and charge separators so the serialized union itself,
  // not merely the sum of its items, remains inside the Runtime budget.
  let remaining = Math.max(0, maximumChars - 2);
  for (const item of result.content) {
    const normalized = normalizeItem(item, remaining);
    const cost = jsonForModel(normalized).length + (content.length === 0 ? 0 : 1);
    if (cost > remaining) break;
    content.push(normalized);
    remaining -= cost;
  }
  return { ...result, content };
}
