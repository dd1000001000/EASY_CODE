<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { compactionLabel, compactionRunning, type CompactionProgress } from "../../ui/compaction.js";
import { language } from "../i18n.js";

const props = defineProps<{ progress: CompactionProgress }>();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
watch(
  () => compactionRunning(props.progress),
  (running) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    now.value = Date.now();
    if (running)
      timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
  },
  { immediate: true },
);
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
const label = computed(() => compactionLabel(props.progress, language.value === "zh_cn", now.value));
</script>

<template>
  <article class="compaction-status" role="status" aria-live="polite">
    <p>{{ label }}</p>
    <p v-if="progress.reason" class="compaction-reason">{{ progress.reason }}</p>
  </article>
</template>

<style scoped>
.compaction-status {
  margin: 20px 0 24px;
  color: var(--ec-text-muted);
  font-size: 13px;
  line-height: 1.7;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.compaction-status p {
  margin: 0;
}
.compaction-status .compaction-reason {
  margin-top: 6px;
  color: var(--ec-text-subtle);
}
</style>
