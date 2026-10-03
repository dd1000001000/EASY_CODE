<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { ElButton, ElCard, ElInput, ElScrollbar } from "element-plus";
import { Check } from "@element-plus/icons-vue";
import type { UserQuestion } from "../../core/types.js";
import { USER_ANSWER_MAX_CHARS } from "../../core/user-questions.js";
import type { WebDecision } from "../../web-contracts.js";
import {
  chooseOption,
  draftAnswered,
  formatRemaining,
  questionTitle,
  type QuestionDraft,
} from "../../ui/user-questions.js";
import { language, t } from "../i18n.js";

const props = defineProps<{ decision: WebDecision }>();
const emit = defineEmits<{ submit: [id: string, value: string | undefined] }>();

const questions = computed<readonly UserQuestion[]>(() => props.decision.questions ?? []);
const page = ref(0);
const selections = ref<string[][]>([]);
/** The user's own text per question, kept as typed; trimmed only when submitted. */
const texts = ref<string[]>([]);
const now = ref(Date.now());
let submitted = false;
const clock = setInterval(() => (now.value = Date.now()), 1000);
onUnmounted(() => clearInterval(clock));

watch(
  () => props.decision.id,
  () => {
    submitted = false;
    page.value = 0;
    selections.value = questions.value.map(() => []);
    texts.value = questions.value.map(() => "");
  },
  { immediate: true },
);

const current = computed(() => questions.value[page.value]);
function draft(index: number): QuestionDraft {
  return { selected: selections.value[index] ?? [], custom: texts.value[index]?.trim() || null };
}
const answered = computed(() => questions.value.map((question, index) => draftAnswered(question, draft(index))));
const complete = computed(() => answered.value.length > 0 && answered.value.every(Boolean));
const title = computed(() => questionTitle(language.value, questions.value, page.value));
const remaining = computed(() =>
  props.decision.expiresAt === undefined ? undefined : formatRemaining(props.decision.expiresAt - now.value),
);

function finish(value: string): void {
  if (submitted) return;
  submitted = true;
  emit("submit", props.decision.id, value);
}
function submit(): void {
  if (!complete.value) return;
  finish(`answer:${JSON.stringify(questions.value.map((_question, index) => draft(index)))}`);
}
function skip(): void {
  finish("skip");
}
function choose(label: string): void {
  const question = current.value;
  if (!question) return;
  const next = chooseOption(question, draft(page.value), label);
  selections.value = selections.value.map((items, index) => (index === page.value ? [...next.selected] : items));
  if (question.multiSelect) return;
  // A chosen option replaces the user's own text for a single-choice question.
  texts.value = texts.value.map((text, index) => (index === page.value ? "" : text));
  if (questions.value.length === 1) return submit();
  const open = answered.value.findIndex((done, index) => !done && index !== page.value);
  if (open >= 0) page.value = open;
}
function typed(value: string): void {
  texts.value = texts.value.map((text, index) => (index === page.value ? value : text));
  if (!current.value?.multiSelect && value.trim()) {
    selections.value = selections.value.map((items, index) => (index === page.value ? [] : items));
  }
}
</script>

<template>
  <ElCard class="composer-decision-panel question-panel" shadow="always" role="dialog" :aria-label="title">
    <template #header
      ><div class="decision-header question-header">
        <strong>{{ title }}</strong>
        <span v-if="remaining" class="question-countdown">{{ t("ui.askExpiresIn", { time: remaining }) }}</span>
      </div></template
    >
    <ElScrollbar max-height="min(60vh, 460px)">
      <div class="decision-content">
        <div v-if="questions.length > 1" class="question-steps" role="tablist">
          <button
            v-for="(question, index) in questions"
            :key="index"
            type="button"
            role="tab"
            class="question-step"
            :class="{ 'is-current': index === page, 'is-answered': answered[index] }"
            :aria-selected="index === page"
            @click="page = index"
          >
            <Check v-if="answered[index]" class="question-step-icon" />{{ question.header }}
          </button>
        </div>
        <template v-if="current">
          <p class="entry-text question-text">{{ current.question }}</p>
          <p v-if="current.multiSelect" class="question-note">{{ t("ui.askChooseAny") }}</p>
          <div class="decision-options">
            <ElButton
              v-for="option in current.options"
              :key="option.label"
              class="decision-option"
              :class="{ 'is-selected': (selections[page] ?? []).includes(option.label) }"
              :aria-pressed="(selections[page] ?? []).includes(option.label)"
              text
              @click="choose(option.label)"
            >
              <span class="decision-option-copy"
                ><strong>{{ option.label }}</strong
                ><small v-if="option.description">{{ option.description }}</small></span
              >
              <Check v-if="(selections[page] ?? []).includes(option.label)" class="decision-selected-icon" />
            </ElButton>
          </div>
          <ElInput
            class="question-other"
            :model-value="texts[page] ?? ''"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 4 }"
            :maxlength="USER_ANSWER_MAX_CHARS"
            :placeholder="t('ui.askOtherLabel') + t('ui.askOtherPlaceholder')"
            :aria-label="t('ui.askOtherPrompt')"
            @update:model-value="typed"
          />
        </template>
        <div class="decision-actions">
          <ElButton native-type="button" @click="skip">{{ t("ui.askSkip") }}</ElButton
          ><ElButton type="primary" native-type="button" :disabled="!complete" @click="submit">{{
            t("ui.askSubmit")
          }}</ElButton>
        </div>
      </div>
    </ElScrollbar>
  </ElCard>
</template>
