<script setup lang="ts">
import type { WebEntry } from "../../web-contracts.js";
import MarkdownMessage from "./MarkdownMessage.vue";
defineProps<{ entry: WebEntry }>();
function preview(text: string): string { return text.replace(/\s+/gu, " ").trim().slice(0, 120) || "Receiving…"; }
function characterCount(text: string): number { return Array.from(text).length; }
</script>

<template>
  <article class="entry" :class="`entry--${entry.kind}`" :data-entry-id="entry.id">
    <div v-if="entry.kind === 'user'" class="user-bubble">
      <div class="entry-text">{{ entry.text }}</div>
      <div v-if="entry.images?.length" class="entry-images">
        <span v-for="image in entry.images" :key="image.id" class="image-tag">▣ {{ image.label }}</span>
      </div>
    </div>
    <details v-else-if="entry.kind === 'thinking'" class="disclosure">
      <summary><span class="disclosure-label">Thinking · {{ characterCount(entry.text) }} chars</span><span class="disclosure-preview">{{ preview(entry.text) }}</span></summary>
      <div class="entry-text disclosure-body">{{ entry.text }}</div>
    </details>
    <details v-else-if="entry.kind === 'tool'" class="disclosure tool-disclosure">
      <summary><span class="disclosure-label">Tool · {{ characterCount(entry.text) }} chars</span><span class="disclosure-preview">{{ preview(entry.text) }}</span></summary>
      <div class="entry-text disclosure-body">{{ entry.text }}</div>
      <dl v-if="entry.toolDetails?.length" class="tool-detail-list">
        <div v-for="(detail, index) in entry.toolDetails" :key="index">
          <dt>{{ detail.label }}</dt><dd>{{ detail.value }}</dd>
        </div>
      </dl>
    </details>
    <details v-else-if="entry.kind === 'diff' && entry.diff" class="disclosure tool-disclosure">
      <summary>{{ entry.text }}</summary>
      <div class="diff-grid">
        <section><h4>Before</h4><pre>{{ entry.diff.before }}</pre></section>
        <section><h4>After</h4><pre>{{ entry.diff.after }}</pre></section>
      </div>
    </details>
    <details v-else-if="entry.kind === 'plan'" class="disclosure plan-disclosure" open>
      <summary>Proposed plan</summary>
      <div class="entry-text disclosure-body">{{ entry.text }}</div>
    </details>
    <MarkdownMessage v-else-if="entry.kind === 'assistant'" class="entry-text assistant-text" :text="entry.text" />
    <div v-else class="entry-text notice-text">{{ entry.text }}</div>
  </article>
</template>
