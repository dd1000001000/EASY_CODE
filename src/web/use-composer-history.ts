import { computed, ref, watch, type Ref } from "vue";

/**
 * ↑/↓ through the messages already sent in this conversation, like a shell.
 * The draft being written is kept and comes back after the newest message
 * or on Escape. Editing a recalled message makes it the new draft.
 */
export function useComposerHistory(messages: () => readonly string[], draft: Ref<string>) {
  /** Index into `messages()` while browsing. */
  const position = ref<number>();
  let saved = "";
  let recalling = false;

  /** `2/5` while browsing: the second newest of five. */
  const label = computed(() => {
    const total = messages().length;
    return position.value === undefined ? undefined : `${total - position.value}/${total}`;
  });

  function show(next: number | undefined): void {
    position.value = next;
    recalling = true;
    draft.value = next === undefined ? saved : (messages()[next] ?? "");
    recalling = false;
  }

  /** Recall an older message; false when there is none. */
  function older(): boolean {
    const list = messages();
    if (!list.length) return false;
    if (position.value === undefined) {
      saved = draft.value;
      show(list.length - 1);
      return true;
    }
    if (position.value === 0) return false;
    show(position.value - 1);
    return true;
  }

  /** Recall a newer message, or the saved draft after the newest; false when not browsing. */
  function newer(): boolean {
    if (position.value === undefined) return false;
    show(position.value + 1 < messages().length ? position.value + 1 : undefined);
    return true;
  }

  /** Leave history and restore the draft; false when not browsing. */
  function exit(): boolean {
    if (position.value === undefined) return false;
    show(undefined);
    return true;
  }

  function reset(): void {
    position.value = undefined;
    saved = "";
  }

  // Synchronous, so a draft set by `show` is told apart from the user's own edit.
  watch(
    draft,
    () => {
      if (!recalling) position.value = undefined;
    },
    { flush: "sync" },
  );

  return { position, label, older, newer, exit, reset };
}
