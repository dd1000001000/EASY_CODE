import type { SubagentTaskReport } from "../core/types.js";
import type { SubagentView } from "../subagents/types.js";
import type { TaskGraphView } from "../tasks/task-graph.js";
import type {
  UIActivityState,
  UIComposerPatch,
  UIComposerState,
  UIEvent,
  UIHeaderPatch,
  UIHeaderState,
  UIProgressItem,
  UISessionInfo,
  UIState,
  UITranscriptEntry,
} from "./contracts.js";
import { boundedInteger } from "../utils/guards.js";

export const MAX_LIVE_TASKS = 32;
export const MAX_LIVE_SUBAGENTS = 64;
export const MAX_LIVE_PROGRESS_ITEMS = 64;
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
  pendingSubmissions: 0,
  placeholder: DEFAULT_COMPOSER_PLACEHOLDER,
};

function cloneSession(session: Readonly<UISessionInfo>): UISessionInfo {
  return { ...session };
}

function mergeHeader(current: Readonly<UIHeaderState>, patch: Readonly<UIHeaderPatch>): UIHeaderState {
  const session =
    patch.session === undefined ? current.session : patch.session === null ? null : cloneSession(patch.session);
  return {
    title: patch.title ?? current.title,
    session,
  };
}

function mergeComposer(current: Readonly<UIComposerState>, patch: Readonly<UIComposerPatch>): UIComposerState {
  return {
    pendingSubmissions: boundedInteger(
      patch.pendingSubmissions ?? current.pendingSubmissions,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    placeholder: patch.placeholder ?? current.placeholder,
  };
}

function cloneTranscriptEntry(entry: Readonly<UITranscriptEntry>): UITranscriptEntry {
  return {
    ...entry,
    ...(entry.images ? { images: entry.images.map((image) => ({ ...image })) } : {}),
    ...(entry.presentation ? { presentation: { ...entry.presentation } } : {}),
  };
}

function appendTranscript(
  transcript: readonly UITranscriptEntry[],
  entry: Readonly<UITranscriptEntry>,
): readonly UITranscriptEntry[] {
  // This array is the source document for the managed terminal viewport.
  // Evicting entries here would turn ordinary scrollback into silent data
  // loss. Durable sessions may later page cold history from storage, but the
  // in-memory renderer itself must not pretend an evicted entry still exists.
  return [...transcript, cloneTranscriptEntry(entry)];
}

function replaceTranscript(
  transcript: readonly UITranscriptEntry[],
  id: string,
  entry: Readonly<UITranscriptEntry>,
): readonly UITranscriptEntry[] {
  const index = transcript.findIndex((candidate) => candidate.id === id);
  if (index < 0) return transcript;
  const replacement = cloneTranscriptEntry({ ...entry, id });
  return transcript.map((candidate, candidateIndex) => (candidateIndex === index ? replacement : candidate));
}

function cloneActivity(activity: Readonly<UIActivityState>): UIActivityState {
  return { ...activity };
}

function cloneProgress(progress: readonly Readonly<UIProgressItem>[]): readonly UIProgressItem[] {
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

function cloneSubagentResult(result: Readonly<SubagentTaskReport>): SubagentTaskReport {
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

function cloneSubagents(subagents: readonly Readonly<SubagentView>[]): readonly SubagentView[] {
  const start = Math.max(0, subagents.length - MAX_LIVE_SUBAGENTS);
  return subagents.slice(start).map(cloneSubagent);
}

/** Create an empty, renderable state without consulting a clock, TTY, or process. */
export function createUIState(options: CreateUIStateOptions = {}): UIState {
  return {
    header: mergeHeader(EMPTY_HEADER, options.header ?? {}),
    transcript: [],
    live: {
      activity: null,
      review: null,
      progress: [],
      tasks: null,
      subagents: [],
    },
    composer: mergeComposer(EMPTY_COMPOSER, options.composer ?? {}),
  };
}

/** Apply exactly one structured UI event without mutating the prior state. */
export function applyEvent(state: Readonly<UIState>, event: Readonly<UIEvent>): UIState {
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
    case "transcript.replace":
      return {
        ...state,
        transcript: replaceTranscript(state.transcript, event.id, event.entry),
      };
    case "activity.start":
      return {
        ...state,
        live: { ...state.live, activity: cloneActivity(event.activity) },
      };
    case "activity.stop":
      if (event.id !== undefined && state.live.activity?.id !== event.id) {
        return state;
      }
      return {
        ...state,
        live: { ...state.live, activity: null },
      };
    case "review.set":
      return {
        ...state,
        live: { ...state.live, review: { ...event.review } },
      };
    case "review.clear":
      if (event.id !== undefined && state.live.review?.id !== event.id) return state;
      return {
        ...state,
        live: { ...state.live, review: null },
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
    case "tasks.set":
      return {
        ...state,
        // A completed DAG remains durable in the Thread and transcript, but
        // it is no longer live status. Keeping it here leaves `Tasks N/N` in
        // the fixed footer throughout later requests.
        live: {
          ...state.live,
          tasks: event.tasks.status === "completed" ? null : cloneTaskGraph(event.tasks),
        },
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
export function uiReducer(state: Readonly<UIState>, event: Readonly<UIEvent>): UIState {
  return applyEvent(state, event);
}

export function applyEvents(state: Readonly<UIState>, events: readonly Readonly<UIEvent>[]): UIState {
  return events.reduce<UIState>((current, event) => applyEvent(current, event), state);
}
