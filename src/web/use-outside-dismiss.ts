import { onMounted, onUnmounted, type Ref } from "vue";

type PanelRoot = HTMLElement | { $el: HTMLElement } | null | undefined;

/** Dismiss a composer popover without treating teleported Element Plus controls as outside clicks. */
export function useOutsideDismiss<T extends PanelRoot>(root: Readonly<Ref<T>>, dismiss: () => void): void {
  function onPointerDown(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const current = root.value;
    const element = current instanceof HTMLElement ? current : current?.$el;
    if (!element || element.contains(target)) return;
    if (target instanceof Element && target.closest(".el-overlay, .el-popper")) return;
    dismiss();
  }
  onMounted(() => document.addEventListener("pointerdown", onPointerDown, true));
  onUnmounted(() => document.removeEventListener("pointerdown", onPointerDown, true));
}
