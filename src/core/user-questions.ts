import type { UserQuestion, UserQuestionAnswer } from "./types.js";

export const USER_QUESTION_HEADER_MAX_CHARS = 16;
export const USER_QUESTION_TEXT_MAX_CHARS = 300;
export const USER_QUESTION_LABEL_MAX_CHARS = 60;
export const USER_QUESTION_DESCRIPTION_MAX_CHARS = 200;
/** The user's own answer to one question. */
export const USER_ANSWER_MAX_CHARS = 2000;

const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu;

/** Display-safe text: normalized line breaks, no terminal or bidi controls, trimmed. */
export function cleanQuestionText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(UNSAFE_CONTROLS, " ").trim();
}

/** Every UI adds its own "Other" answer, so a model-written option must not repeat it. */
export function isReservedOptionLabel(label: string): boolean {
  const normalized = cleanQuestionText(label).toLowerCase();
  return /^others?(?![a-z])/u.test(normalized) || /^(?:其他|其它)/u.test(normalized);
}

/**
 * Check one submitted answer per question against the options that were shown;
 * undefined when the answers do not fit. A single-choice question takes exactly
 * one option or the user's own text; a multiple-choice question takes at least
 * one of either.
 */
export function normalizeUserAnswers(
  questions: readonly UserQuestion[],
  answers: unknown,
): UserQuestionAnswer[] | undefined {
  if (!Array.isArray(answers) || answers.length !== questions.length) return undefined;
  const normalized: UserQuestionAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const answer: unknown = answers[index];
    if (!answer || typeof answer !== "object") return undefined;
    const { selected, custom } = answer as { selected?: unknown; custom?: unknown };
    if (!Array.isArray(selected) || selected.some((label) => typeof label !== "string")) return undefined;
    const labels = new Set(question.options.map((option) => option.label));
    const chosen = [...new Set(selected as string[])];
    if (chosen.length !== selected.length || chosen.some((label) => !labels.has(label))) return undefined;
    if (custom !== undefined && custom !== null && typeof custom !== "string") return undefined;
    const text = typeof custom === "string" ? cleanQuestionText(custom) : "";
    if (text.length > USER_ANSWER_MAX_CHARS) return undefined;
    const count = chosen.length + (text ? 1 : 0);
    if (question.multiSelect ? count < 1 : count !== 1) return undefined;
    // Keep the order the options were offered in.
    const ordered = question.options.map((option) => option.label).filter((label) => chosen.includes(label));
    normalized.push({ selected: ordered, custom: text || null });
  }
  return normalized;
}
