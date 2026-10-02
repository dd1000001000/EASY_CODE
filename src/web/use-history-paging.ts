import { computed, nextTick, ref, watch, type Ref } from "vue";
import type { WebEntry, WebHistoryState, WebView } from "../web-contracts.js";
import { fetchHistoryPage } from "./api.js";
import { activeMessageIdsForViewport, isConversationEntry } from "./display-content.js";
import { errorMessage } from "./errors.js";

/** The transcript shown for the open conversation: the live tail, or a page of history around a jump. */
export function createTranscriptState() {
  const view = ref<WebView>({
    session: null,
    entries: [],
    tasks: null,
    subagents: [],
    activities: [],
    review: null,
    decision: null,
    busy: false,
  });
  const history = ref<WebHistoryState>({ epoch: "", hasEarlier: false, markers: [] });
  const historyLoading = ref(false);
  const historyExpanded = ref(false);
  /** Entries around a jumped-to message, shown instead of the live tail until the user returns. */
  const archiveEntries = ref<WebEntry[] | null>(null);
  const archiveHasEarlier = ref(false);
  const archiveHasLater = ref(false);
  /** Whether new entries keep the view at the bottom; off once the user scrolls up or jumps. */
  const scroll = { keepBottom: true };
  const activeThread = computed(() => view.value.session?.threadId);
  const displayedEntries = computed(() => archiveEntries.value ?? view.value.entries);
  const conversationEntries = computed(() => displayedEntries.value.filter(isConversationEntry));
  const hasEarlier = computed(() => (archiveEntries.value ? archiveHasEarlier.value : history.value.hasEarlier));
  function clearArchive(): void {
    archiveEntries.value = null;
    archiveHasEarlier.value = false;
    archiveHasLater.value = false;
  }
  return {
    view,
    history,
    historyLoading,
    historyExpanded,
    archiveEntries,
    archiveHasEarlier,
    archiveHasLater,
    scroll,
    activeThread,
    displayedEntries,
    conversationEntries,
    hasEarlier,
    clearArchive,
  };
}

export type TranscriptState = ReturnType<typeof createTranscriptState>;

/**
 * Paging through a long conversation: older entries load when the view nears
 * the top, a jump to a message shows the page around it, and the message rail
 * follows what is on screen.
 */
export function useHistoryPaging(
  state: TranscriptState,
  transcript: Ref<HTMLElement | undefined>,
  onError: (message: string) => void,
) {
  const { view, history, historyLoading, historyExpanded, archiveEntries, archiveHasEarlier, archiveHasLater } = state;
  const visibleMessageIds = ref<Set<string>>(new Set());

  function updateVisibleMessages(): void {
    const viewport = transcript.value;
    if (!viewport) {
      visibleMessageIds.value = new Set();
      return;
    }
    const bounds = viewport.getBoundingClientRect();
    const users = [...viewport.querySelectorAll<HTMLElement>(".entry--user[data-entry-id]")].flatMap((element) => {
      const id = element.dataset.entryId;
      if (!id) return [];
      const box = element.getBoundingClientRect();
      return [{ id, top: box.top, bottom: box.bottom }];
    });
    const turns = [...viewport.querySelectorAll<HTMLElement>(".conversation-turn[data-user-entry-id]")].map(
      (element) => {
        const box = element.getBoundingClientRect();
        return { requestId: element.dataset.userEntryId, top: box.top, bottom: box.bottom };
      },
    );
    visibleMessageIds.value = new Set(
      activeMessageIdsForViewport({ top: bounds.top, bottom: bounds.bottom }, users, turns),
    );
  }

  async function loadOlder(): Promise<void> {
    const current = state.displayedEntries.value;
    const wasArchive = archiveEntries.value !== null;
    const before = current[0]?.id;
    const threadId = state.activeThread.value;
    const epoch = history.value.epoch;
    if (!threadId || !before || historyLoading.value || !state.hasEarlier.value) return;
    historyLoading.value = true;
    const viewport = transcript.value;
    const oldHeight = viewport?.scrollHeight ?? 0;
    const oldTop = viewport?.scrollTop ?? 0;
    try {
      const page = await fetchHistoryPage(threadId, epoch, { before });
      if (state.activeThread.value !== threadId || history.value.epoch !== page.epoch) return;
      if ((archiveEntries.value !== null) !== wasArchive) return;
      const latest = state.displayedEntries.value;
      const known = new Set(latest.map((entry) => entry.id));
      const entries = [...page.entries.filter((entry) => !known.has(entry.id)), ...latest];
      state.scroll.keepBottom = false;
      if (archiveEntries.value) {
        archiveEntries.value = entries;
        archiveHasEarlier.value = page.hasEarlier;
        archiveHasLater.value = page.hasLater;
      } else {
        view.value = { ...view.value, entries };
        history.value = { ...history.value, hasEarlier: page.hasEarlier };
        historyExpanded.value = true;
      }
      await nextTick();
      if (viewport) viewport.scrollTop = oldTop + viewport.scrollHeight - oldHeight;
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      historyLoading.value = false;
    }
  }

  async function loadNewer(): Promise<void> {
    const current = archiveEntries.value;
    const after = current?.at(-1)?.id;
    const threadId = state.activeThread.value;
    const epoch = history.value.epoch;
    if (!current || !after || !threadId || !archiveHasLater.value || historyLoading.value) return;
    historyLoading.value = true;
    try {
      const page = await fetchHistoryPage(threadId, epoch, { after });
      if (
        state.activeThread.value !== threadId ||
        history.value.epoch !== page.epoch ||
        archiveEntries.value !== current
      )
        return;
      const known = new Set(current.map((entry) => entry.id));
      archiveEntries.value = [...current, ...page.entries.filter((entry) => !known.has(entry.id))];
      archiveHasLater.value = page.hasLater;
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      historyLoading.value = false;
    }
  }

  function entryElement(viewport: HTMLElement, id: string): HTMLElement | undefined {
    return [...viewport.querySelectorAll<HTMLElement>(".entry[data-entry-id]")].find(
      (item) => item.dataset.entryId === id,
    );
  }

  async function jumpToEntry(id: string): Promise<void> {
    const viewport = transcript.value;
    if (!viewport || !state.activeThread.value) return;
    let element = entryElement(viewport, id);
    if (!element) {
      const threadId = state.activeThread.value;
      try {
        const page = await fetchHistoryPage(threadId, history.value.epoch, { around: id });
        if (state.activeThread.value !== threadId || history.value.epoch !== page.epoch) return;
        archiveEntries.value = [...page.entries];
        archiveHasEarlier.value = page.hasEarlier;
        archiveHasLater.value = page.hasLater;
        state.scroll.keepBottom = false;
        await nextTick();
        element = entryElement(viewport, id);
      } catch (reason) {
        onError(errorMessage(reason));
        return;
      }
    }
    if (!element) return;
    const hiddenProcess = element.closest<HTMLDetailsElement>("details.turn-process:not([open])");
    if (hiddenProcess) {
      hiddenProcess.open = true;
      await nextTick();
    }
    const top = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    state.scroll.keepBottom = false;
    viewport.scrollTo({ top: Math.max(0, top - viewport.clientHeight / 4), behavior: "smooth" });
    updateVisibleMessages();
  }

  async function returnToLatest(): Promise<void> {
    state.clearArchive();
    state.scroll.keepBottom = true;
    await nextTick();
    transcript.value?.scrollTo({ top: transcript.value.scrollHeight, behavior: "instant" });
    updateVisibleMessages();
  }

  function onScroll(): void {
    const element = transcript.value;
    if (element) state.scroll.keepBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
    updateVisibleMessages();
    if (element && element.scrollTop < 100) void loadOlder();
    if (element && archiveEntries.value && element.scrollHeight - element.scrollTop - element.clientHeight < 100)
      void loadNewer();
  }

  watch(
    state.displayedEntries,
    async () => {
      await nextTick();
      updateVisibleMessages();
    },
    { flush: "post" },
  );
  watch(
    () => [state.conversationEntries.value.length, state.conversationEntries.value.at(-1)?.text.length],
    async () => {
      if (!state.scroll.keepBottom || archiveEntries.value) return;
      await nextTick();
      transcript.value?.scrollTo({ top: transcript.value.scrollHeight, behavior: "instant" });
    },
  );

  return { visibleMessageIds, updateVisibleMessages, loadOlder, loadNewer, jumpToEntry, returnToLatest, onScroll };
}
