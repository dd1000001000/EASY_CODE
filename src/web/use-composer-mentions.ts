import { computed, ref, watch, type Ref } from "vue";
import {
  MentionIndex,
  mentionReferences,
  mentionSuggestions,
  removeMentionReference,
  type MentionReference,
} from "../cli/mention-suggestions.js";
import type { SlashSuggestion } from "../cli/slash-suggestions.js";
import { fetchMentionPaths } from "./api.js";

/** While a conversation is still listing its files, ask again at most this often. */
const RETRY_EMPTY_MS = 2_000;

/**
 * `@file` references in the composer: completion while one is typed, and the
 * referenced files and folders of the whole draft. The workspace listing is
 * fetched on the first `@` of each conversation.
 */
export function useComposerMentions(options: {
  threadId: () => string | undefined;
  draft: Ref<string>;
  caret: () => number;
  /** Replace the draft and put the caret at `caret`. */
  setDraft: (text: string, caret: number) => void;
}) {
  const paths = ref<readonly string[]>([]);
  let loadedFor: string | undefined;
  let requestedAt = -Infinity;
  let pending: Promise<void> | undefined;
  const index = computed(() => {
    const listed = paths.value;
    return new MentionIndex(() => listed);
  });
  const suggestions = ref<readonly SlashSuggestion[]>([]);
  const active = ref(0);
  /** The draft at which the user closed the menu; it stays closed until the draft changes. */
  let dismissedAt: string | undefined;

  const references = computed<readonly MentionReference[]>(() =>
    paths.value.length && options.draft.value.includes("@") ? mentionReferences(options.draft.value, index.value) : [],
  );

  function load(): void {
    const threadId = options.threadId();
    if (!threadId || pending) return;
    if (loadedFor === threadId && (paths.value.length || performance.now() - requestedAt < RETRY_EMPTY_MS)) return;
    requestedAt = performance.now();
    pending = fetchMentionPaths(threadId)
      .then((listed) => {
        if (options.threadId() !== threadId) return;
        loadedFor = threadId;
        paths.value = listed;
        update();
      })
      .catch(() => undefined)
      .finally(() => {
        pending = undefined;
      });
  }

  /** Recompute the menu for the caret's current position. */
  function update(): void {
    const draft = options.draft.value;
    if (!draft.includes("@") || draft === dismissedAt) {
      suggestions.value = [];
      return;
    }
    load();
    const next = mentionSuggestions(draft, options.caret(), index.value);
    if (next.length !== suggestions.value.length || next[0]?.label !== suggestions.value[0]?.label) active.value = 0;
    suggestions.value = next;
  }

  function accept(position = active.value): void {
    const suggestion = suggestions.value[position];
    if (!suggestion) return;
    options.setDraft(suggestion.replacement, suggestion.cursor ?? suggestion.replacement.length);
  }

  function remove(reference: MentionReference): void {
    const next = removeMentionReference(options.draft.value, reference);
    options.setDraft(next, Math.min(reference.start, next.length));
  }

  /** Keys while the menu is open; true when the key was used. */
  function keydown(event: KeyboardEvent): boolean {
    const count = suggestions.value.length;
    if (!count || event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      active.value = (active.value + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    } else if (event.key === "Enter" || event.key === "Tab") {
      if (event.shiftKey) return false;
      accept();
    } else if (event.key === "Escape") {
      dismissedAt = options.draft.value;
      suggestions.value = [];
    } else return false;
    event.preventDefault();
    return true;
  }

  watch(options.threadId, () => {
    paths.value = [];
    loadedFor = undefined;
    suggestions.value = [];
  });
  watch(options.draft, (draft) => {
    if (draft !== dismissedAt) dismissedAt = undefined;
  });

  return { suggestions, active, references, update, accept, remove, keydown };
}
