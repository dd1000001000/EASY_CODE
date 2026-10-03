<script setup lang="ts">
import { ref } from "vue";
import type { WebEntry } from "../../web-contracts.js";
import MarkdownMessage from "./MarkdownMessage.vue";
import ToolFileDiff from "./ToolFileDiff.vue";
import ToolStatus from "./ToolStatus.vue";
import { toolTarget } from "../display-content.js";
import { t } from "../i18n.js";
defineProps<{ entry: WebEntry }>();
/** A tool's file change loads when its row is first opened. */
const toolOpen = ref(false);
function onToolToggle(event: Event): void {
  if (event.target instanceof HTMLDetailsElement) toolOpen.value = event.target.open;
}
function preview(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 120) || t("ui.receiving");
}
function characterCount(text: string): number {
  return Array.from(text).length;
}
</script>

<template>
  <article class="entry" :class="`entry--${entry.kind}`" :data-entry-id="entry.id">
    <div v-if="entry.kind === 'user'" class="user-bubble">
      <div class="entry-text">{{ entry.text }}</div>
      <div v-if="entry.images?.length" class="entry-images">
        <span v-for="image in entry.images" :key="image.id" class="image-tag">▣ {{ image.label }}</span>
      </div>
      <div v-if="entry.resources?.length" class="entry-images">
        <span v-for="resource in entry.resources" :key="resource.id" class="image-tag">▤ {{ resource.filename }}</span>
      </div>
    </div>
    <details v-else-if="entry.kind === 'thinking'" class="disclosure">
      <summary>
        <span class="disclosure-label"
          >{{ t("ui.thinking") }} · {{ characterCount(entry.text) }} {{ t("ui.chars") }}</span
        ><span class="disclosure-preview">{{ preview(entry.text) }}</span>
      </summary>
      <div class="entry-text disclosure-body">{{ entry.text }}</div>
    </details>
    <details v-else-if="entry.kind === 'tool'" class="disclosure tool-disclosure" @toggle="onToolToggle">
      <summary>
        <ToolStatus :status="entry.toolStatus" /><span class="disclosure-label">{{
          entry.toolName || t("ui.tool")
        }}</span
        ><span class="disclosure-preview">{{ toolTarget(entry) }}</span>
      </summary>
      <div class="entry-text disclosure-body">{{ entry.text }}</div>
      <dl v-if="entry.toolDetails?.length" class="tool-detail-list">
        <div v-for="(detail, index) in entry.toolDetails" :key="index">
          <dt>{{ detail.label }}</dt>
          <dd>{{ detail.value }}</dd>
        </div>
      </dl>
      <ToolFileDiff v-if="toolOpen && entry.toolDiff" :diff-ref="entry.toolDiff" :path="toolTarget(entry)" />
    </details>
    <details v-else-if="entry.kind === 'plan'" class="disclosure plan-disclosure" open>
      <summary>{{ t("ui.proposedPlan") }}</summary>
      <div class="entry-text disclosure-body">{{ entry.text }}</div>
    </details>
    <MarkdownMessage v-else-if="entry.kind === 'assistant'" class="entry-text assistant-text" :text="entry.text" />
    <div v-else class="entry-text notice-text">{{ entry.text }}</div>
  </article>
</template>
