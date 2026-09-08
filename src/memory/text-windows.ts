/** Original-text windows, measured with the embedding tokenizer (not the chat
 * model estimator). No character, including a surrogate pair, is discarded. */
export interface TextWindow {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function tokenWindows(
  text: string,
  count: (text: string) => number,
  maximum: number,
): TextWindow[] {
  if (!Number.isSafeInteger(maximum) || maximum < 4) throw new Error("Invalid token window");
  if (!text) return [];
  const points = Array.from(text);
  const offsets = [0];
  for (const point of points) offsets.push(offsets[offsets.length - 1]! + point.length);
  const windows: TextWindow[] = [];
  let start = 0;
  while (start < points.length) {
    let low = start + 1;
    let high = Math.min(points.length, start + 4096);
    let end = start;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (count(text.slice(offsets[start], offsets[middle])) <= maximum) {
        end = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (end === start) throw new Error("One character exceeds the embedding token window");
    // Prefer a line/word boundary, but never use an unmeasured replacement.
    if (end < points.length) {
      for (let split = end; split > start + (end - start) * 0.7; split -= 1) {
        if (/\s/u.test(points[split - 1]!)) {
          if (count(text.slice(offsets[start], offsets[split])) <= maximum) end = split;
          break;
        }
      }
    }
    const value = text.slice(offsets[start], offsets[end]);
    if (count(value) > maximum) throw new Error("Embedding window exceeds measured capacity");
    windows.push({ text: value, start: offsets[start]!, end: offsets[end]! });
    start = end;
  }
  return windows;
}
