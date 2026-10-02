<script setup lang="ts">
import { computed } from "vue";
import { CircleCheck, CircleClose, Loading } from "@element-plus/icons-vue";
import { t } from "../i18n.js";

const props = defineProps<{ status?: "running" | "completed" | "failed" }>();
const label = computed(() =>
  props.status === "running" ? t("ui.toolRunning") : props.status === "failed" ? t("ui.toolFailed") : t("ui.toolDone"),
);
</script>

<template>
  <span class="tool-status" :class="`tool-status--${status ?? 'completed'}`" role="img" :aria-label="label">
    <Loading v-if="status === 'running'" /><CircleClose v-else-if="status === 'failed'" /><CircleCheck v-else />
  </span>
</template>
