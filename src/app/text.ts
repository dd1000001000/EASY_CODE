/** Small text and path helpers used by the interactive app shell. */

import path from "node:path";
import type { ChatMessage, ImageAttachment } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { loadPromptBundleCatalog } from "../prompt-bundle/index.js";

export function promptBundleText(path: string): string {
  return loadPromptBundleCatalog().readText(path).trimEnd();
}

export function renderPromptBundleText(
  path: string,
  values: Readonly<Record<string, string | number | boolean>>,
): string {
  return loadPromptBundleCatalog().render(path, values).trimEnd();
}

export function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function messagePreview(message: ChatMessage): string {
  const role = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "Tool";
  let content = message.content ?? "";
  if (!content && message.role === "assistant" && message.tool_calls?.length) {
    content = `[Tool calls: ${message.tool_calls.map((call) => call.function.name).join(", ")}]`;
  }
  const compact = redactSensitiveInformation(content.replace(/\s+/gu, " ").trim()).slice(0, 240);
  const labels =
    message.role === "user" && message.images?.length
      ? ` [${message.images.map((image) => image.label).join(", ")}]`
      : "";
  return `${role}: ${compact || "(empty)"}${labels}`;
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function parseQuotedArguments(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && value[index + 1] === '"') current += value[++index]!;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/u.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else current += char;
  }
  if (quote) throw new Error("Unclosed quote in command arguments");
  if (current) args.push(current);
  return args;
}

export function stripPasteFailureMarkers(value: string): string {
  return value.replace(/\s*\[Image paste failed\]\s*/gu, " ").trim();
}

export function stripImageMarkers(value: string, images: readonly ImageAttachment[]): string {
  let result = value;
  for (const image of images) {
    result = result.replaceAll(`[${image.label}]`, " ");
  }
  return stripPasteFailureMarkers(result).replace(/\s+/gu, " ").trim();
}
