<script setup lang="ts">
import type { WebHistoryMarker } from "../../web-contracts.js";
import { ElTooltip } from "element-plus";
import { t } from "../i18n.js";

defineProps<{ markers: readonly WebHistoryMarker[]; visibleIds: ReadonlySet<string> }>();
const emit = defineEmits<{ navigate: [id: string] }>();
</script>

<template>
  <nav v-if="markers.length" class="message-rail" :aria-label="t('ui.yourMessages')">
    <ElTooltip v-for="marker in markers" :key="marker.id" placement="right" :show-after="250" popper-class="rail-tooltip">
      <template #content><strong>{{ t('ui.you') }}</strong><span>{{ marker.preview }}</span></template>
      <button type="button" class="message-marker"
        :class="{ 'message-marker--visible': visibleIds.has(marker.id) }"
        :aria-label="t('ui.jumpMessage', { preview: marker.preview })"
        :aria-current="visibleIds.has(marker.id) ? 'location' : undefined"
        @click="emit('navigate', marker.id)"><span class="message-marker-line"></span></button>
    </ElTooltip>
  </nav>
</template>
