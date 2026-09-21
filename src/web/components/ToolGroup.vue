<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { WebEntry } from "../../web-contracts.js";
import { t } from "../i18n.js";

const props = defineProps<{ tools: readonly WebEntry[] }>();
const list = ref<HTMLElement>();
let openedOnce = false;
const current = computed(() => props.tools.at(-1));
function preview(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 120) || t("ui.receiving");
}
watch(() => props.tools.length, async () => {
  const element = list.value;
  const followLatest = element && element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  await nextTick();
  if (followLatest && list.value) list.value.scrollTop = list.value.scrollHeight;
});
async function onToggle(event: Event): Promise<void> {
  if (!(event.target instanceof HTMLDetailsElement) || !event.target.open || openedOnce) return;
  openedOnce = true;
  await nextTick();
  if (list.value) list.value.scrollTop = list.value.scrollHeight;
}
</script>

<template>
  <article class="entry entry--tool tool-group" :data-entry-id="tools[0]?.id">
    <details class="disclosure tool-disclosure" @toggle="onToggle">
      <summary><span class="disclosure-label">{{ t('ui.tool') }} · {{ tools.length }}</span><span class="disclosure-preview">{{ preview(current?.text ?? '') }}</span></summary>
      <div ref="list" class="tool-group-list" role="list" :aria-label="`${t('ui.tool')} · ${tools.length}`" tabindex="0">
        <div v-for="tool in tools" :key="tool.id" class="tool-group-item" role="listitem">
          <strong class="tool-group-name">{{ tool.toolName || t('ui.tool') }}</strong>
          <span class="tool-group-preview">{{ preview(tool.text) }}</span>
        </div>
      </div>
    </details>
  </article>
</template>
