<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { WebEntry } from "../../web-contracts.js";
import { toolTarget } from "../display-content.js";
import { t } from "../i18n.js";
import ToolStatus from "./ToolStatus.vue";

const props = defineProps<{ tools: readonly WebEntry[] }>();
const list = ref<HTMLElement>();
let openedOnce = false;
const current = computed(() => props.tools.at(-1));
const failed = computed(() => props.tools.filter((tool) => tool.toolStatus === "failed").length);
const running = computed(() => props.tools.some((tool) => tool.toolStatus === "running"));
function row(tool: WebEntry | undefined): string {
  if (!tool) return t("ui.receiving");
  const name = tool.toolName || t("ui.tool");
  const target = toolTarget(tool);
  return target ? `${name} · ${target}` : name;
}
watch(
  () => props.tools.length,
  async () => {
    const element = list.value;
    const followLatest = element && element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    await nextTick();
    if (followLatest && list.value) list.value.scrollTop = list.value.scrollHeight;
  },
);
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
      <summary>
        <ToolStatus :status="running ? 'running' : failed ? 'failed' : 'completed'" /><span class="disclosure-label"
          >{{ t("ui.tools") }} · {{ tools.length
          }}<template v-if="failed"> · {{ t("ui.toolsFailed", { count: failed }) }}</template></span
        ><span class="disclosure-preview">{{ row(current) }}</span>
      </summary>
      <div
        ref="list"
        class="tool-group-list"
        role="list"
        :aria-label="`${t('ui.tools')} · ${tools.length}`"
        tabindex="0"
      >
        <div v-for="tool in tools" :key="tool.id" class="tool-group-item" role="listitem">
          <ToolStatus :status="tool.toolStatus" />
          <strong class="tool-group-name">{{ tool.toolName || t("ui.tool") }}</strong>
          <span class="tool-group-preview">{{ toolTarget(tool) }}</span>
        </div>
      </div>
    </details>
  </article>
</template>
