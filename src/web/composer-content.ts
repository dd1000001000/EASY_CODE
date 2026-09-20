export const LONG_PASTE_THRESHOLD = 1_200;
export const MAX_MESSAGE_CHARACTERS = 200_000;

export interface PastedText {
  id: string;
  content: string;
}

export function pastedTextPreview(content: string): string {
  const firstLine = content.replace(/\s+/gu, " ").trim();
  return firstLine.length > 140 ? `${firstLine.slice(0, 140).trimEnd()}…` : firstLine;
}

export function composeMessage(draft: string, pastedTexts: readonly PastedText[]): string {
  const attachments = pastedTexts.map((item, index) =>
    `[Pasted text ${index + 1}]\n${item.content}\n[/Pasted text ${index + 1}]`);
  return [draft, ...attachments].filter(part => part.trim()).join("\n\n");
}

/** Match a command name only while the composer contains a bare slash prefix. */
export function matchingSlashCommands(draft: string, commands: readonly string[]): string[] {
  const match = /^\/([a-z0-9_-]*)$/iu.exec(draft);
  if (!match) return [];
  const prefix = match[1]!.toLowerCase();
  return commands.filter(command => command.startsWith(prefix));
}

export function composerPrimaryAction(busy: boolean, hasContent: boolean): "send" | "stop" {
  return busy && !hasContent ? "stop" : "send";
}

export type ComposerEnterAction = "none" | "send" | "newline" | "suppress";

export function composerEnterAction(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "keyCode" | "repeat">,
  compositionActive = false,
  compositionJustEnded = false,
): ComposerEnterAction {
  if (event.key !== "Enter" || compositionActive || event.isComposing || event.keyCode === 229) return "none";
  if (compositionJustEnded || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return "suppress";
  return event.shiftKey ? "newline" : "send";
}
