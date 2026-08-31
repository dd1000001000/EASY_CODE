import type { PlanProposal, SubagentTaskReport } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import type { SubagentView } from "../subagents/types.js";
import type { TaskGraphView } from "../tasks/task-graph.js";
import type {
  UIActivityState,
  UIComposerPatch,
  UIComposerState,
  UIEvent,
  UIHeaderPatch,
  UIHeaderState,
  UIOverlayState,
  UIProgressItem,
  UISessionInfo,
  UIState,
  UIThinkingPanelInput,
  UIThinkingPanelState,
  UITranscriptEntry,
} from "./contracts.js";
import { sanitizeTerminalText } from "./render/layout.js";

export const MAX_TRANSCRIPT_ENTRIES = 1_000;
export const MAX_LIVE_TASKS = 32;
export const MAX_LIVE_SUBAGENTS = 64;
export const MAX_LIVE_PROGRESS_ITEMS = 64;
export const MAX_THINKING_PANEL_CHARS = 12_000;
export const MAX_THINKING_PANEL_LINES = 120;
export const MAX_THINKING_PANEL_LINE_CHARS = 1_000;
export const MAX_OVERLAY_ROWS = 100;
export const MAX_COMPOSER_IMAGES = 99;
export const DEFAULT_COMPOSER_PLACEHOLDER = "Type your request…";

export interface CreateUIStateOptions {
  readonly header?: UIHeaderPatch;
  readonly composer?: UIComposerPatch;
}

const EMPTY_HEADER: UIHeaderState = {
  title: "EASY CODE",
  session: null,
};

const EMPTY_COMPOSER: UIComposerState = {
  text: "",
  cursor: 0,
  busy: false,
  pendingSubmissions: 0,
  placeholder: DEFAULT_COMPOSER_PLACEHOLDER,
  images: [],
};

function cloneSession(session: Readonly<UISessionInfo>): UISessionInfo {
  return { ...session };
}

function mergeHeader(
  current: Readonly<UIHeaderState>,
  patch: Readonly<UIHeaderPatch>,
): UIHeaderState {
  const session = patch.session === undefined
    ? current.session
    : patch.session === null
      ? null
      : cloneSession(patch.session);
  return {
    title: patch.title ?? current.title,
    session,
  };
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function takeCodePoints(
  value: string,
  maximum: number,
): { text: string; truncated: boolean } {
  let count = 0;
  let end = 0;
  for (const character of value) {
    if (count === maximum) {
      return { text: value.slice(0, end), truncated: true };
    }
    count += 1;
    end += character.length;
  }
  return { text: value, truncated: false };
}

function boundedText(value: string, maximum: number): {
  text: string;
  truncated: boolean;
} {
  const retained = takeCodePoints(value, maximum);
  if (!retained.truncated) return retained;
  const body = takeCodePoints(value, Math.max(0, maximum - 1)).text;
  return { text: `${body}…`, truncated: true };
}

function optionalCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function thinkingPanelId(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizeThinkingPanel(
  input: Readonly<UIThinkingPanelInput>,
  id: number,
): UIThinkingPanelState {
  const source = "body" in input && typeof input.body === "string"
    ? input.body
    : "text" in input && typeof input.text === "string"
      ? input.text
      : "";
  const safe = redactSensitiveInformation(
    sanitizeTerminalText(source, { allowSgr: false }),
  )
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const lines = safe.split("\n", MAX_THINKING_PANEL_LINES + 1);
  let truncated = Boolean(input.truncated) || lines.length > MAX_THINKING_PANEL_LINES;
  const retainedLines = lines.slice(0, MAX_THINKING_PANEL_LINES).map((line) => {
    const retained = boundedText(line, MAX_THINKING_PANEL_LINE_CHARS);
    truncated ||= retained.truncated;
    return retained.text;
  });
  const retainedBody = boundedText(
    retainedLines.join("\n").trim(),
    MAX_THINKING_PANEL_CHARS,
  );
  truncated ||= retainedBody.truncated;
  const sourceChars = optionalCount(input.sourceChars);
  const sourceLines = optionalCount(input.sourceLines);
  return {
    id,
    body: retainedBody.text,
    truncated,
    ...(sourceChars === undefined ? {} : { sourceChars }),
    ...(sourceLines === undefined ? {} : { sourceLines }),
  };
}

function mergeComposer(
  current: Readonly<UIComposerState>,
  patch: Readonly<UIComposerPatch>,
): UIComposerState {
  const text = patch.text ?? current.text;
  const cursor = boundedInteger(patch.cursor ?? current.cursor, 0, text.length);
  const images = (patch.images ?? current.images)
    .slice(0, MAX_COMPOSER_IMAGES)
    .map((image) => ({ ...image }));
  return {
    text,
    cursor,
    busy: patch.busy ?? current.busy,
    pendingSubmissions: boundedInteger(
      patch.pendingSubmissions ?? current.pendingSubmissions,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    placeholder: patch.placeholder ?? current.placeholder,
    images,
  };
}

function cloneTranscriptEntry(
  entry: Readonly<UITranscriptEntry>,
): UITranscriptEntry {
  return {
    ...entry,
    ...(entry.images
      ? { images: entry.images.map((image) => ({ ...image })) }
      : {}),
    ...(entry.presentation
      ? { presentation: { ...entry.presentation } }
      : {}),
  };
}

function appendTranscript(
  transcript: readonly UITranscriptEntry[],
  entry: Readonly<UITranscriptEntry>,
): readonly UITranscriptEntry[] {
  const next = [...transcript, cloneTranscriptEntry(entry)];
  return next.length <= MAX_TRANSCRIPT_ENTRIES
    ? next
    : next.slice(next.length - MAX_TRANSCRIPT_ENTRIES);
}

function cloneActivity(activity: Readonly<UIActivityState>): UIActivityState {
  return { ...activity };
}

function cloneProgress(
  progress: readonly Readonly<UIProgressItem>[],
): readonly UIProgressItem[] {
  const start = Math.max(0, progress.length - MAX_LIVE_PROGRESS_ITEMS);
  return progress.slice(start).map((item) => ({ ...item }));
}

function cloneTaskGraph(graph: Readonly<TaskGraphView>): TaskGraphView {
  return {
    ...graph,
    startableTasks: graph.startableTasks.slice(0, MAX_LIVE_TASKS),
    tasks: graph.tasks.slice(0, MAX_LIVE_TASKS).map((task) => ({
      ...task,
      dependencies: [...task.dependencies],
      blockedBy: [...task.blockedBy],
      inputs: [...task.inputs],
      expectedArtifacts: [...task.expectedArtifacts],
      completionChecks: [...task.completionChecks],
      ...(task.completionEvidence
        ? {
            completionEvidence: task.completionEvidence.map((item) => ({
              ...item,
            })),
          }
        : {}),
    })),
  };
}

function cloneSubagentResult(
  result: Readonly<SubagentTaskReport>,
): SubagentTaskReport {
  if (result.outcome === "completed") {
    return {
      ...result,
      completionEvidence: result.completionEvidence.map((item) => ({ ...item })),
    };
  }
  return { ...result };
}

function cloneSubagent(agent: Readonly<SubagentView>): SubagentView {
  return {
    ...agent,
    ...(agent.environment ? { environment: { ...agent.environment } } : {}),
    ...(agent.resultArtifact
      ? {
          resultArtifact: {
            ...agent.resultArtifact,
            parentArtifactIds: [...agent.resultArtifact.parentArtifactIds],
          },
        }
      : {}),
    ...(agent.result ? { result: cloneSubagentResult(agent.result) } : {}),
  };
}

function cloneSubagents(
  subagents: readonly Readonly<SubagentView>[],
): readonly SubagentView[] {
  const start = Math.max(0, subagents.length - MAX_LIVE_SUBAGENTS);
  return subagents.slice(start).map(cloneSubagent);
}

function clonePlan(proposal: Readonly<PlanProposal>): PlanProposal {
  return {
    ...proposal,
    steps: proposal.steps.map((step) => ({ ...step })),
  };
}

function normalizedSelectedIndex(selectedIndex: number, rowCount: number): number {
  return rowCount === 0
    ? 0
    : boundedInteger(selectedIndex, 0, rowCount - 1);
}

function cloneOverlay(overlay: Readonly<UIOverlayState>): UIOverlayState {
  const rows = overlay.rows
    .slice(0, MAX_OVERLAY_ROWS)
    .map((row) => ({ ...row }));
  const selectedIndex = normalizedSelectedIndex(overlay.selectedIndex, rows.length);
  switch (overlay.kind) {
    case "picker":
      return { ...overlay, rows, selectedIndex };
    case "approval":
      return {
        ...overlay,
        rows,
        selectedIndex,
        request: { ...overlay.request },
      };
    case "plan-review":
      return {
        ...overlay,
        rows,
        selectedIndex,
        proposal: clonePlan(overlay.proposal),
      };
  }
}

/** Create an empty, renderable state without consulting a clock, TTY, or process. */
export function createUIState(options: CreateUIStateOptions = {}): UIState {
  return {
    header: mergeHeader(EMPTY_HEADER, options.header ?? {}),
    transcript: [],
    live: {
      activity: null,
      progress: [],
      thinking: null,
      tasks: null,
      subagents: [],
    },
    overlay: null,
    composer: mergeComposer(EMPTY_COMPOSER, options.composer ?? {}),
  };
}

/** Descriptive alias for call sites that prefer an explicit initial-state name. */
export function createInitialUIState(options: CreateUIStateOptions = {}): UIState {
  return createUIState(options);
}

/** Apply exactly one structured UI event without mutating the prior state. */
export function applyEvent(
  state: Readonly<UIState>,
  event: Readonly<UIEvent>,
): UIState {
  switch (event.type) {
    case "header.merge":
      return { ...state, header: mergeHeader(state.header, event.patch) };
    case "session.set":
      return {
        ...state,
        header: {
          ...state.header,
          session: event.session === null ? null : cloneSession(event.session),
        },
      };
    case "transcript.append":
      return {
        ...state,
        transcript: appendTranscript(state.transcript, event.entry),
      };
    case "activity.start":
      return {
        ...state,
        live: { ...state.live, activity: cloneActivity(event.activity) },
      };
    case "activity.stop":
      if (
        event.id !== undefined &&
        state.live.activity?.id !== event.id
      ) {
        return state;
      }
      return {
        ...state,
        live: { ...state.live, activity: null },
      };
    case "progress.set":
      return {
        ...state,
        live: { ...state.live, progress: cloneProgress(event.progress) },
      };
    case "progress.clear":
      return {
        ...state,
        live: { ...state.live, progress: [] },
      };
    case "thinking.toggle": {
      const id = thinkingPanelId(event.panel.id);
      if (id === undefined) return state;
      if (state.live.thinking?.id === id) {
        return {
          ...state,
          live: { ...state.live, thinking: null },
        };
      }
      return {
        ...state,
        live: {
          ...state.live,
          thinking: normalizeThinkingPanel(event.panel, id),
        },
      };
    }
    case "thinking.hide":
      if (event.id !== undefined && state.live.thinking?.id !== event.id) {
        return state;
      }
      return {
        ...state,
        live: { ...state.live, thinking: null },
      };
    case "tasks.set":
      return {
        ...state,
        live: { ...state.live, tasks: cloneTaskGraph(event.tasks) },
      };
    case "tasks.clear":
      return {
        ...state,
        live: { ...state.live, tasks: null },
      };
    case "subagents.set":
      return {
        ...state,
        live: { ...state.live, subagents: cloneSubagents(event.subagents) },
      };
    case "subagents.clear":
      return {
        ...state,
        live: { ...state.live, subagents: [] },
      };
    case "overlay.show":
      return { ...state, overlay: cloneOverlay(event.overlay) };
    case "overlay.hide":
      if (event.id !== undefined && state.overlay?.id !== event.id) {
        return state;
      }
      return { ...state, overlay: null };
    case "composer.patch":
      return {
        ...state,
        composer: mergeComposer(state.composer, event.patch),
      };
    case "composer.reset":
      return { ...state, composer: mergeComposer(EMPTY_COMPOSER, {}) };
  }
}

/** Conventional reducer name for integrations using reducer-style dispatch. */
export function uiReducer(
  state: Readonly<UIState>,
  event: Readonly<UIEvent>,
): UIState {
  return applyEvent(state, event);
}

export function applyEvents(
  state: Readonly<UIState>,
  events: readonly Readonly<UIEvent>[],
): UIState {
  return events.reduce<UIState>((current, event) => applyEvent(current, event), state);
}
