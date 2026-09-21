<script setup lang="ts">
import { ref } from "vue";
import type { ConversationDisplayItem, ConversationTurnDisplay } from "../display-content.js";
import { t } from "../i18n.js";
import TranscriptEntry from "./TranscriptEntry.vue";
import ToolGroup from "./ToolGroup.vue";

const props = defineProps<{ turn: ConversationTurnDisplay }>();
const process = ref<HTMLDetailsElement>();

function duration(milliseconds: number): string {
  let seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86_400); seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600); seconds %= 3_600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  return [
    days ? `${days}${t("ui.durationDay")}` : "",
    hours ? `${hours}${t("ui.durationHour")}` : "",
    minutes ? `${minutes}${t("ui.durationMinute")}` : "",
    `${seconds}${t("ui.durationSecond")}`,
  ].filter(Boolean).join("");
}
function elapsed(): string {
  return duration(Math.max(0, (props.turn.completedAt ?? props.turn.startedAt) - props.turn.startedAt));
}
function closeNestedDetails(root: HTMLDetailsElement): void {
  for (const detail of root.querySelectorAll<HTMLDetailsElement>("details[open]")) detail.open = false;
}
function onToggle(event: Event): void {
  if (event.target !== process.value || !(event.target instanceof HTMLDetailsElement)) return;
  if (!event.target.open) closeNestedDetails(event.target);
}
function itemKey(item: ConversationDisplayItem): string { return item.id; }
</script>

<template>
  <section class="conversation-turn" :data-turn-id="turn.id" :data-user-entry-id="turn.request?.id">
    <template v-if="turn.status === 'running'">
      <template v-for="item in turn.liveItems" :key="itemKey(item)">
        <ToolGroup v-if="item.kind === 'tool-group'" :tools="item.tools" />
        <TranscriptEntry v-else :entry="item.entry" />
      </template>
    </template>
    <template v-else>
      <TranscriptEntry v-if="turn.request" :entry="turn.request" />
      <details v-if="turn.processItems.length" ref="process" class="turn-process" @toggle="onToggle">
        <summary>
          <span>{{ turn.status === 'completed' ? `${t('ui.turnElapsed')} ${elapsed()}` : t('ui.finalAnswerStreaming') }}</span>
        </summary>
        <div class="turn-process-body">
          <template v-for="item in turn.processItems" :key="itemKey(item)">
            <ToolGroup v-if="item.kind === 'tool-group'" :tools="item.tools" />
            <TranscriptEntry v-else :entry="item.entry" />
          </template>
        </div>
      </details>
      <div v-else-if="turn.status === 'completed'" class="turn-duration">{{ t('ui.turnElapsed') }} {{ elapsed() }}</div>
      <TranscriptEntry v-if="turn.finalAnswer" :entry="turn.finalAnswer" />
    </template>
  </section>
</template>
