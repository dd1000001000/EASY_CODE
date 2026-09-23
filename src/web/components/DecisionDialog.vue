<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ElButton, ElCard, ElInput, ElScrollbar, type InputInstance } from "element-plus";
import { Check } from "@element-plus/icons-vue";
import type { WebDecision } from "../../web-contracts.js";
import { useOutsideDismiss } from "../use-outside-dismiss.js";
import { t } from "../i18n.js";

const props = defineProps<{ decision: WebDecision }>();
const emit = defineEmits<{ submit: [id: string, value: string | undefined] }>();
const secret = ref("");
const feedback = ref("");
const secretInput = ref<InputInstance>();
const panelContent = ref<HTMLElement>();
const panelRoot = ref<{ $el: HTMLElement }>();
let submitted = false;
const choiceIds = computed(() => new Set(props.decision.choices?.map(choice => choice.id) ?? []));
const isApprovalModePicker = computed(() => props.decision.kind === "choice" &&
  ["manual", "auto_approve", "unrestricted"].every(id => choiceIds.value.has(id)));
const isOrchestrationPicker = computed(() => props.decision.kind === "choice" &&
  choiceIds.value.has("off") && choiceIds.value.has("on") && props.decision.choices?.length === 2);
const isModePicker = computed(() => props.decision.kind === "choice" &&
  ["plan", "auto", "code"].every(id => choiceIds.value.has(id)) && props.decision.choices?.length === 3);
const isSettingsPicker = computed(() => props.decision.kind === "choice" && (
  props.decision.title === "Select provider" || props.decision.title === "选择供应商" ||
  props.decision.title.startsWith("Select ") && props.decision.title.endsWith(" model") ||
  props.decision.title.startsWith("选择 ") && props.decision.title.endsWith(" 的模型") ||
  props.decision.title.startsWith("Thinking effort for ") ||
  props.decision.title.endsWith(" 的思考强度") ||
  isApprovalModePicker.value || isOrchestrationPicker.value || isModePicker.value
));
function submit(value: string | undefined): void {
  if (submitted) return;
  submitted = true;
  emit("submit", props.decision.id, value);
}
function cancel(): void { submit(undefined); }
useOutsideDismiss(panelRoot, cancel);
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
  <ElCard ref="panelRoot" class="composer-decision-panel" :class="{ 'composer-decision-panel--left': isApprovalModePicker, 'composer-decision-panel--orchestration': isOrchestrationPicker, 'composer-decision-panel--mode': isModePicker }" shadow="always"
    role="dialog" :aria-label="decision.title" @keydown.esc.stop.prevent="cancel">
    <template v-if="!isSettingsPicker" #header><div class="decision-header"><strong>{{ decision.title }}</strong></div></template>
    <ElScrollbar max-height="min(50vh, 360px)">
      <div ref="panelContent" class="decision-content">
        <p v-if="decision.description" class="entry-text decision-description">{{ decision.description }}</p>
        <form v-if="decision.kind === 'secret'" @submit.prevent="submit(secret)">
          <ElInput ref="secretInput" v-model="secret" type="password" autocomplete="off" :placeholder="t('ui.enterApiKey')" />
          <div class="decision-actions"><ElButton native-type="button" @click="cancel">{{ t('ui.cancel') }}</ElButton><ElButton type="primary" native-type="submit">{{ t('ui.save') }}</ElButton></div>
        </form>
        <template v-else>
          <ElInput v-if="decision.kind === 'plan'" v-model="feedback" type="textarea" :rows="3" :placeholder="t('ui.planFeedback')" />
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
