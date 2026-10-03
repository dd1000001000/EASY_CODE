<script setup lang="ts">
defineProps<{
  /** Shown on hover and read by screen readers. */
  label: string;
}>();
</script>

<template>
  <span class="status-alert" role="img" :title="label" :aria-label="label">
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M7.13 1.98a1 1 0 0 1 1.74 0l6.46 11.02a1 1 0 0 1-.87 1.5H1.54a1 1 0 0 1-.87-1.5z" fill="currentColor" />
      <path d="M8 5.6v4.1" stroke="#fff" stroke-width="1.7" stroke-linecap="round" />
      <circle cx="8" cy="12.1" r="0.95" fill="#fff" />
    </svg>
  </span>
</template>
