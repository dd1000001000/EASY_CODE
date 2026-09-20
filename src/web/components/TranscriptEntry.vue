<script setup lang="ts">
import type { WebEntry } from "../../web-contracts.js";
defineProps<{ entry: WebEntry }>();
</script>

<template>
  <article class="entry" :class="`entry--${entry.kind}`">
    <div v-if="entry.kind === 'user'" class="user-bubble">
      <div class="entry-text">{{ entry.text }}</div>
      <div v-if="entry.images?.length" class="entry-images">
        <span v-for="image in entry.images" :key="image.id" class="image-tag">▣ {{ image.label }}</span>
      </div>
    </div>
    <details v-else-if="entry.kind === 'thinking'" class="disclosure">
      <summary>Thinking</summary>
      <div class="entry-text disclosure-body">{{ entry.text }}</div>
    </details>
    <details v-else-if="entry.kind === 'tool'" class="disclosure tool-disclosure">
      <summary>{{ entry.text.split('\n', 1)[0] }}</summary>
      <div class="entry-text disclosure-body">{{ entry.text }}</div>
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
    <div v-else class="entry-text" :class="entry.kind === 'assistant' ? 'assistant-text' : 'notice-text'">{{ entry.text }}</div>
  </article>
</template>
