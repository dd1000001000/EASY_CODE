export function chooseClipboardMediaType(value: string): string | undefined {
  const available = new Set(value.split(/[\s,]+/u).map((entry) => entry.trim().toLowerCase()));
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].find((type) =>
    available.has(type),
  );
}

export function chooseClipboardTextType(value: string): string | undefined {
  const available = new Map(
    value
      .split(/[\r\n,]+/u)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => [entry.toLowerCase(), entry]),
  );
  for (const candidate of [
    "text/plain;charset=utf-8",
    "utf8_string",
    "text/plain",
    "text",
    "string",
  ]) {
    const original = available.get(candidate);
    if (original) return original;
  }
  return undefined;
}
