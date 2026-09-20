<script setup lang="ts">
import type { WebHistoryMarker } from "../../web-contracts.js";
import { ElTooltip } from "element-plus";

defineProps<{ markers: readonly WebHistoryMarker[]; visibleIds: ReadonlySet<string> }>();
const emit = defineEmits<{ navigate: [id: string] }>();
</script>

<template>
  <nav v-if="markers.length" class="message-rail" aria-label="Your messages">
    <ElTooltip v-for="marker in markers" :key="marker.id" placement="right" :show-after="250" popper-class="rail-tooltip">
      <template #content><strong>You</strong><span>{{ marker.preview }}</span></template>
      <button type="button" class="message-marker"
        :class="{ 'message-marker--visible': visibleIds.has(marker.id) }"
        :aria-label="`Jump to your message: ${marker.preview}`"
        :aria-current="visibleIds.has(marker.id) ? 'location' : undefined"
        @click="emit('navigate', marker.id)"><span class="message-marker-line"></span></button>
    </ElTooltip>
  </nav>
</template>
