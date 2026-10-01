import chalk from "chalk";
import { Box, Static, Text, render, useInput, useWindowSize } from "ink";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";

import type { UIState, UITranscriptEntry } from "../contracts.js";
import { truncateToWidth, wrapToWidth } from "../render/layout.js";
import {
  renderComposerStatusRegion,
  renderFixedBottomRegions,
  renderLiveActivityRegion,
  renderSessionHeader,
  type RenderViewOptions,
} from "../render/view.js";
import { Composer } from "./composer.js";
import { clipTail, transcriptEntryText } from "./entry-text.js";
import type { InkActions } from "./ink-actions.js";
import type { InkSnapshot } from "./ink-store.js";
import { MenuModalView, SECRET_MODAL_ROWS, SecretModalView, TextModalView, renderMenuModal } from "./modal.js";

const TICK_MS = 160;
const MIN_COLUMNS = 12;
/** Draft rows shown before a long draft starts scrolling inside the composer. */
const MAX_COMPOSER_ROWS = 8;
/** Composer border rows. */
const COMPOSER_FRAME_ROWS = 2;
/** Text dialog: prompt + composer frame + hint. */
const TEXT_MODAL_CHROME_ROWS = 4;
/** A second Ctrl+C within this window ends the session from an empty editor. */
const EXIT_CONFIRM_MS = 2_000;
const CONVERSATION_KINDS = new Set<UITranscriptEntry["kind"]>(["user", "assistant", "tool"]);
/** Transcript ids of session headers, re-rendered for the current width whenever they are printed. */
export const SESSION_HEADER_ID_PREFIX = "session_header_";

export interface MountedInkApp {
  /** Erase the live region and unmount, so nothing of the editor lingers in scrollback. */
  unmount(): void;
  /** The session header as printed text, sized for the current terminal. */
  renderHeader(ui: Readonly<UIState>): string;
}

function lineCount(text: string): number {
  return text ? text.split("\n").length : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

/**
 * One transcript row wrapped to the current width, so the row count Ink prints
 * is exactly the count used for the live-region budget. Conversation rows keep
 * continuation lines indented under their gutter.
 */
function entryDisplay(entry: Readonly<UITranscriptEntry>, ui: UIState, view: RenderViewOptions): string {
  const width = view.columns ?? 80;
  if (entry.id?.startsWith(SESSION_HEADER_ID_PREFIX)) return `\n${renderSessionHeader(ui, view)}\n`;
  const text = transcriptEntryText(entry);
  // Thinking previews are a teaser: cut them at the edge instead of wrapping mid-word.
  if (entry.id?.startsWith("thinking_")) {
    return text
      .split("\n")
      .map((line) => truncateToWidth(line, width, { preserveAnsi: true }))
      .join("\n");
  }
  return wrapToWidth(text, width, { preserveAnsi: true, hangingIndent: CONVERSATION_KINDS.has(entry.kind) }).join("\n");
}

/** Persistent rows below the composer, compacted when they would crowd out the conversation. */
function statusRegion(ui: UIState, view: RenderViewOptions, now: number, budget: number): string {
  const full = renderComposerStatusRegion(ui, view, now);
  const limit = Math.max(1, Math.floor(budget / 3));
  if (lineCount(full) <= limit) return full;
  return renderFixedBottomRegions(ui, view, now, { totalRows: limit }).lines.join("\n");
}

function InkApp({ actions }: { readonly actions: InkActions }): ReactElement {
  const snapshot = useSyncExternalStore(actions.store.subscribe, actions.store.getSnapshot);
  const { columns, rows } = useWindowSize();
  const width = Math.max(MIN_COLUMNS, columns - 1);
  const color = actions.colorEnabled();
  const { ui, prompt, busy, modal } = snapshot;

  // Raw mode must stay on for the whole session so keys never echo into the display.
  // Ctrl+C is forwarded only when no editor or dialog is already handling it.
  const steering = Boolean(busy?.options.onSteer) && !busy?.paused;
  // Keys typed while no editor is open (startup, a busy request without steering)
  // are kept and handed to the next prompt instead of being dropped.
  useInput((input, key) => {
    if (prompt || steering || modal) return;
    if (key.ctrl && input === "c") actions.interrupt();
    else if (key.return) actions.bufferTypeAhead("\r");
    else if (key.backspace) actions.bufferTypeAhead("\b");
    else if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) actions.bufferTypeAhead(input);
  });

  const animated = Boolean(ui.live.activity || ui.live.review || ui.live.subagents.length > 0 || ui.live.tasks);
  const now = useNow(animated);
  const view: RenderViewOptions = {
    language: snapshot.language,
    columns: width,
    rows,
    color,
    ...(snapshot.agentConcurrencyLimit === undefined ? {} : { agentConcurrencyLimit: snapshot.agentConcurrencyLimit }),
  };

  // Ink repaints the whole terminal, scrollback included, once the live region
  // reaches the window height. Every frame therefore stays at least two rows
  // shorter, and the streaming preview only gets the rows that remain.
  const budget = Math.max(4, rows - 2);
  const modalView: RenderViewOptions = { ...view, rows: budget };
  let activity = "";
  let status = "";
  let composerRows = MAX_COMPOSER_ROWS;
  let reserved: number;
  if (modal?.kind === "menu") {
    reserved = lineCount(renderMenuModal(modal, modal.initialIndex, ui, modalView));
  } else if (modal?.kind === "secret") {
    reserved = SECRET_MODAL_ROWS;
  } else if (modal?.kind === "text") {
    composerRows = clamp(budget - TEXT_MODAL_CHROME_ROWS, 1, MAX_COMPOSER_ROWS);
    reserved = composerRows + TEXT_MODAL_CHROME_ROWS;
  } else {
    activity = renderLiveActivityRegion(ui, now, view);
    status = statusRegion(ui, view, now, budget);
    const fixed = lineCount(activity) + lineCount(status);
    const composerShown = Boolean(prompt || busy);
    composerRows = clamp(budget - fixed - COMPOSER_FRAME_ROWS, 1, MAX_COMPOSER_ROWS);
    reserved = fixed + (composerShown ? composerRows + COMPOSER_FRAME_ROWS : 0);
  }
  const previewRows = budget - reserved;

  const settled = ui.transcript.slice(0, snapshot.settled);
  const preview = ui.transcript
    .slice(snapshot.settled)
    .map((entry) => entryDisplay(entry, ui, view))
    .join("\n")
    .replace(/^\n+/u, "");

  return (
    <>
      <Static key={snapshot.epoch} items={settled}>
        {(entry, index) => (
          <Box key={index} width={width}>
            <Text>{entryDisplay(entry, ui, view)}</Text>
          </Box>
        )}
      </Static>
      {snapshot.closing ? null : (
        <Box flexDirection="column" width={width}>
          {preview && previewRows > 0 ? (
            <Text>{clipTail(preview, previewRows, (hidden) => chalk.gray(`  … ${hidden} more rows above`))}</Text>
          ) : null}
          {modal?.kind === "menu" ? (
            <MenuModalView modal={modal} ui={ui} view={modalView} width={width} color={color} />
          ) : null}
          {modal?.kind === "secret" ? (
            <SecretModalView modal={modal} ui={ui} view={view} width={width} color={color} />
          ) : null}
          {modal?.kind === "text" ? (
            <TextModalView modal={modal} ui={ui} view={view} width={width} color={color} composerRows={composerRows} />
          ) : null}
          {modal ? null : (
            <>
              {activity ? <Text>{activity}</Text> : null}
              {prompt || busy ? (
                <ComposerSlot
                  snapshot={snapshot}
                  actions={actions}
                  width={width}
                  color={color}
                  maxRows={composerRows}
                />
              ) : null}
              {status ? <Text>{status}</Text> : null}
            </>
          )}
        </Box>
      )}
    </>
  );
}

function ComposerSlot(props: {
  readonly snapshot: InkSnapshot;
  readonly actions: InkActions;
  readonly width: number;
  readonly color: boolean;
  readonly maxRows: number;
}): ReactElement {
  const { snapshot, actions, width, color, maxRows } = props;
  const { prompt, busy, ui } = snapshot;
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(() => () => clearTimeout(exitTimer.current), []);

  if (prompt) {
    return (
      <Composer
        key="prompt"
        draft={actions.draftFor(prompt)}
        takeInitialInput={() => actions.takeTypeAhead()}
        width={width}
        color={color}
        maxRows={maxRows}
        placeholder={exitArmed ? "Press Ctrl+C again to exit" : "Type your request…"}
        history={actions.history}
        onShowThinking={() => actions.showLatestThinking()}
        slashCompletion
        clipboard={{
          initialImageCount: prompt.initialImageCount,
          captureImage: prompt.captureImage,
          captureText: prompt.captureText,
        }}
        onSubmit={(submission) => {
          actions.submitPrompt(submission);
          return true;
        }}
        onInterrupt={(empty) => {
          if (!empty) return "clear";
          if (exitArmed) {
            actions.closePrompt();
            return "handled";
          }
          // One stray Ctrl+C must not end the session; a second one confirms.
          setExitArmed(true);
          clearTimeout(exitTimer.current);
          exitTimer.current = setTimeout(() => setExitArmed(false), EXIT_CONFIRM_MS);
          return "handled";
        }}
        onEndOfInput={() => actions.closePrompt()}
      />
    );
  }
  const options = busy?.options;
  const steerable = Boolean(options?.onSteer);
  return (
    <Composer
      key={`busy-${steerable}`}
      {...(options ? { draft: actions.draftFor(options) } : {})}
      width={width}
      color={color}
      maxRows={maxRows}
      placeholder={ui.composer.placeholder}
      disabled={!steerable || busy?.paused === true}
      history={actions.history}
      onShowThinking={() => actions.showLatestThinking()}
      {...(options?.captureImage
        ? {
            clipboard: {
              initialImageCount: options.initialImageCount ?? 0,
              captureImage: options.captureImage,
              captureText: options.captureText,
            },
          }
        : {})}
      onSubmit={(submission) => actions.steer(submission)}
      {...(options?.onDiscardImages ? { onDiscardImages: (images) => void options.onDiscardImages?.(images) } : {})}
      onInterrupt={() => {
        actions.interrupt();
        return "handled";
      }}
    />
  );
}

export function mountInkApp(
  actions: InkActions,
  streams: { readonly stdin: NodeJS.ReadStream; readonly stdout: NodeJS.WriteStream },
): MountedInkApp {
  const instance = render(<InkApp actions={actions} />, {
    stdin: streams.stdin,
    stdout: streams.stdout,
    exitOnCtrlC: false,
    patchConsole: true,
    incrementalRendering: true,
    maxFps: 30,
  });
  return {
    unmount: () => {
      // The caller has already flagged the store as closing; this render erases the live
      // region, and unmount flushes it before Ink lets go of the terminal.
      instance.rerender(<InkApp actions={actions} />);
      instance.unmount();
    },
    renderHeader: (ui) =>
      renderSessionHeader(ui, {
        // The last physical cell stays empty so an exact-width row cannot autowrap.
        columns: Math.max(MIN_COLUMNS, (streams.stdout.columns || 80) - 1),
        rows: streams.stdout.rows || 24,
        color: actions.colorEnabled(),
        language: actions.store.getSnapshot().language,
      }),
  };
}
