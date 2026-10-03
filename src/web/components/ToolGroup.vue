<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { WebEntry } from "../../web-contracts.js";
import { toolTarget } from "../display-content.js";
import { t } from "../i18n.js";
import ToolFileDiff from "./ToolFileDiff.vue";
import ToolStatus from "./ToolStatus.vue";

const props = defineProps<{ tools: readonly WebEntry[] }>();
const list = ref<HTMLElement>();
let openedOnce = false;
const current = computed(() => props.tools.at(-1));
const failed = computed(() => props.tools.filter((tool) => tool.toolStatus === "failed").length);
const running = computed(() => props.tools.some((tool) => tool.toolStatus === "running"));
/** Calls whose file change is open; each loads when first opened. */
const openDiffs = ref<Set<string>>(new Set());
function toggleDiff(id: string): void {
  const next = new Set(openDiffs.value);
  if (!next.delete(id)) next.add(id);
  openDiffs.value = next;
}
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
        :class="{ 'has-open-diff': openDiffs.size > 0 }"
        role="list"
        :aria-label="`${t('ui.tools')} · ${tools.length}`"
        tabindex="0"
      >
        <div v-for="tool in tools" :key="tool.id" class="tool-group-entry" role="listitem">
          <div class="tool-group-item">
            <ToolStatus :status="tool.toolStatus" />
            <strong class="tool-group-name">{{ tool.toolName || t("ui.tool") }}</strong>
            <span class="tool-group-preview">{{ toolTarget(tool) }}</span>
            <button
              v-if="tool.toolDiff"
              type="button"
              class="tool-diff-toggle"
              :aria-expanded="openDiffs.has(tool.id)"
              @click="toggleDiff(tool.id)"
            >
              {{ openDiffs.has(tool.id) ? t("ui.hideFileChange") : t("ui.showFileChange") }}
            </button>
          </div>
          <ToolFileDiff
            v-if="tool.toolDiff && openDiffs.has(tool.id)"
            :diff-ref="tool.toolDiff"
            :path="toolTarget(tool)"
          />
        </div>
      </div>
    </details>
  </article>
</template>
