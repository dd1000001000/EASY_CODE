<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { renderAssistantMarkdown } from "../markdown.js";

const props = defineProps<{ text: string }>();
const html = ref(renderAssistantMarkdown(props.text));
let renderTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => props.text, () => {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { html.value = renderAssistantMarkdown(props.text); renderTimer = undefined; }, 50);
});
onUnmounted(() => { if (renderTimer) clearTimeout(renderTimer); });

async function copyCode(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-copy-code]");
  const code = button?.closest(".markdown-code-block")?.querySelector("code");
  if (!button || !code) return;
  try {
    await navigator.clipboard.writeText(code.textContent ?? "");
    button.textContent = "Copied";
    window.setTimeout(() => { if (button.isConnected) button.textContent = "Copy"; }, 1500);
  } catch { button.textContent = "Copy failed"; }
}
</script>

<template>
  <div class="markdown-message" @click="copyCode" v-html="html"></div>
</template>
