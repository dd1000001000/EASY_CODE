<script setup lang="ts">
import { computed } from "vue";
import { formatTokenCount } from "../../cli/token-count.js";
import { contextUsageRows, formatShare } from "../../ui/context-usage.js";
import type { ContextUsageReport } from "../../ui/contracts.js";
import { t } from "../i18n.js";

const props = defineProps<{ report: ContextUsageReport }>();

const view = computed(() => contextUsageRows(props.report));
const share = computed(() => Math.round((view.value.used / Math.max(1, props.report.windowTokens)) * 100));
</script>

<template>
  <section class="context-panel" role="dialog" :aria-label="t('ui.contextWindow')">
    <header class="context-panel-head">
      <span>{{ t("ui.contextWindow") }}</span>
      <span class="context-panel-total">
        {{ formatTokenCount(view.used) }} / {{ formatTokenCount(report.windowTokens) }} ({{ share }}%)
      </span>
    </header>
    <div class="context-panel-bar" aria-hidden="true">
      <span
        v-for="row in view.rows.filter((item) => item.id !== 'free')"
        :key="row.id"
        :class="`is-${row.id}`"
        :style="{ width: `${row.ratio * 100}%` }"
      ></span>
    </div>
    <ul class="context-panel-rows">
      <li v-for="row in view.rows" :key="row.id">
        <span class="context-panel-swatch" :class="`is-${row.id}`" aria-hidden="true"></span>
        <span class="context-panel-label">{{ t(row.label) }}</span>
        <span class="context-panel-tokens">{{ formatTokenCount(row.tokens) }}</span>
        <span class="context-panel-share">{{ formatShare(row.ratio) }}</span>
      </li>
    </ul>
    <p class="context-panel-note">
      {{ t("ui.contextCompactsAt", { tokens: formatTokenCount(report.compactionTokens) }) }}
    </p>
    <p v-if="!report.measured" class="context-panel-note">{{ t("ui.contextNotMeasured") }}</p>
  </section>
</template>
