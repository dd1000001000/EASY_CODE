<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ElButton, ElCard, ElInput, ElScrollbar, type InputInstance } from "element-plus";
import { Check, Close } from "@element-plus/icons-vue";
import type { WebDecision } from "../../web-contracts.js";

const props = defineProps<{ decision: WebDecision }>();
const emit = defineEmits<{ submit: [id: string, value: string | undefined] }>();
const secret = ref("");
const feedback = ref("");
const secretInput = ref<InputInstance>();
const panelContent = ref<HTMLElement>();
const panelRoot = ref<{ $el: HTMLElement }>();
let submitted = false;
const isApprovalModePicker = computed(() => props.decision.title === "Select command execution mode");
const isOrchestrationPicker = computed(() => props.decision.title === "DAG and subagent creation (reviewer stays enabled)");
const isSettingsPicker = computed(() => props.decision.kind === "choice" && (
  props.decision.title === "Select provider" ||
  props.decision.title.startsWith("Select ") && props.decision.title.endsWith(" model") ||
  props.decision.title.startsWith("Thinking effort for ") ||
  isApprovalModePicker.value || isOrchestrationPicker.value
));
function submit(value: string | undefined): void {
  if (submitted) return;
  submitted = true;
  emit("submit", props.decision.id, value);
}
function cancel(): void { submit(undefined); }
function outsidePointer(event: PointerEvent): void {
  if (isSettingsPicker.value && panelRoot.value && !panelRoot.value.$el.contains(event.target as Node)) cancel();
}
onMounted(() => document.addEventListener("pointerdown", outsidePointer, true));
onUnmounted(() => document.removeEventListener("pointerdown", outsidePointer, true));
watch(() => props.decision.id, async () => {
  submitted = false;
  secret.value = "";
  feedback.value = "";
  await nextTick();
  if (props.decision.kind === "secret") secretInput.value?.focus();
  else (panelContent.value?.querySelector(".decision-option.is-selected, .decision-option:not(:disabled)") as HTMLButtonElement | null)?.focus();
}, { immediate: true });
function choose(value: string): void {
  if (value === "adjust") {
    if (!feedback.value.trim()) return;
    submit(`adjust:${feedback.value.trim()}`);
  } else submit(value);
}
</script>

<template>
  <ElCard ref="panelRoot" class="composer-decision-panel" :class="{ 'composer-decision-panel--left': isApprovalModePicker, 'composer-decision-panel--orchestration': isOrchestrationPicker }" shadow="always"
    role="dialog" :aria-label="decision.title" @keydown.esc.stop.prevent="cancel">
    <template v-if="!isSettingsPicker" #header><div class="decision-header"><strong>{{ decision.title }}</strong><ElButton text circle :icon="Close" aria-label="Cancel selection" @click="cancel" /></div></template>
    <ElScrollbar max-height="min(50vh, 360px)">
      <div ref="panelContent" class="decision-content">
        <p v-if="decision.description" class="entry-text decision-description">{{ decision.description }}</p>
        <form v-if="decision.kind === 'secret'" @submit.prevent="submit(secret)">
          <ElInput ref="secretInput" v-model="secret" type="password" autocomplete="off" placeholder="Enter API key" />
          <div class="decision-actions"><ElButton native-type="button" @click="cancel">Cancel</ElButton><ElButton type="primary" native-type="submit">Save</ElButton></div>
        </form>
        <template v-else>
          <ElInput v-if="decision.kind === 'plan'" v-model="feedback" type="textarea" :rows="3" placeholder="Feedback if requesting changes" />
          <div class="decision-options">
            <ElButton v-for="choice in decision.choices" :key="choice.id" class="decision-option"
              :class="{ 'is-selected': choice.id === decision.initialId }"
              :disabled="choice.disabled || (choice.id === 'adjust' && !feedback.trim())"
              :type="choice.id === 'reject' ? 'danger' : 'default'" text @click="choose(choice.id)">
              <span class="decision-option-copy"><strong>{{ choice.label }}</strong><small v-if="choice.detail">{{ choice.detail }}</small></span>
              <Check v-if="choice.id === decision.initialId" class="decision-selected-icon" />
            </ElButton>
          </div>
        </template>
      </div>
    </ElScrollbar>
  </ElCard>
</template>
