import chalk from "chalk";
import { Box, Text, useInput, usePaste } from "ink";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { UIOverlayState } from "../contracts.js";
import { sanitizeTerminalText } from "../render/layout.js";
import { renderOverlayRegion, type RenderViewOptions } from "../render/view.js";
import type { UIState } from "../contracts.js";
import { Composer } from "./composer.js";
import type { MenuModal, QuestionModal, SecretModal, TextModal } from "./ink-store.js";
import { translate } from "../../i18n/catalog.js";
import { DEFAULT_LANGUAGE } from "../../i18n/language.js";
import { USER_ANSWER_MAX_CHARS } from "../../core/user-questions.js";
import {
  chooseOption,
  draftAnswered,
  firstUnanswered,
  formatRemaining,
  questionDrafts,
  questionRows,
  questionTitle,
  type QuestionDraft,
} from "../user-questions.js";

/** Terminals shorter than this cannot show a safe approval dialog. */
const MINIMUM_APPROVAL_ROWS = 4;
/** Enter pressed while a dialog was opening is almost always type-ahead, not confirmation. */
const OPENING_GRACE_MS = 150;
const MAX_SECRET_CHARS = 4096;

interface ModalProps {
  readonly ui: UIState;
  readonly view: RenderViewOptions;
  readonly width: number;
  readonly color: boolean;
  /** Draft rows available to an editing dialog. */
  readonly composerRows?: number;
  /** Live-region row of the composer card, for the terminal caret. */
  readonly composerTop?: number;
}

function firstEnabled(modal: MenuModal, from: number, step: 1 | -1): number {
  const count = modal.rows.length;
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (((from + step * offset) % count) + count) % count;
    if (!modal.rows[index]?.disabled) return index;
  }
  return from;
}

export function MenuModalView({ modal, ui, view }: ModalProps & { readonly modal: MenuModal }): ReactElement {
  const [selected, setSelected] = useState(modal.initialIndex);
  // Every key restarts the unattended-selection timer.
  const [activity, setActivity] = useState(0);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    if (!modal.idle) return undefined;
    const timer = setTimeout(() => modal.resolve(modal.idle?.index), modal.idle.timeoutMs);
    return () => clearTimeout(timer);
  }, [modal, activity]);

  useInput((input, key) => {
    setActivity((value) => value + 1);
    const count = modal.rows.length;
    if (key.upArrow || (key.ctrl && input === "p") || input === "k")
      setSelected((index) => firstEnabled(modal, index, -1));
    else if (key.downArrow || (key.ctrl && input === "n") || input === "j" || key.tab)
      setSelected((index) => firstEnabled(modal, index, 1));
    else if (key.escape || (key.ctrl && input === "c")) modal.resolve(undefined);
    else if (key.return) {
      if (Date.now() - openedAt.current < OPENING_GRACE_MS) return;
      if (modal.variant === "approval" && (view.rows ?? Infinity) < MINIMUM_APPROVAL_ROWS) return;
      if (modal.rows[selected]?.disabled || count === 0) return;
      modal.resolve(selected);
    }
  });

  const rendered = useMemo(() => renderMenuModal(modal, selected, ui, view), [modal, selected, ui, view]);
  return <Text>{rendered}</Text>;
}

/** The dialog card as printed text; its height does not depend on the selected row. */
export function renderMenuModal(modal: MenuModal, selectedIndex: number, ui: UIState, view: RenderViewOptions): string {
  const common = { id: modal.id, title: modal.title, rows: modal.rows, selectedIndex, hint: modal.hint };
  const overlay: UIOverlayState =
    modal.variant === "approval" && modal.request
      ? { ...common, kind: "approval", request: modal.request }
      : modal.variant === "plan-review" && modal.proposal
        ? { ...common, kind: "plan-review", proposal: modal.proposal }
        : { ...common, kind: "picker" };
  return renderOverlayRegion(overlay, ui, view);
}

/** Fixed heights of the text-only dialogs, used to size the rest of the live region. */
export const SECRET_MODAL_ROWS = 3;

export function SecretModalView({ modal, width, color }: ModalProps & { readonly modal: SecretModal }): ReactElement {
  const [length, setLength] = useState(0);
  const value = useRef("");
  const append = (text: string): void => {
    value.current = (value.current + sanitizeTerminalText(text, { allowSgr: false }).replace(/\s+/gu, "")).slice(
      0,
      MAX_SECRET_CHARS,
    );
    setLength(value.current.length);
  };
  usePaste(append);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) return modal.resolve(undefined);
    if (key.return) return modal.resolve(value.current);
    if (key.backspace || key.delete) {
      value.current = Array.from(value.current).slice(0, -1).join("");
      return setLength(value.current.length);
    }
    if (key.ctrl && input === "u") {
      value.current = "";
      return setLength(0);
    }
    if (input && !key.ctrl && !key.meta) append(input);
  });
  const mask = "•".repeat(Math.min(length, 32));
  return (
    <Box width={width} flexDirection="column">
      <Text>{color ? chalk.cyan.bold(modal.prompt) : modal.prompt}</Text>
      <Text>
        {"› "}
        {mask}
        {length > 32 ? chalk.gray(` (${length} characters)`) : ""}
      </Text>
      <Text>{chalk.gray("Input is hidden. Enter to confirm, Esc to cancel.")}</Text>
    </Box>
  );
}

export function TextModalView({
  modal,
  width,
  color,
  composerRows,
  composerTop,
}: ModalProps & { readonly modal: TextModal }): ReactElement {
  return (
    <Box width={width} flexDirection="column">
      <Text>{color ? chalk.cyan.bold(modal.prompt) : modal.prompt}</Text>
      <Composer
        width={width}
        color={color}
        placeholder="Describe how the plan should change…"
        {...(composerRows === undefined ? {} : { maxRows: composerRows })}
        {...(composerTop === undefined ? {} : { top: composerTop })}
        onSubmit={(submission) => {
          modal.resolve(submission.text);
          return true;
        }}
        onInterrupt={() => {
          modal.resolve(undefined);
          return "handled";
        }}
      />
      <Text>{chalk.gray("Enter to submit, Esc or Ctrl+C to cancel.")}</Text>
    </Box>
  );
}

/** What the dialog shows for one page: the answers so far, the typed text, and the highlighted row. */
export interface QuestionModalState {
  readonly page: number;
  readonly drafts: readonly QuestionDraft[];
  readonly texts: readonly string[];
  readonly selectedIndex: number;
  readonly now: number;
}

/** The question dialog card for one page, as printed text. */
export function renderQuestionModal(
  modal: QuestionModal,
  state: Readonly<QuestionModalState>,
  ui: UIState,
  view: RenderViewOptions,
): string {
  const language = view.language ?? DEFAULT_LANGUAGE;
  const question = modal.questions[state.page];
  if (!question) return "";
  const draft = state.drafts[state.page] ?? { selected: [], custom: null };
  const remaining = translate(language, "ui.askExpiresIn", { time: formatRemaining(modal.expiresAt - state.now) });
  const overlay: UIOverlayState = {
    kind: "picker",
    id: modal.id,
    title: `${questionTitle(language, modal.questions, state.page)} · ${remaining}`,
    detail: question.multiSelect
      ? `${question.question}\n${translate(language, "ui.askChooseAny")}`
      : question.question,
    rows: questionRows(language, question, draft, {
      text: state.texts[state.page] ?? "",
      focused: state.selectedIndex === question.options.length,
      // The card border and the "› " marker take six cells.
      width: Math.max(8, (view.columns ?? 80) - 6),
    }),
    selectedIndex: state.selectedIndex,
    hint: translate(language, question.multiSelect ? "ui.askHintMulti" : "ui.askHintSingle"),
  };
  return renderOverlayRegion(overlay, ui, view);
}

/** Rows the dialog may take: its tallest page. */
export function questionModalHeight(modal: QuestionModal, ui: UIState, view: RenderViewOptions): number {
  const drafts = modal.questions.map(() => ({ selected: [], custom: null }));
  const texts = modal.questions.map(() => "");
  return Math.max(
    1,
    ...modal.questions.map(
      (_question, page) =>
        renderQuestionModal(modal, { page, drafts, texts, selectedIndex: 0, now: modal.expiresAt }, ui, view).split(
          "\n",
        ).length,
    ),
  );
}

export function QuestionModalView({ modal, ui, view }: ModalProps & { readonly modal: QuestionModal }): ReactElement {
  const count = modal.questions.length;
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(0);
  const [selections, setSelections] = useState<readonly (readonly string[])[]>(() => modal.questions.map(() => []));
  const [texts, setTexts] = useState<readonly string[]>(() => modal.questions.map(() => ""));
  const [now, setNow] = useState(Date.now());
  const openedAt = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const question = modal.questions[page];
  const drafts = useMemo(() => questionDrafts(modal.questions, selections, texts), [modal, selections, texts]);
  // The last row is the field for the user's own answer; keys typed there are text.
  const typing = Boolean(question) && selected === question!.options.length;
  const at = <T,>(values: readonly T[], value: T): T[] => values.map((item, index) => (index === page ? value : item));
  const turnTo = (next: number): void => {
    setPage(next);
    setSelected(0);
  };
  /** Submit when every question has an answer; otherwise go to the first open one. */
  const advance = (next: readonly QuestionDraft[]): void => {
    const open = firstUnanswered(modal.questions, next);
    if (open < 0) modal.resolve({ action: "submit", drafts: next });
    else turnTo(open);
  };
  const type = (text: string): void => {
    const clean = text.replace(/[\r\n\t]+/gu, " ");
    if (!clean) return;
    setTexts((current) =>
      at(
        current,
        Array.from((current[page] ?? "") + clean)
          .slice(0, USER_ANSWER_MAX_CHARS)
          .join(""),
      ),
    );
    // For a single choice, the user's own answer replaces a chosen option.
    if (!question?.multiSelect && clean.trim()) setSelections((current) => at(current, []));
  };

  usePaste(
    (text) => {
      if (typing) type(text);
    },
    { isActive: typing },
  );
  useInput((input, key) => {
    if (!question) return;
    const rows = question.options.length + 1;
    if (key.upArrow || (key.ctrl && input === "p") || (!typing && input === "k"))
      setSelected((index) => (index - 1 + rows) % rows);
    else if (key.downArrow || (key.ctrl && input === "n") || (!typing && input === "j") || key.tab)
      setSelected((index) => (index + 1) % rows);
    else if (key.leftArrow && count > 1) turnTo((page - 1 + count) % count);
    else if (key.rightArrow && count > 1) turnTo((page + 1) % count);
    else if (key.ctrl && input === "c") modal.resolve({ action: "skip" });
    else if (key.escape) {
      // Esc first clears what was typed, so a stray press does not end the request.
      if (typing && texts[page]) setTexts((current) => at(current, ""));
      else modal.resolve({ action: "skip" });
    } else if (key.return) {
      if (Date.now() - openedAt.current < OPENING_GRACE_MS) return;
      const option = question.options[selected];
      if (option && !question.multiSelect) {
        const nextSelections = at(selections, [option.label]);
        const nextTexts = at(texts, "");
        setSelections(nextSelections);
        setTexts(nextTexts);
        return advance(questionDrafts(modal.questions, nextSelections, nextTexts));
      }
      if (draftAnswered(question, drafts[page] ?? { selected: [], custom: null })) advance(drafts);
    } else if (typing) {
      if (key.backspace || key.delete)
        setTexts((current) =>
          at(
            current,
            Array.from(current[page] ?? "")
              .slice(0, -1)
              .join(""),
          ),
        );
      else if (key.ctrl && input === "u") setTexts((current) => at(current, ""));
      else if (input && !key.ctrl && !key.meta) type(input);
    } else if (input === " " && question.multiSelect) {
      const option = question.options[selected];
      if (option)
        setSelections((current) =>
          at(current, chooseOption(question, { selected: current[page] ?? [], custom: null }, option.label).selected),
        );
    }
  });

  const rendered = useMemo(
    () => renderQuestionModal(modal, { page, drafts, texts, selectedIndex: selected, now }, ui, view),
    [modal, page, drafts, texts, selected, now, ui, view],
  );
  return <Text>{rendered}</Text>;
}
