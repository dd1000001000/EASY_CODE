<script setup lang="ts">
import { computed } from "vue";
import { compactionLabel, compactionRunning, type CompactionProgress } from "../../ui/compaction.js";
import { language } from "../i18n.js";

const props = defineProps<{ progress: CompactionProgress }>();
const running = computed(() => compactionRunning(props.progress));
const label = computed(() => compactionLabel(props.progress, language.value === "zh_cn"));
</script>

<template>
  <section class="compaction-status" role="status" aria-live="polite">
    <div class="compaction-row">
      <div class="compaction-track" :class="{ 'compaction-track--running': running, 'compaction-track--failed': !running && progress.phase !== 'completed' }"
        role="progressbar" :aria-label="label" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="progress.phase === 'completed' ? 100 : undefined">
        <span />
      </div>
      <span>{{ label }}</span>
    </div>
    <small v-if="progress.reason">{{ progress.reason }}</small>
  </section>
</template>

<style scoped>
.compaction-status { padding: 12px 18px; font-size: 13px; }
.compaction-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.compaction-track { width: 140px; height: 6px; overflow: hidden; border-radius: 4px; background: var(--el-fill-color-darker); }
.compaction-track span { display: block; width: 100%; height: 100%; background: var(--el-color-success); }
.compaction-track--running span { width: 35%; background: var(--el-color-primary); animation: compact-slide 1.4s ease-in-out infinite; }
.compaction-track--failed span { background: var(--el-color-warning); }
small { display: block; margin-top: 5px; color: var(--el-text-color-secondary); }
@keyframes compact-slide { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
@media (prefers-reduced-motion: reduce) { .compaction-track--running span { animation: none; width: 50%; } }
</style>
