import chalk from "chalk";
import { Box, Text, useBoxMetrics, useCursor, useInput, usePaste, type DOMElement } from "ink";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import type { SlashSuggestion } from "../../cli/slash-suggestions.js";
import type { ImageAttachment } from "../../core/types.js";
import type { Language } from "../../i18n/language.js";
import type { UserSubmission } from "../interaction-port.js";
import { displayWidth, sanitizeTerminalText, truncateToWidth } from "../render/layout.js";
import {
  EMPTY_EDITOR,
  atVerticalEdge,
  cursorColumn,
  deleteBackward,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  insertText,
  layoutRows,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveVertical,
  moveWordLeft,
  moveWordRight,
  rowIndexOfCursor,
  type EditorHistory,
  type EditorState,
} from "./composer-editor.js";

const MAX_PASTE_CHARS = 256 * 1024;
/** Pastes taller than this collapse to a one-line marker; the full text is sent on submit. */
const COLLAPSE_PASTE_LINES = 6;
const MAX_VISIBLE_ROWS = 8;
/** Most suggestion rows shown at once; the menu scrolls to keep the selection visible. */
const MAX_MENU_ROWS = 8;
const MAX_MENU_LABEL_COLUMNS = 28;
/** A second Esc within this window clears the draft. */
const CLEAR_CONFIRM_MS = 2_000;

export interface ComposerProps {
  readonly width: number;
  readonly placeholder: string;
  readonly history?: EditorHistory;
  /** Slash-command menu entries for the draft; empty when the draft is not a command. */
  readonly suggest?: (text: string, cursor: number) => readonly SlashSuggestion[];
  /** Rows free below the first draft row, shared by further draft rows and the menu. */
  readonly menuSpace?: number;
  /** Rows the suggestion menu occupies below the card (0 when closed). */
  readonly onMenuRowsChange?: (rows: number) => void;
  readonly disabled?: boolean;
  readonly color: boolean;
  /** Language of the hints shown in the box border. */
  readonly language?: Language;
  /** Prompt label shown in the box border, when any. */
  readonly title?: string;
  /** Most draft rows shown at once; taller drafts scroll inside the card. */
  readonly maxRows?: number;
  readonly clipboard?: {
    readonly initialImageCount: number;
    readonly captureImage: (index: number, signal?: AbortSignal) => Promise<ImageAttachment>;
    readonly captureText?: ((signal?: AbortSignal) => Promise<string | undefined>) | undefined;
  };
  /** Return false to keep the draft (for example, steering admission is closed). */
  readonly onSubmit: (submission: UserSubmission) => boolean;
  /** Images dropped from the draft before submit (marker deleted or draft cleared). */
  readonly onDiscardImages?: (images: readonly ImageAttachment[]) => void;
  /** Ctrl+C: return "clear" to empty the draft, otherwise the handler already acted. */
  readonly onInterrupt: (draftEmpty: boolean) => "clear" | "handled";
  /** Ctrl+D on an empty draft. */
  readonly onEndOfInput?: () => void;
  /** Row of the card's top border within Ink's live region, for placing the terminal caret. */
  readonly top?: number;
  /** Called once on mount for keys typed before the editor existed. */
  readonly takeInitialInput?: () => string;
  /** Ctrl+T. */
  readonly onShowThinking?: () => void;
  /** Holder that outlives this component, so a redraw (resize, clear) keeps the draft. */
  readonly draft?: ComposerDraft;
}

/** Mutable draft state owned by the caller; the composer reads it on mount and keeps it current. */
export interface ComposerDraft {
  editor?: EditorState;
  attachments?: DraftAttachments;
}

export interface DraftAttachments {
  images: ImageAttachment[];
  pastes: Map<string, string>;
  errors: string[];
  imageCounter: number;
  pasteCounter: number;
  pendingCaptures: number;
  submitWhenIdle: boolean;
}

interface MenuState {
  /** Draft the selection and dismissal apply to; any edit resets both. */
  readonly text: string;
  readonly index: number;
  readonly dismissed: boolean;
}

const CLOSED_MENU: MenuState = { text: "", index: 0, dismissed: false };

function menuFor(state: MenuState, text: string): MenuState {
  return state.text === text ? state : { text, index: 0, dismissed: false };
}

/** The card's top border, with an optional label set into it: `╭─ History 1/3 ───╮`. */
function topBorder(width: number, label: string | undefined, color: boolean): string {
  const inner = Math.max(0, width - 2);
  const title = label ? truncateToWidth(` ${label} `, Math.max(0, inner - 1)) : "";
  const fill = "─".repeat(Math.max(0, inner - (title ? 1 : 0) - displayWidth(title)));
  if (!color) return `╭${title ? "─" : ""}${title}${fill}╮`;
  return `${chalk.cyan(`╭${title ? "─" : ""}`)}${chalk.gray(title)}${chalk.cyan(`${fill}╮`)}`;
}

function padToWidth(value: string, columns: number): string {
  const clipped = truncateToWidth(value, columns);
  return clipped + " ".repeat(Math.max(0, columns - displayWidth(clipped)));
}

function newAttachments(initialImageCount: number): DraftAttachments {
  return {
    images: [],
    pastes: new Map(),
    errors: [],
    imageCounter: initialImageCount,
    pasteCounter: 0,
    pendingCaptures: 0,
    submitWhenIdle: false,
  };
}

function normalizePaste(value: string): string {
  return sanitizeTerminalText(value.replace(/\r\n?|\u2028|\u2029/gu, "\n"), { allowSgr: false });
}

/**
 * Replace the first `marker` in the draft, keeping the caret where it was
 * relative to surrounding text. Returns undefined when the user already deleted it.
 */
function replaceMarker(state: EditorState, marker: string, replacement: string): EditorState | undefined {
  const start = state.text.indexOf(marker);
  if (start === -1) return undefined;
  const end = start + marker.length;
  const text = state.text.slice(0, start) + replacement + state.text.slice(end);
  const delta = replacement.length - marker.length;
  const cursor =
    state.cursor >= end ? state.cursor + delta : state.cursor > start ? start + replacement.length : state.cursor;
  return { text, cursor };
}

export function Composer(props: ComposerProps): ReactElement {
  const { width, color, disabled = false } = props;
  const maxVisible = Math.max(1, Math.floor(props.maxRows ?? MAX_VISIBLE_ROWS));
  const holder = props.draft;
  const [editor, setEditorState] = useState<EditorState>(holder?.editor ?? EMPTY_EDITOR);
  const editorRef = useRef<EditorState>(holder?.editor ?? EMPTY_EDITOR);
  const attachments = useRef<DraftAttachments>(
    holder?.attachments ?? newAttachments(props.clipboard?.initialImageCount ?? 0),
  );
  if (holder) holder.attachments = attachments.current;
  const captureQueue = useRef<Promise<void>>(Promise.resolve());
  const goalColumn = useRef<number | undefined>(undefined);
  const abort = useRef(new AbortController());
  const boxRef = useRef<DOMElement | null>(null);
  const metrics = useBoxMetrics(boxRef);
  const { setCursorPosition } = useCursor();
  const [clearArmed, setClearArmed] = useState(false);
  const clearArmedRef = useRef(false);
  const clearTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const armClear = useCallback((armed: boolean): void => {
    clearTimeout(clearTimer.current);
    clearTimer.current = undefined;
    if (clearArmedRef.current === armed) return;
    clearArmedRef.current = armed;
    setClearArmed(armed);
  }, []);
  useEffect(() => () => clearTimeout(clearTimer.current), []);
  const [menuState, setMenuState] = useState<MenuState>(CLOSED_MENU);
  const menuRef = useRef<MenuState>(CLOSED_MENU);
  const setMenu = useCallback((next: MenuState): void => {
    menuRef.current = next;
    setMenuState(next);
  }, []);

  // Border (2) + padding (2) + the "› " gutter (2).
  const textWidth = Math.max(1, width - 6);

  const setEditor = useCallback(
    (next: EditorState, keepGoalColumn = false): void => {
      editorRef.current = next;
      if (holder) holder.editor = next;
      if (!keepGoalColumn) goalColumn.current = undefined;
      setEditorState(next);
    },
    [holder],
  );

  useEffect(() => {
    const controller = abort.current;
    return () => controller.abort();
  }, []);

  const submit = useCallback((): void => {
    const state = attachments.current;
    if (state.pendingCaptures > 0) {
      state.submitWhenIdle = true;
      return;
    }
    const draft = editorRef.current;
    let text = draft.text;
    for (const [marker, payload] of state.pastes) text = text.replace(marker, () => payload);
    const referenced = state.images.filter((image) => draft.text.includes(`[${image.label}]`));
    const hasContent = text.trim().length > 0 || referenced.length > 0 || state.errors.length > 0;
    if (!hasContent) return;
    const accepted = props.onSubmit({ text, images: referenced, pasteErrors: [...state.errors] });
    if (!accepted) return;
    const dropped = state.images.filter((image) => !referenced.includes(image));
    if (dropped.length > 0) props.onDiscardImages?.(dropped);
    props.history?.record(draft.text);
    attachments.current = newAttachments(state.imageCounter);
    if (holder) holder.attachments = attachments.current;
    setEditor(EMPTY_EDITOR);
  }, [props, setEditor]);

  const clearDraft = useCallback((): void => {
    const state = attachments.current;
    if (state.images.length > 0) props.onDiscardImages?.(state.images);
    attachments.current = newAttachments(state.imageCounter);
    if (holder) holder.attachments = attachments.current;
    setEditor(EMPTY_EDITOR);
  }, [props, setEditor]);

  const insertPaste = useCallback(
    (raw: string): void => {
      if (raw.length > MAX_PASTE_CHARS * 4) {
        attachments.current.errors.push("Pasted text exceeds the 256 KiB input limit.");
        return;
      }
      const text = normalizePaste(raw);
      if (text.length > MAX_PASTE_CHARS) {
        attachments.current.errors.push("Pasted text exceeds the 256 KiB input limit.");
        return;
      }
      const lines = text.split("\n").length;
      if (lines <= COLLAPSE_PASTE_LINES) {
        setEditor(insertText(editorRef.current, text));
        return;
      }
      attachments.current.pasteCounter += 1;
      const nonce = Math.random().toString(36).slice(2, 8);
      const marker = ` [Pasted text #${attachments.current.pasteCounter} · ${lines} lines ${nonce}] `;
      attachments.current.pastes.set(marker, text);
      setEditor(insertText(editorRef.current, marker));
    },
    [setEditor],
  );

  // Keys typed before this editor opened: the text up to the first Enter is
  // submitted at once; without an Enter it becomes the draft.
  const takeInitialInput = props.takeInitialInput;
  useEffect(() => {
    // "\r" is an Enter key; "\n" only occurs inside pasted text.
    const pending = takeInitialInput?.();
    if (!pending) return;
    const enter = pending.indexOf("\r");
    const draft = enter === -1 ? pending : pending.slice(0, enter);
    if (draft.includes("\n")) insertPaste(draft);
    else setEditor(insertText(editorRef.current, draft));
    if (enter !== -1) submit();
  }, [takeInitialInput, setEditor, submit, insertPaste]);

  const pasteFromClipboard = useCallback((): void => {
    const clipboard = props.clipboard;
    if (!clipboard) return;
    const state = attachments.current;
    state.pasteCounter += 1;
    const marker = ` [Pasting clipboard #${state.pasteCounter}…] `;
    setEditor(insertText(editorRef.current, marker));
    state.pendingCaptures += 1;
    const signal = abort.current.signal;
    captureQueue.current = captureQueue.current
      .catch(() => undefined)
      .then(async () => {
        let replacement: string;
        try {
          const index = state.imageCounter + 1;
          const attachment = await clipboard.captureImage(index, signal);
          if (signal.aborted) return;
          state.imageCounter = index;
          state.images.push(attachment);
          replacement = ` [${attachment.label}] `;
        } catch (error) {
          let failure: unknown = error;
          replacement = " [Image paste failed] ";
          if (clipboard.captureText && !signal.aborted) {
            const text = await clipboard.captureText(signal).catch(() => undefined);
            if (text) {
              replacement = normalizePaste(text);
              failure = undefined;
            }
          }
          if (failure !== undefined) state.errors.push(failure instanceof Error ? failure.message : String(failure));
        }
        const next = replaceMarker(editorRef.current, marker, replacement);
        if (next) setEditor(next, true);
      })
      .finally(() => {
        state.pendingCaptures = Math.max(0, state.pendingCaptures - 1);
        if (state.pendingCaptures === 0 && state.submitWhenIdle && !signal.aborted) {
          state.submitWhenIdle = false;
          submit();
        }
      });
  }, [props.clipboard, setEditor, submit]);

  usePaste((text) => insertPaste(text), { isActive: !disabled });

  useInput(
    (input, key) => {
      const current = editorRef.current;
      const edit = (next: EditorState): void => {
        if (next !== current) {
          props.history?.detach();
          setEditor(next);
        }
      };

      // Any key other than Esc cancels a pending "press Esc again to clear".
      if (!key.escape) armClear(false);
      if ((key.ctrl || key.super) && input.toLowerCase() === "v") return pasteFromClipboard();
      if (key.ctrl) {
        switch (input) {
          case "c":
            if (props.onInterrupt(current.text.length === 0 && attachments.current.images.length === 0) === "clear")
              clearDraft();
            return;
          case "d":
            if (current.text.length === 0) props.onEndOfInput?.();
            else edit(deleteForward(current));
            return;
          case "a":
            return setEditor(moveLineStart(current));
          case "e":
            return setEditor(moveLineEnd(current));
          case "b":
            return setEditor(moveLeft(current));
          case "f":
            return setEditor(moveRight(current));
          case "w":
            return edit(deleteWordBackward(current));
          case "k":
            return edit(deleteToLineEnd(current));
          case "u":
            return edit(deleteToLineStart(current));
          case "j":
            return edit(insertText(current, "\n"));
          case "t":
            return props.onShowThinking?.();
          default:
            return;
        }
      }
      // A recalled history entry is browsed with ↑/↓, never re-opened as a command menu.
      const suggestions = props.history?.browsing ? [] : (props.suggest?.(current.text, current.cursor) ?? []);
      const menu = menuFor(menuRef.current, current.text);
      if (suggestions.length > 0 && !menu.dismissed) {
        if (key.upArrow || key.downArrow) {
          const step = key.upArrow ? -1 : 1;
          setMenu({ ...menu, index: (menu.index + step + suggestions.length) % suggestions.length });
          return;
        }
        if (key.escape) {
          setMenu({ ...menu, dismissed: true });
          return;
        }
        if (key.tab || (key.return && !key.shift && !key.meta)) {
          const chosen = suggestions[Math.min(menu.index, suggestions.length - 1)]!;
          edit({ text: chosen.replacement, cursor: chosen.cursor ?? chosen.replacement.length });
          if (key.return && chosen.submit) submit();
          return;
        }
      }
      if (key.return) {
        if (key.shift || key.meta) return edit(insertText(current, "\n"));
        // A trailing backslash continues the line, like a shell.
        if (current.cursor === current.text.length && current.text.endsWith("\\")) {
          return edit({ text: `${current.text.slice(0, -1)}\n`, cursor: current.text.length });
        }
        return submit();
      }
      if (input === "\n") return edit(insertText(current, "\n"));
      if (key.escape) {
        if (current.text.length === 0 && attachments.current.images.length === 0) return;
        // One stray Esc must not throw away a long draft; a second one confirms.
        if (clearArmedRef.current) {
          armClear(false);
          clearDraft();
          return;
        }
        armClear(true);
        clearTimer.current = setTimeout(() => armClear(false), CLEAR_CONFIRM_MS);
        return;
      }
      if (key.tab) return;
      if (key.backspace) return edit(deleteBackward(current));
      if (key.delete) return edit(deleteForward(current));
      if (key.leftArrow) return setEditor(key.meta || key.ctrl ? moveWordLeft(current) : moveLeft(current));
      if (key.rightArrow) return setEditor(key.meta || key.ctrl ? moveWordRight(current) : moveRight(current));
      if (key.home) return setEditor(moveLineStart(current));
      if (key.end) return setEditor(moveLineEnd(current));
      if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? -1 : 1;
        const rows = layoutRows(current.text, textWidth);
        goalColumn.current ??= cursorColumn(current.text, rows, current.cursor);
        const moved = moveVertical(current, textWidth, direction, goalColumn.current);
        if (moved) return setEditor(moved, true);
        if (props.history && atVerticalEdge(current, textWidth, direction)) {
          const recalled = direction === -1 ? props.history.previous(current.text) : props.history.next();
          if (recalled !== undefined) setEditor({ text: recalled, cursor: recalled.length });
        }
        return;
      }
      if (key.pageUp || key.pageDown || key.meta) return;
      if (!input) return;
      // Text and Enter can arrive in one chunk (fast typing, IME commit, ConPTY batching).
      // A single trailing Enter still submits; several line breaks are an unbracketed paste.
      const body = input.endsWith("\r") ? input.slice(0, -1) : input;
      if (body !== input && !/[\r\n]/u.test(body)) {
        setEditor(insertText(current, body));
        return submit();
      }
      edit(insertText(current, input.replace(/\r\n?/gu, "\n")));
    },
    { isActive: !disabled },
  );

  const rows = layoutRows(editor.text, textWidth);
  const cursorRow = rowIndexOfCursor(rows, editor.cursor);
  const showPlaceholder = editor.text.length === 0;
  const images = attachments.current.images;
  const lines = showPlaceholder
    ? [chalk.gray(props.placeholder)]
    : rows.map((row) => editor.text.slice(row.start, row.end));
  const badges = images.length > 0 ? ` ${images.map((image) => `[${image.label}]`).join(" ")}` : "";
  // A tall draft scrolls inside the card so the live region never outgrows the terminal.
  const first = showPlaceholder ? 0 : Math.max(0, Math.min(cursorRow - maxVisible + 1, lines.length - maxVisible));
  const visible = lines.slice(first, first + maxVisible);

  const browsing = props.history?.browsing;
  const suggestions = disabled || browsing ? [] : (props.suggest?.(editor.text, editor.cursor) ?? []);
  const menu = menuFor(menuState, editor.text);
  const menuCapacity = Math.max(
    0,
    Math.min(MAX_MENU_ROWS, Math.floor(props.menuSpace ?? MAX_MENU_ROWS) - (visible.length - 1)),
  );
  const menuCount = menu.dismissed ? 0 : Math.min(suggestions.length, menuCapacity);
  const selected = Math.min(menu.index, Math.max(0, suggestions.length - 1));
  const menuFirst = Math.min(Math.max(0, selected - menuCount + 1), Math.max(0, suggestions.length - menuCount));
  const menuItems = suggestions.slice(menuFirst, menuFirst + menuCount);
  // Labels share the row with descriptions; file paths have none and may use all of it.
  const labelLimit = menuItems.some((item) => item.description) ? MAX_MENU_LABEL_COLUMNS : Math.max(8, width - 6);
  const labelColumns = Math.min(labelLimit, Math.max(0, ...menuItems.map((item) => displayWidth(item.label))));
  const onMenuRowsChange = props.onMenuRowsChange;
  useEffect(() => onMenuRowsChange?.(menuCount), [onMenuRowsChange, menuCount]);
  useEffect(() => () => onMenuRowsChange?.(0), [onMenuRowsChange]);

  // The terminal's own caret sits on the edit position so IME composition and
  // candidate windows follow it. Ink applies the position with the frame being
  // rendered, so it must be set during render: from an effect it would trail the
  // text by one frame (an IME commit of several characters left it behind).
  const top = props.top ?? (metrics.hasMeasured ? metrics.top : undefined);
  const caretX = 2 + 2 + (showPlaceholder ? 0 : cursorColumn(editor.text, rows, editor.cursor));
  const caretY = (top ?? 0) + 1 + (showPlaceholder ? 0 : cursorRow - first);
  setCursorPosition(disabled || top === undefined ? undefined : { x: Math.min(caretX, width - 3), y: caretY });

  const zh = props.language === "zh_cn";
  const borderLabel = clearArmed
    ? zh
      ? "再按一次 Esc 清空"
      : "Press Esc again to clear"
    : browsing
      ? `${zh ? "历史" : "History"} ${browsing.index}/${browsing.total}`
      : props.title;

  return (
    <Box flexDirection="column" width={width}>
      <Box ref={boxRef} flexDirection="column" width={width}>
        <Text wrap="truncate-end">{topBorder(width, borderLabel, color)}</Text>
        <Box width={width} borderStyle="round" borderTop={false} borderColor={color ? "cyan" : undefined} paddingX={1}>
          <Box flexDirection="column" width={Math.max(1, width - 4)}>
            {visible.map((line, index) => (
              <Text key={first + index} wrap="truncate-end">
                {first + index === 0 ? `${color ? chalk.cyan.bold("›") : "›"} ` : "  "}
                {line}
                {first + index === lines.length - 1 && badges ? chalk.gray(badges) : ""}
              </Text>
            ))}
          </Box>
        </Box>
      </Box>
      {menuItems.map((item, index) => {
        const active = menuFirst + index === selected;
        const label = padToWidth(item.label, labelColumns);
        const description = item.description ? `  ${color ? chalk.gray(item.description) : item.description}` : "";
        return (
          <Text key={item.replacement} wrap="truncate-end">
            {active ? `  ${color ? chalk.cyan.bold(`› ${label}`) : `› ${label}`}` : `    ${label}`}
            {description}
          </Text>
        );
      })}
    </Box>
  );
}
