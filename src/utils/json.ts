export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON tool arguments: ${message}`);
  }
}

export function jsonForModel(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Map) return Object.fromEntries(item);
    return item;
  });
}
