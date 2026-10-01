import chalk from "chalk";
import { Box, Text, useInput, usePaste } from "ink";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { UIOverlayState } from "../contracts.js";
import { sanitizeTerminalText } from "../render/layout.js";
import { renderLiveRegion, type RenderViewOptions } from "../render/view.js";
import type { UIState } from "../contracts.js";
import { Composer } from "./composer.js";
import type { MenuModal, SecretModal, TextModal } from "./ink-store.js";

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
  return renderLiveRegion({ ...ui, overlay }, Date.now(), view);
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
