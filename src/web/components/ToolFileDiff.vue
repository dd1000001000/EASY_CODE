<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { ToolDiffRef, TurnFileDiff } from "../../ui/contracts.js";
import type { WebToolDiffResponse } from "../../web-contracts.js";
import { request } from "../api.js";
import { t } from "../i18n.js";
import FileDiffView from "./FileDiffView.vue";

/** Mounted only while the call is open, so each diff is fetched when it is first wanted. */
const props = defineProps<{ diffRef: ToolDiffRef; path: string }>();
const state = ref<{ status: "loading" } | { status: "ready"; diff: TurnFileDiff } | { status: "unavailable" }>({
  status: "loading",
});

onMounted(async () => {
  try {
    const query = new URLSearchParams({ ...props.diffRef });
    const { diff } = await request<WebToolDiffResponse>(`/api/tool-diff?${query}`);
    state.value = diff ? { status: "ready", diff } : { status: "unavailable" };
  } catch {
    state.value = { status: "unavailable" };
  }
});
</script>

<template>
  <FileDiffView v-if="state.status === 'ready'" class="tool-file-diff" :path="path" :diff="state.diff" />
  <p v-else class="file-diff-status" role="status">
    {{ state.status === "loading" ? t("ui.diffLoading") : t("ui.diffUnavailable") }}
  </p>
</template>
