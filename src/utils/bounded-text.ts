import { z } from "zod";

export interface TextProjection {
  text: string;
  truncated: boolean;
  originalSize: number;
  retainedSize: number;
}

/** Storage/display only. Never apply to executable arguments or authorization scopes. */
export function projectText(value: string, maximum: number,
  measure: (text: string) => number = text => text.length): TextProjection {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid text budget");
  const originalSize = measure(value);
  if (originalSize <= maximum) return { text: value, truncated: false, originalSize, retainedSize: originalSize };
  let low = 0, high = value.length;
  const prefix = (end: number) => value.slice(0, end).replace(/[\uD800-\uDBFF]$/u, "");
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(prefix(middle)) <= maximum) low = middle; else high = middle - 1;
  }
  const text = prefix(low);
  return { text, truncated: true, originalSize, retainedSize: measure(text) };
}

/** An explicit lossy preview; the marker is included in the budget. */
export function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = " [truncated]";
  if (maximum < marker.length) return projectText(value, maximum).text;
  return projectText(value, maximum - marker.length).text + marker;
}

export function displayTextSchema(maximum: number, normalize = (value: string) => value.trim()) {
  return z.string().transform(value => boundedText(normalize(value), maximum))
    .pipe(z.string().min(1).max(maximum));
}
