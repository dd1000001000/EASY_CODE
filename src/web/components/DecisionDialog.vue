<script setup lang="ts">
import { ref, watch } from "vue";
import type { WebDecision } from "../../web-contracts.js";

const props = defineProps<{ decision: WebDecision }>();
const emit = defineEmits<{ submit: [id: string, value: string | undefined] }>();
const secret = ref("");
const feedback = ref("");
watch(() => props.decision.id, () => { secret.value = ""; feedback.value = ""; });
function choose(value: string): void {
  if (value === "adjust") {
    if (!feedback.value.trim()) return;
    emit("submit", props.decision.id, `adjust:${feedback.value.trim()}`);
  } else emit("submit", props.decision.id, value);
}
</script>

<template>
  <div class="modal-backdrop">
    <section class="decision-dialog" role="dialog" aria-modal="true" :aria-label="decision.title">
      <h2>{{ decision.title }}</h2>
      <p v-if="decision.description" class="entry-text decision-description">{{ decision.description }}</p>
      <form v-if="decision.kind === 'secret'" @submit.prevent="emit('submit', decision.id, secret)">
        <input v-model="secret" type="password" autocomplete="off" autofocus placeholder="Enter API key" />
        <div class="decision-actions"><button type="button" class="ghost" @click="emit('submit', decision.id, undefined)">Cancel</button><button type="submit">Save</button></div>
      </form>
      <template v-else>
        <textarea v-if="decision.kind === 'plan'" v-model="feedback" placeholder="Feedback if requesting changes" rows="3" />
        <div class="decision-options">
          <button v-for="choice in decision.choices" :key="choice.id" type="button" :disabled="choice.disabled || (choice.id === 'adjust' && !feedback.trim())"
            :class="choice.id === 'reject' ? 'danger ghost' : 'ghost'" @click="choose(choice.id)">
            <strong>{{ choice.label }}</strong><small v-if="choice.detail">{{ choice.detail }}</small>
          </button>
        </div>
        <button type="button" class="plain-link" @click="emit('submit', decision.id, undefined)">Cancel</button>
      </template>
    </section>
  </div>
</template>
