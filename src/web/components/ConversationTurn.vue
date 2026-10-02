<script setup lang="ts">
import { computed, ref } from "vue";
import type { ConversationDisplayItem, ConversationTurnDisplay } from "../display-content.js";
import { formatTokenCount } from "../../cli/token-count.js";
import { formatDuration } from "../../ui/duration.js";
import { language, t } from "../i18n.js";
import TranscriptEntry from "./TranscriptEntry.vue";
import ToolGroup from "./ToolGroup.vue";
import CompactionStatus from "./CompactionStatus.vue";
import TurnChanges from "./TurnChanges.vue";

const props = defineProps<{ turn: ConversationTurnDisplay }>();
const process = ref<HTMLDetailsElement>();
const compactions = computed(() =>
  props.turn.liveItems.filter((item) => item.kind === "entry" && item.entry.compaction),
);
const processItems = computed(() =>
  props.turn.processItems.filter((item) => item.kind !== "entry" || !item.entry.compaction),
);
const summary = computed(() => (props.turn.status === "completed" ? props.turn.summary : undefined));
const tokens = computed(() =>
  summary.value?.inputTokens !== undefined && summary.value.outputTokens !== undefined
    ? `↑ ${formatTokenCount(summary.value.inputTokens)} ↓ ${formatTokenCount(summary.value.outputTokens)} tokens`
    : undefined,
);

function elapsed(): string {
  const turn = props.turn;
  return formatDuration((turn.completedAt ?? turn.startedAt) - turn.startedAt, language.value);
}
function closeNestedDetails(root: HTMLDetailsElement): void {
  for (const detail of root.querySelectorAll<HTMLDetailsElement>("details[open]")) detail.open = false;
}
function onToggle(event: Event): void {
  if (event.target !== process.value || !(event.target instanceof HTMLDetailsElement)) return;
  if (!event.target.open) closeNestedDetails(event.target);
}
function itemKey(item: ConversationDisplayItem): string {
  return item.id;
}
</script>

<template>
  <section class="conversation-turn" :data-turn-id="turn.id" :data-user-entry-id="turn.request?.id">
    <template v-if="turn.liveItems.every((item) => item.kind === 'entry' && item.entry.compaction)">
      <template v-for="item in turn.liveItems" :key="itemKey(item)">
        <CompactionStatus v-if="item.kind === 'entry' && item.entry.compaction" :progress="item.entry.compaction" />
      </template>
    </template>
    <template v-else-if="turn.status === 'running'">
      <template v-for="item in turn.liveItems" :key="itemKey(item)">
        <ToolGroup v-if="item.kind === 'tool-group'" :tools="item.tools" />
        <CompactionStatus v-else-if="item.entry.compaction" :progress="item.entry.compaction" />
        <TranscriptEntry v-else :entry="item.entry" />
      </template>
    </template>
    <template v-else>
      <TranscriptEntry v-if="turn.request" :entry="turn.request" />
      <details v-if="processItems.length" ref="process" class="turn-process" @toggle="onToggle">
        <summary>
          <span>{{
            turn.status === "completed" ? `${t("ui.turnElapsed")} ${elapsed()}` : t("ui.finalAnswerStreaming")
          }}</span>
        </summary>
        <div class="turn-process-body">
          <template v-for="item in processItems" :key="itemKey(item)">
            <ToolGroup v-if="item.kind === 'tool-group'" :tools="item.tools" />
            <TranscriptEntry v-else :entry="item.entry" />
          </template>
        </div>
      </details>
      <div v-else-if="turn.status === 'completed'" class="turn-duration">{{ t("ui.turnElapsed") }} {{ elapsed() }}</div>
      <template v-for="item in compactions" :key="itemKey(item)">
        <CompactionStatus v-if="item.kind === 'entry' && item.entry.compaction" :progress="item.entry.compaction" />
      </template>
      <TranscriptEntry v-if="turn.finalAnswer" :entry="turn.finalAnswer" />
      <TurnChanges
        v-if="summary?.changedFiles.length"
        :files="summary.changedFiles"
        :thread-id="summary.threadId"
        :turn-id="summary.turnId"
      />
      <div v-if="tokens" class="turn-summary">{{ tokens }}</div>
    </template>
  </section>
</template>
