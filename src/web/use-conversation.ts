import { computed, ref, type Ref } from "vue";
import type { PlanProposal } from "../core/types.js";
import type { WebEntry, WebPatch } from "../web-contracts.js";
import { parseLanguage } from "../i18n/language.js";
import { bootstrap, request, type ProjectItem, type ThreadItem, type WebSnapshot } from "./api.js";
import {
  groupConversationTurns,
  isNoticeEntry,
  toolRunContinuesAcross,
  turnContinuesAcross,
} from "./display-content.js";
import { errorMessage } from "./errors.js";
import { setLanguage, t } from "./i18n.js";
import { createTranscriptState, useHistoryPaging } from "./use-history-paging.js";

/** Live entries kept while following the conversation; older ones page in from history on demand. */
const MAX_LIVE_ENTRIES = 200;

export interface ConversationHooks {
  /** A full snapshot was applied (first load, reconnect, or refresh). */
  onSnapshot(snapshot: WebSnapshot): void;
  /** Every live patch of every thread, before the active-thread filter. */
  onPatch(threadId: string, patch: WebPatch): void;
  /** A notice (info, success, warning, error) appended to the active thread. */
  onNotice(entry: WebEntry & { kind: "info" | "success" | "warning" | "error" }): void;
  /** The set of running threads changed. */
  onRunningThreads(ids: readonly string[]): void;
  onError(message: string): void;
}

/**
 * The open conversation as the server streams it: the snapshot and its live
 * patches, the threads and projects beside it, and (through history paging)
 * the older entries around them.
 */
export function useConversation(transcript: Ref<HTMLElement | undefined>, hooks: ConversationHooks) {
  const state = createTranscriptState();
  const { view, history, historyExpanded, archiveEntries } = state;
  const paging = useHistoryPaging(state, transcript, (message) => hooks.onError(message));
  const threads = ref<ThreadItem[]>([]);
  const projects = ref<ProjectItem[]>([]);
  const runningThreadIds = ref<Set<string>>(new Set());
  const selectedProjectId = ref<string>();
  const plan = ref<PlanProposal | null>(null);
  const connected = ref(false);
  const loading = ref(true);
  let events: EventSource | undefined;
  let sequence = -1;

  const session = computed(() => view.value.session);
  const conversationTurns = computed(() => groupConversationTurns(state.conversationEntries.value));

  function applySnapshot(snapshot: WebSnapshot): void {
    if (snapshot.view.session?.threadId === view.value.session?.threadId && snapshot.sequence < sequence) return;
    setLanguage(snapshot.language);
    const sameHistory =
      snapshot.view.session?.threadId === view.value.session?.threadId &&
      snapshot.history.epoch === history.value.epoch;
    const preserveLoaded = sameHistory && (historyExpanded.value || !state.scroll.keepBottom);
    const recentIds = new Set(snapshot.view.entries.map((entry) => entry.id));
    const entries = preserveLoaded
      ? [...view.value.entries.filter((entry) => !recentIds.has(entry.id)), ...snapshot.view.entries]
      : snapshot.view.entries;
    sequence = snapshot.sequence;
    view.value = { ...snapshot.view, entries };
    history.value = {
      ...snapshot.history,
      hasEarlier: preserveLoaded ? history.value.hasEarlier : snapshot.history.hasEarlier,
    };
    if (!sameHistory) {
      state.clearArchive();
      historyExpanded.value = false;
      state.scroll.keepBottom = true;
    }
    threads.value = snapshot.threads;
    projects.value = snapshot.projects;
    runningThreadIds.value = new Set(snapshot.runningThreadIds);
    if (snapshot.view.session) {
      selectedProjectId.value =
        snapshot.view.session.projectId ??
        snapshot.projects.find((project) => project.root === snapshot.view.session?.workspaceRoot)?.id;
    } else if (!snapshot.projects.some((project) => project.id === selectedProjectId.value)) {
      selectedProjectId.value = undefined;
    }
    plan.value = snapshot.plan;
    loading.value = false;
    hooks.onSnapshot(snapshot);
  }

  function appendEntry(entry: WebEntry): void {
    let entries = [...view.value.entries, entry];
    if (state.scroll.keepBottom && !archiveEntries.value && entries.length > MAX_LIVE_ENTRIES) {
      let start = entries.length - MAX_LIVE_ENTRIES;
      while (start > 0 && (turnContinuesAcross(entries, start) || toolRunContinuesAcross(entries, start))) start -= 1;
      entries = entries.slice(start);
      history.value = { ...history.value, hasEarlier: true };
      historyExpanded.value = false;
    }
    view.value = { ...view.value, entries };
    if (entry.kind === "user" && !history.value.markers.some((marker) => marker.id === entry.id)) {
      const preview = entry.text.replace(/\s+/gu, " ").trim();
      history.value = {
        ...history.value,
        markers: [
          ...history.value.markers,
          {
            id: entry.id,
            preview: (preview || (entry.images?.length ? t("ui.imageAttachment") : t("ui.yourMessage"))).slice(0, 120),
          },
        ],
      };
    }
    if (isNoticeEntry(entry)) hooks.onNotice(entry);
  }

  function applyPatch(patch: WebPatch, nextSequence: number): void {
    if (Number.isFinite(nextSequence) && nextSequence <= sequence) return;
    sequence = nextSequence;
    if (patch.kind === "entry.append") appendEntry(patch.entry);
    else if (patch.kind === "entry.replace")
      view.value = {
        ...view.value,
        entries: view.value.entries.map((entry) => (entry.id === patch.entry.id ? patch.entry : entry)),
      };
    else if (patch.kind === "entry.delta")
      view.value = {
        ...view.value,
        entries: view.value.entries.map((entry) =>
          entry.id === patch.id ? { ...entry, text: entry.text + patch.text } : entry,
        ),
      };
    else if (patch.kind === "entries.reset") {
      view.value = { ...view.value, entries: patch.entries };
      if (patch.history) history.value = patch.history;
      state.clearArchive();
      historyExpanded.value = false;
    } else if (patch.kind === "thread.title")
      threads.value = threads.value.map((thread) =>
        thread.threadId === patch.threadId ? { ...thread, title: patch.title, canRename: false } : thread,
      );
    else if (patch.kind === "state") view.value = { ...view.value, ...patch.state };
  }

  async function refresh(): Promise<void> {
    try {
      applySnapshot(await request<WebSnapshot>("/api/state"));
    } catch (reason) {
      hooks.onError(errorMessage(reason));
    }
  }

  function connect(): void {
    events = new EventSource("/api/events");
    events.addEventListener("snapshot", (event) => {
      applySnapshot(JSON.parse((event as MessageEvent).data) as WebSnapshot);
      connected.value = true;
    });
    events.addEventListener("patch", (event) => {
      const update = JSON.parse((event as MessageEvent).data) as {
        threadId: string;
        sequence: number;
        patch: WebPatch;
      };
      hooks.onPatch(update.threadId, update.patch);
      if (update.threadId !== state.activeThread.value) return;
      const before = view.value.busy;
      const beforeThread = view.value.session?.threadId;
      applyPatch(update.patch, update.sequence);
      if ((before && !view.value.busy) || beforeThread !== view.value.session?.threadId) void refresh();
    });
    events.addEventListener("status", (event) => {
      const ids = (JSON.parse((event as MessageEvent).data) as { runningThreadIds: string[] }).runningThreadIds;
      hooks.onRunningThreads(ids);
      const completed = [...runningThreadIds.value].some((id) => !ids.includes(id));
      runningThreadIds.value = new Set(ids);
      if (completed) void refresh();
    });
    events.addEventListener("language", (event) => {
      setLanguage(parseLanguage((JSON.parse((event as MessageEvent).data) as { language: string }).language));
    });
    events.onerror = () => {
      connected.value = false;
    };
    events.onopen = () => {
      connected.value = true;
    };
  }

  async function start(): Promise<void> {
    try {
      applySnapshot(await bootstrap());
      connect();
    } catch (reason) {
      loading.value = false;
      hooks.onError(errorMessage(reason));
    }
  }

  function stop(): void {
    events?.close();
  }

  return {
    view,
    history,
    historyLoading: state.historyLoading,
    archiveEntries,
    archiveHasLater: state.archiveHasLater,
    threads,
    projects,
    runningThreadIds,
    selectedProjectId,
    plan,
    connected,
    loading,
    visibleMessageIds: paging.visibleMessageIds,
    session,
    activeThread: state.activeThread,
    conversationEntries: state.conversationEntries,
    conversationTurns,
    hasEarlier: state.hasEarlier,
    start,
    stop,
    refresh,
    loadOlder: paging.loadOlder,
    loadNewer: paging.loadNewer,
    jumpToEntry: paging.jumpToEntry,
    returnToLatest: paging.returnToLatest,
    onScroll: paging.onScroll,
    updateVisibleMessages: paging.updateVisibleMessages,
  };
}
