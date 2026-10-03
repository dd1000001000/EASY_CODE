import type { UserQuestion, UserQuestionAnswer } from "../core/types.js";
import { cleanQuestionText, normalizeUserAnswers, USER_ANSWER_MAX_CHARS } from "../core/user-questions.js";
import { translate } from "../i18n/catalog.js";
import type { Language } from "../i18n/language.js";
import { displayWidth } from "./render/layout.js";

/** What the user has chosen so far for one question. */
export interface QuestionDraft {
  readonly selected: readonly string[];
  readonly custom: string | null;
}

/** One selectable row: an option, or (always last) the field for the user's own answer. */
export interface QuestionRow {
  readonly kind: "option" | "other";
  readonly label: string;
  readonly detail?: string;
  /** The option label, for `option` rows. */
  readonly option?: string;
}

/** The user's own answer as typed so far, and whether the cursor is in its field. */
export interface QuestionInput {
  readonly text: string;
  readonly focused: boolean;
  /** Display cells available to the row. */
  readonly width: number;
}

/** Drafts from the chosen options and the text typed for each question. */
export function questionDrafts(
  questions: readonly UserQuestion[],
  selections: readonly (readonly string[])[],
  texts: readonly string[],
): QuestionDraft[] {
  return questions.map((_question, index) => ({
    selected: selections[index] ?? [],
    custom: cleanQuestionText(texts[index] ?? "").slice(0, USER_ANSWER_MAX_CHARS) || null,
  }));
}

export function draftAnswered(question: Readonly<UserQuestion>, draft: Readonly<QuestionDraft>): boolean {
  const count = draft.selected.length + (draft.custom ? 1 : 0);
  return question.multiSelect ? count >= 1 : count === 1;
}

/** Single choice replaces the answer; multiple choice toggles the option. */
export function chooseOption(
  question: Readonly<UserQuestion>,
  draft: Readonly<QuestionDraft>,
  label: string,
): QuestionDraft {
  if (!question.multiSelect) return { selected: [label], custom: null };
  const selected = draft.selected.includes(label)
    ? draft.selected.filter((item) => item !== label)
    : question.options.map((option) => option.label).filter((item) => item === label || draft.selected.includes(item));
  return { selected, custom: draft.custom };
}

export function draftsToAnswers(
  questions: readonly UserQuestion[],
  drafts: readonly QuestionDraft[],
): UserQuestionAnswer[] | undefined {
  return normalizeUserAnswers(questions, drafts);
}

/** The first question without an answer, or -1. */
export function firstUnanswered(questions: readonly UserQuestion[], drafts: readonly QuestionDraft[]): number {
  return questions.findIndex((question, index) => !draftAnswered(question, drafts[index] ?? emptyDraft));
}

const emptyDraft: QuestionDraft = { selected: [], custom: null };

export function questionTitle(language: Language, questions: readonly UserQuestion[], index: number): string {
  const header = questions[index]?.header ?? "";
  return questions.length === 1
    ? translate(language, "ui.askTitleSingle", { header })
    : translate(language, "ui.askTitle", { index: index + 1, count: questions.length, header });
}

/** The options, then the field where the user types their own answer. */
export function questionRows(
  language: Language,
  question: Readonly<UserQuestion>,
  draft: Readonly<QuestionDraft>,
  input: Readonly<QuestionInput>,
): QuestionRow[] {
  const rows: QuestionRow[] = question.options.map((option) => {
    const chosen = draft.selected.includes(option.label);
    const mark = question.multiSelect ? (chosen ? "[x] " : "[ ] ") : chosen ? "✓ " : "";
    return {
      kind: "option",
      option: option.label,
      label: `${mark}${option.label}`,
      ...(option.description ? { detail: option.description } : {}),
    };
  });
  const typed = Boolean(draft.custom);
  const mark = question.multiSelect ? (typed ? "[x] " : "[ ] ") : typed && draft.selected.length === 0 ? "✓ " : "";
  const text = input.text.replace(/[\r\n\t]+/gu, " ");
  const prefix = `${mark}${translate(language, "ui.askOtherLabel")}`;
  const cursor = input.focused ? "█" : "";
  if (!text) {
    // Empty, the field says where to type, like an input placeholder.
    rows.push({ kind: "other", label: `${prefix}${cursor}${translate(language, "ui.askOtherPlaceholder")}` });
    return rows;
  }
  const room = Math.max(1, input.width - displayWidth(prefix) - displayWidth(cursor));
  rows.push({ kind: "other", label: `${prefix}${tailToWidth(text, room)}${cursor}` });
  return rows;
}

/** The end of `text` that fits in `width` cells, so the newest characters stay visible. */
function tailToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  const characters = Array.from(text);
  let start = 0;
  while (start < characters.length && displayWidth(`…${characters.slice(start).join("")}`) > width) start += 1;
  return `…${characters.slice(start).join("")}`;
}

/** Remaining time as m:ss, or h:mm:ss from an hour up. */
export function formatRemaining(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
