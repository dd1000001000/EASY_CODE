import chalk from "chalk";
import {
  Box,
  Static,
  Text,
  render,
  useApp,
  useBoxMetrics,
  useInput,
  usePaste,
  useWindowSize,
  type DOMElement,
} from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";

import { MentionIndex, mentionSuggestions } from "../../cli/mention-suggestions.js";
import { slashSuggestions } from "../../cli/slash-suggestions.js";

import type { UIState, UITranscriptEntry } from "../contracts.js";
import {
  renderComposerStatusRegion,
  renderFixedBottomRegions,
  renderLiveActivityRegion,
  renderSessionHeader,
  type RenderViewOptions,
} from "../render/view.js";
import { DEFAULT_LANGUAGE } from "../../i18n/language.js";
import { renderTurnSummary } from "../render/turn-summary.js";
import { Composer } from "./composer.js";
import { entryDisplay } from "./entry-text.js";
import { AnswerBlock } from "./markdown-view.js";
import type { InkActions } from "./ink-actions.js";
import type { InkSnapshot } from "./ink-store.js";
import {
  MenuModalView,
  QuestionModalView,
  SECRET_MODAL_ROWS,
  SecretModalView,
  TextModalView,
  questionModalHeight,
  renderMenuModal,
} from "./modal.js";

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

/** One transcript entry: answers are a Markdown block laid out by Ink, everything else printed text. */
function TranscriptRow(props: {
  readonly entry: Readonly<UITranscriptEntry>;
  readonly ui: UIState;
  readonly view: RenderViewOptions;
}): ReactElement {
  const { entry, ui, view } = props;
  if (entry.turnSummary) {
    // Rendered by Ink directly: the file names carry OSC 8 links, which the transcript wrapper would strip.
    return (
      <Text>
        {renderTurnSummary(entry.turnSummary, {
          language: view.language ?? DEFAULT_LANGUAGE,
          color: view.color ?? false,
          columns: view.columns ?? 80,
          links: true,
        })}
      </Text>
    );
  }
  if (entry.kind === "assistant") {
    return (
      <AnswerBlock
        text={entry.text}
        width={view.columns ?? 80}
        color={view.color ?? false}
        spaced
        continuation={entry.continuation === true}
      />
    );
  }
  return <Text>{entryDisplay(entry, ui, view)}</Text>;
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
  const { suspendTerminal } = useApp();
  const liveRef = useRef<DOMElement | null>(null);
  const liveMetrics = useBoxMetrics(liveRef);
  const previewRef = useRef<DOMElement | null>(null);
  const previewMetrics = useBoxMetrics(previewRef);
  const previewContentRef = useRef<DOMElement | null>(null);
  const previewContent = useBoxMetrics(previewContentRef);
  const liveRows = useRef(0);
  liveRows.current = liveMetrics.height;
  // The Thinking viewer borrows the terminal and needs to know where the live region sits.
  useEffect(
    () => actions.attachTerminal({ suspend: () => suspendTerminal(), liveRows: () => liveRows.current }),
    [actions, suspendTerminal],
  );
  const { columns, rows } = useWindowSize();
  const width = Math.max(MIN_COLUMNS, columns - 1);
  const color = actions.colorEnabled();
  const { ui, prompt, busy, modal } = snapshot;
  // Rows of the slash-command menu under the composer; it takes the status bar's place while open.
  const [menuRows, setMenuRows] = useState(0);
  const menuOpen = menuRows > 0 && Boolean(prompt);

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
  // A paste keeps its line breaks as text ("\n"); only a typed Enter ("\r") submits.
  usePaste((text) => actions.bufferTypeAhead(text.replace(/\r\n?/gu, "\n")), {
    isActive: !prompt && !steering && !modal,
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
  let menuSpace = 0;
  let reserved: number;
  if (modal?.kind === "menu") {
    reserved = lineCount(renderMenuModal(modal, modal.initialIndex, ui, modalView));
  } else if (modal?.kind === "question") {
    reserved = questionModalHeight(modal, ui, modalView);
  } else if (modal?.kind === "secret") {
    reserved = SECRET_MODAL_ROWS;
  } else if (modal?.kind === "text") {
    composerRows = clamp(budget - TEXT_MODAL_CHROME_ROWS, 1, MAX_COMPOSER_ROWS);
    reserved = composerRows + TEXT_MODAL_CHROME_ROWS;
  } else {
    activity = renderLiveActivityRegion(ui, now, view);
    status = menuOpen ? "" : statusRegion(ui, view, now, budget);
    const fixed = lineCount(activity) + lineCount(status);
    const composerShown = Boolean(prompt || busy);
    composerRows = clamp(budget - fixed - (menuOpen ? menuRows : 0) - COMPOSER_FRAME_ROWS, 1, MAX_COMPOSER_ROWS);
    // Everything below the first draft row that the card and menu may still use.
    menuSpace = Math.max(0, budget - fixed - COMPOSER_FRAME_ROWS - 1);
    reserved = fixed + (composerShown ? composerRows + COMPOSER_FRAME_ROWS : 0) + (menuOpen ? menuRows : 0);
  }
  const previewRows = budget - reserved;

  const settled = ui.transcript.slice(0, snapshot.settled);
  const open = ui.transcript.slice(snapshot.settled);
  // The streaming preview keeps its newest rows: taller content is clipped at the top by Ink.
  const previewOverflows = previewMetrics.hasMeasured && open.length > 0 && previewContent.height > previewRows;
  const previewHeight = previewMetrics.hasMeasured && open.length > 0 ? previewMetrics.height : 0;
  // Rows above the composer card inside the live region; the terminal caret is placed relative to them.
  const composerTop = previewHeight + (modal?.kind === "text" ? 1 : lineCount(activity));

  return (
    <>
      <Static key={snapshot.epoch} items={settled}>
        {(entry, index) => (
          <Box key={index} width={width}>
            <TranscriptRow entry={entry} ui={ui} view={view} />
          </Box>
        )}
      </Static>
      {snapshot.closing ? null : (
        <Box ref={liveRef} flexDirection="column" width={width}>
          {open.length > 0 && previewRows > 0 ? (
            <Box ref={previewRef} flexDirection="column" width={width}>
              {previewOverflows ? (
                <Text>{chalk.gray("  … earlier rows of this block are shown when it completes")}</Text>
              ) : null}
              <Box
                flexDirection="column"
                width={width}
                maxHeight={Math.max(0, previewOverflows ? previewRows - 1 : previewRows)}
                overflowY="hidden"
                justifyContent="flex-end"
              >
                <Box ref={previewContentRef} flexDirection="column" flexShrink={0} width={width}>
                  {open.map((entry, index) => (
                    <TranscriptRow key={index} entry={entry} ui={ui} view={view} />
                  ))}
                </Box>
              </Box>
            </Box>
          ) : null}
          {modal?.kind === "menu" ? (
            <MenuModalView modal={modal} ui={ui} view={modalView} width={width} color={color} />
          ) : null}
          {modal?.kind === "question" ? (
            <QuestionModalView key={modal.id} modal={modal} ui={ui} view={modalView} width={width} color={color} />
          ) : null}
          {modal?.kind === "secret" ? (
            <SecretModalView modal={modal} ui={ui} view={view} width={width} color={color} />
          ) : null}
          {modal?.kind === "text" ? (
            <TextModalView
              modal={modal}
              ui={ui}
              view={view}
              width={width}
              color={color}
              composerRows={composerRows}
              composerTop={composerTop}
            />
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
                  menuSpace={menuSpace}
                  onMenuRowsChange={setMenuRows}
                  top={composerTop}
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
  readonly menuSpace: number;
  readonly onMenuRowsChange: (rows: number) => void;
  readonly top: number;
}): ReactElement {
  const { snapshot, actions, width, color, maxRows, menuSpace, onMenuRowsChange, top } = props;
  const { prompt, busy, ui } = snapshot;
  const language = snapshot.language;
  const provider = ui.header.session?.provider;
  const slashArguments = prompt?.slashArguments;
  const mentionPaths = prompt?.mentionPaths;
  const mentions = useMemo(() => (mentionPaths ? new MentionIndex(mentionPaths) : undefined), [mentionPaths]);
  const suggest = useCallback(
    (text: string, cursor: number) => {
      const commands = slashSuggestions(text, cursor, {
        language,
        ...(provider ? { provider } : {}),
        ...(slashArguments ? { dynamicArguments: slashArguments } : {}),
      });
      return commands.length > 0 || !mentions ? commands : mentionSuggestions(text, cursor, mentions);
    },
    [language, provider, slashArguments, mentions],
  );
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(() => () => clearTimeout(exitTimer.current), []);

  if (prompt) {
    return (
      <Composer
        key="prompt"
        language={language}
        draft={actions.draftFor(prompt)}
        takeInitialInput={() => actions.takeTypeAhead()}
        width={width}
        color={color}
        maxRows={maxRows}
        top={top}
        placeholder={exitArmed ? "Press Ctrl+C again to exit" : "Type your request…"}
        history={actions.history}
        onShowThinking={() => actions.showLatestThinking()}
        suggest={suggest}
        menuSpace={menuSpace}
        onMenuRowsChange={onMenuRowsChange}
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
      language={language}
      {...(options ? { draft: actions.draftFor(options) } : {})}
      width={width}
      color={color}
      maxRows={maxRows}
      top={top}
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
