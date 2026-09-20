<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { ElButton, ElCard, ElImage, ElInput, ElScrollbar, ElTooltip } from "element-plus";
import { CaretBottom, Close, Document, Plus, Top, VideoPause } from "@element-plus/icons-vue";
import { discardImage, uploadImage } from "../api.js";
import { composeMessage, composerEnterAction, composerPrimaryAction, LONG_PASTE_THRESHOLD, matchingSlashCommands, MAX_MESSAGE_CHARACTERS, pastedTextPreview, type PastedText } from "../composer-content.js";
import type { WebDecision } from "../../web-contracts.js";
import type { WebCommandEntry } from "../../web-command-catalog.js";
import { useOutsideDismiss } from "../use-outside-dismiss.js";
import DecisionDialog from "./DecisionDialog.vue";

interface DraftImage { id: string; label: string; mediaType: string; previewUrl: string }
const props = defineProps<{ busy: boolean; threadId?: string; modelLabel: string; approvalLabel: string; orchestrationLabel: string; settingsDisabled: boolean; decision: WebDecision | null; commands: readonly WebCommandEntry[] }>();
const emit = defineEmits<{
  send: [text: string, imageIds: string[]]; stop: []; error: [message: string];
  selectModel: []; selectApproval: []; selectOrchestration: []; openCommand: [name: string]; submitDecision: [id: string, value: string | undefined];
}>();
const draft = ref("");
const images = ref<DraftImage[]>([]);
const imagesByThread = new Map<string, typeof images.value>();
const pastedTexts = ref<PastedText[]>([]);
const pastedTextsByThread = new Map<string, PastedText[]>();
let unboundDraft = "";
let unboundPastedTexts: PastedText[] = [];
const uploading = ref(false);
const sending = ref(false);
const composing = ref(false);
let lastCompositionEndAt = -Infinity;
const fileInput = ref<HTMLInputElement>();
const commandSuggestionsRoot = ref<{ $el: HTMLElement }>();
const dismissedCommandDraft = ref<string>();
const hasContent = computed(() => Boolean(draft.value.trim() || images.value.length || pastedTexts.value.length));
const showStopButton = computed(() => composerPrimaryAction(props.busy, hasContent.value) === "stop");
const previewUrls = computed(() => images.value.map(image => image.previewUrl));
const commandMatches = computed(() => props.threadId && !props.busy && !props.decision && draft.value !== dismissedCommandDraft.value
  ? props.commands.filter(command => matchingSlashCommands(draft.value, [command.name]).length > 0) : []);
useOutsideDismiss(commandSuggestionsRoot, () => { dismissedCommandDraft.value = draft.value; });
watch(() => props.threadId, (next, previous) => {
  if (previous) {
    localStorage.setItem(`easy-code-draft:${previous}`, draft.value);
    imagesByThread.set(previous, images.value);
    pastedTextsByThread.set(previous, pastedTexts.value);
  } else {
    unboundDraft = draft.value;
    unboundPastedTexts = pastedTexts.value;
  }
  const savedDraft = next ? localStorage.getItem(`easy-code-draft:${next}`) : null;
  const transferUnbound = Boolean(next && !previous && savedDraft === null);
  draft.value = next ? savedDraft ?? (transferUnbound ? unboundDraft : "") : unboundDraft;
  images.value = next ? imagesByThread.get(next) ?? [] : [];
  pastedTexts.value = next ? pastedTextsByThread.get(next) ?? (transferUnbound ? unboundPastedTexts : []) : unboundPastedTexts;
  if (transferUnbound) { unboundDraft = ""; unboundPastedTexts = []; }
  sending.value = false;
}, { immediate: true });
watch(draft, value => {
  dismissedCommandDraft.value = undefined;
  if (props.threadId) localStorage.setItem(`easy-code-draft:${props.threadId}`, value);
  else unboundDraft = value;
});

async function addFiles(files: FileList | File[] | null): Promise<void> {
  if (!props.threadId || !files?.length) return;
  const threadId = props.threadId;
  uploading.value = true;
  try {
    for (const file of Array.from(files)) {
      const image = await uploadImage(file, threadId);
      const list = imagesByThread.get(threadId) ?? (props.threadId === threadId ? images.value : []);
      imagesByThread.set(threadId, [...list, { ...image, previewUrl: URL.createObjectURL(file) }]);
      if (props.threadId === threadId) images.value = imagesByThread.get(threadId)!;
    }
  } catch (error) { emit("error", error instanceof Error ? error.message : String(error)); }
  finally { uploading.value = false; if (fileInput.value) fileInput.value.value = ""; }
}
function paste(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith("image/"));
  if (files.length) {
    event.preventDefault();
    if (props.threadId) void addFiles(files);
    else emit("error", "Open a conversation before attaching images.");
    return;
  }
  const content = event.clipboardData?.getData("text/plain") ?? "";
  if (content.length < LONG_PASTE_THRESHOLD) return;
  event.preventDefault();
  const next = [...pastedTexts.value, { id: crypto.randomUUID(), content }];
  if (composeMessage(draft.value, next).length > MAX_MESSAGE_CHARACTERS) {
    emit("error", "The message exceeds the 200,000-character limit.");
    return;
  }
  pastedTexts.value = next;
  if (props.threadId) pastedTextsByThread.set(props.threadId, next);
  else unboundPastedTexts = next;
}
async function removeImage(id: string): Promise<void> {
  try {
    if (!props.threadId) return;
    const threadId = props.threadId;
    await discardImage(id, threadId);
    const previous = imagesByThread.get(threadId) ?? images.value;
    const removed = previous.find(image => image.id === id);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    imagesByThread.set(threadId, previous.filter(image => image.id !== id));
    if (props.threadId !== threadId) return;
    images.value = images.value.filter(image => image.id !== id);
  } catch (error) { emit("error", error instanceof Error ? error.message : String(error)); }
}
function removeText(id: string): void {
  pastedTexts.value = pastedTexts.value.filter(item => item.id !== id);
  if (props.threadId) pastedTextsByThread.set(props.threadId, pastedTexts.value);
  else unboundPastedTexts = pastedTexts.value;
}
function send(): void {
  if (!props.threadId || props.decision || sending.value || uploading.value || !hasContent.value) return;
  const text = composeMessage(draft.value, pastedTexts.value);
  if (text.length > MAX_MESSAGE_CHARACTERS) { emit("error", "The message exceeds the 200,000-character limit."); return; }
  sending.value = true;
  emit("send", text, images.value.map(image => image.id));
}
function sent(threadId?: string): void {
  if (threadId) {
    localStorage.removeItem(`easy-code-draft:${threadId}`);
    for (const image of imagesByThread.get(threadId) ?? []) URL.revokeObjectURL(image.previewUrl);
    imagesByThread.delete(threadId);
    pastedTextsByThread.delete(threadId);
  }
  if (!threadId || props.threadId === threadId) { draft.value = ""; images.value = []; pastedTexts.value = []; sending.value = false; }
}
function failed(): void { sending.value = false; }
function keydown(event: Event | KeyboardEvent): void {
  if (!(event instanceof KeyboardEvent)) return;
  const action = composerEnterAction(event, composing.value, performance.now() - lastCompositionEndAt < 80);
  if (action === "none" || action === "newline") return;
  event.preventDefault();
  if (action === "send") send();
}
function compositionStart(): void { composing.value = true; lastCompositionEndAt = -Infinity; }
function compositionEnd(): void { composing.value = false; lastCompositionEndAt = performance.now(); }
function openCommand(name: string): void {
  if (/^\/[a-z0-9_-]*$/iu.test(draft.value)) draft.value = "";
  emit("openCommand", name);
}
onUnmounted(() => {
  for (const imageList of imagesByThread.values()) for (const image of imageList) URL.revokeObjectURL(image.previewUrl);
});
defineExpose({ sent, failed });
</script>

<template>
  <div class="composer-wrap">
    <div class="composer" :class="{ 'composer--unbound': !threadId }">
      <slot name="command-panel" />
      <DecisionDialog v-if="decision" :decision="decision" @submit="(id, value) => emit('submitDecision', id, value)" />
      <ElCard v-if="commandMatches.length" ref="commandSuggestionsRoot" class="composer-command-panel" shadow="always" aria-label="Matching commands">
        <ElScrollbar max-height="min(50vh, 360px)">
          <div class="composer-command-list">
            <ElButton v-for="command in commandMatches" :key="command.name" text @click="openCommand(command.name)"><strong>/{{ command.name }}</strong><span>{{ command.description }}</span></ElButton>
          </div>
        </ElScrollbar>
      </ElCard>
      <div v-if="images.length || pastedTexts.length" class="composer-attachments">
        <div v-for="image in images" :key="image.id" class="composer-image-card">
          <ElImage :src="image.previewUrl" :preview-src-list="previewUrls" fit="contain" :alt="image.label" />
          <ElButton class="attachment-remove" circle :icon="Close" :disabled="sending" :aria-label="`Remove ${image.label}`" @click="removeImage(image.id)" />
        </div>
        <div v-for="item in pastedTexts" :key="item.id" class="composer-text-card">
          <Document class="composer-text-icon" />
          <div><strong>Pasted text · {{ item.content.length }} chars</strong><span>{{ pastedTextPreview(item.content) }}</span></div>
          <ElButton class="attachment-remove" circle :icon="Close" :disabled="sending" aria-label="Remove pasted text" @click="removeText(item.id)" />
        </div>
      </div>
      <div @paste.capture="paste" @keydown="keydown" @compositionstart="compositionStart" @compositionend="compositionEnd"><ElInput v-model="draft" type="textarea" :autosize="{ minRows: 2, maxRows: 10 }" :placeholder="busy ? 'Adjust the current task…' : 'Ask EASY CODE anything…'" /></div>
      <div class="composer-bottom">
        <div class="composer-tools">
          <ElButton :icon="Plus" circle title="Attach images" aria-label="Attach images" :disabled="!threadId || uploading" @click="fileInput?.click()" />
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden :disabled="!threadId" @change="addFiles(($event.target as HTMLInputElement).files)" />
          <ElButton class="composer-setting composer-approval" text :disabled="settingsDisabled" @click="emit('selectApproval')"><span class="composer-setting-label">{{ approvalLabel }}</span><CaretBottom /></ElButton>
          <ElButton class="composer-setting composer-orchestration" text :disabled="settingsDisabled" @click="emit('selectOrchestration')"><span class="composer-setting-label">{{ orchestrationLabel }}</span><CaretBottom /></ElButton>
        </div>
        <div class="composer-actions">
          <ElButton class="composer-setting composer-model" text :disabled="settingsDisabled" @click="emit('selectModel')"><span class="composer-setting-label">{{ modelLabel }}</span><CaretBottom /></ElButton>
          <ElTooltip :content="showStopButton ? 'Stop current task' : busy ? 'Send adjustment' : 'Send message (Enter; Shift+Enter for newline)'" placement="top">
            <ElButton class="composer-submit" type="primary" circle :icon="showStopButton ? VideoPause : Top" :aria-label="showStopButton ? 'Stop current task' : busy ? 'Send adjustment' : 'Send message'" :disabled="!threadId || (!showStopButton && (!!decision || sending || uploading || !hasContent))" @click="showStopButton ? emit('stop') : send()" />
          </ElTooltip>
        </div>
      </div>
    </div>
  </div>
</template>
