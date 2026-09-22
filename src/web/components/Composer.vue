<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { ElButton, ElCard, ElImage, ElInput, ElScrollbar, ElTooltip } from "element-plus";
import { CaretBottom, Close, Document, Loading, Plus, Top, VideoPause } from "@element-plus/icons-vue";
import { discardImage, discardResource, uploadImage, uploadResource, type UploadedResource } from "../api.js";
import { composeMessage, composerEnterAction, composerPrimaryAction, LONG_PASTE_THRESHOLD, matchingSlashCommands, MAX_MESSAGE_CHARACTERS, pastedTextPreview, type PastedText } from "../composer-content.js";
import type { WebDecision } from "../../web-contracts.js";
import type { WebCommandEntry } from "../../web-command-catalog.js";
import { useOutsideDismiss } from "../use-outside-dismiss.js";
import { t } from "../i18n.js";
import DecisionDialog from "./DecisionDialog.vue";

interface DraftImage { id: string; label: string; mediaType: string; previewUrl: string }
type DraftResource = (UploadedResource & { key: string; status: "ready" }) | {
  key: string; status: "uploading"; filename: string; mediaType: string; byteSize: number;
};
const props = defineProps<{ busy: boolean; threadId?: string; modelLabel: string; approvalLabel: string; orchestrationLabel: string; settingsDisabled: boolean; decision: WebDecision | null; commands: readonly WebCommandEntry[] }>();
const emit = defineEmits<{
  send: [text: string, imageIds: string[], resourceIds: string[]]; stop: []; error: [message: string];
  selectModel: []; selectApproval: []; selectOrchestration: []; openCommand: [name: string]; submitDecision: [id: string, value: string | undefined];
}>();
const draft = ref("");
const images = ref<DraftImage[]>([]);
const imagesByThread = new Map<string, typeof images.value>();
const resources = ref<DraftResource[]>([]);
const resourcesByThread = new Map<string, DraftResource[]>();
const pastedTexts = ref<PastedText[]>([]);
const pastedTextsByThread = new Map<string, PastedText[]>();
let unboundDraft = "";
let unboundPastedTexts: PastedText[] = [];
const pendingUploadCount = ref(0);
const uploading = computed(() => pendingUploadCount.value > 0);
const sending = ref(false);
const composing = ref(false);
let lastCompositionEndAt = -Infinity;
const fileInput = ref<HTMLInputElement>();
const commandSuggestionsRoot = ref<{ $el: HTMLElement }>();
const dismissedCommandDraft = ref<string>();
const hasContent = computed(() => Boolean(draft.value.trim() || images.value.length || resources.value.length || pastedTexts.value.length));
const showStopButton = computed(() => composerPrimaryAction(props.busy, hasContent.value) === "stop");
const previewUrls = computed(() => images.value.map(image => image.previewUrl));
const commandMatches = computed(() => props.threadId && !props.busy && !props.decision && draft.value !== dismissedCommandDraft.value
  ? props.commands.filter(command => matchingSlashCommands(draft.value, [command.name]).length > 0) : []);
useOutsideDismiss(commandSuggestionsRoot, () => { dismissedCommandDraft.value = draft.value; });
watch(() => props.threadId, (next, previous) => {
  if (previous) {
    localStorage.setItem(`easy-code-draft:${previous}`, draft.value);
    imagesByThread.set(previous, images.value);
    resourcesByThread.set(previous, resources.value);
    pastedTextsByThread.set(previous, pastedTexts.value);
  } else {
    unboundDraft = draft.value;
    unboundPastedTexts = pastedTexts.value;
  }
  const savedDraft = next ? localStorage.getItem(`easy-code-draft:${next}`) : null;
  const transferUnbound = Boolean(next && !previous && savedDraft === null);
  draft.value = next ? savedDraft ?? (transferUnbound ? unboundDraft : "") : unboundDraft;
  images.value = next ? imagesByThread.get(next) ?? [] : [];
  resources.value = next ? resourcesByThread.get(next) ?? [] : [];
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
  const selected = Array.from(files);
  let completed = 0;
  pendingUploadCount.value += selected.length;
  try {
    for (const file of selected) {
      if (file.type.startsWith("image/")) {
        const image = await uploadImage(file, threadId);
        const list = imagesByThread.get(threadId) ?? (props.threadId === threadId ? images.value : []);
        imagesByThread.set(threadId, [...list, { ...image, previewUrl: URL.createObjectURL(file) }]);
        if (props.threadId === threadId) images.value = imagesByThread.get(threadId)!;
      } else {
        const key = `upload-${crypto.randomUUID()}`;
        const list = resourcesByThread.get(threadId) ?? (props.threadId === threadId ? resources.value : []);
        resourcesByThread.set(threadId, [...list, {
          key, status: "uploading", filename: file.name, mediaType: file.type || "application/octet-stream", byteSize: file.size,
        }]);
        if (props.threadId === threadId) resources.value = resourcesByThread.get(threadId)!;
        // Give Vue and the browser a paint opportunity before conversion starts.
        await nextTick();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        try {
          const resource = await uploadResource(file, threadId);
          const current = resourcesByThread.get(threadId) ?? [];
          resourcesByThread.set(threadId, current.map(item => item.key === key
            ? { ...resource, key, status: "ready" as const }
            : item));
          if (props.threadId === threadId) resources.value = resourcesByThread.get(threadId)!;
        } catch (error) {
          const current = resourcesByThread.get(threadId) ?? [];
          resourcesByThread.set(threadId, current.filter(item => item.key !== key));
          if (props.threadId === threadId) resources.value = resourcesByThread.get(threadId)!;
          throw error;
        }
      }
      pendingUploadCount.value -= 1;
      completed += 1;
    }
  } catch (error) { emit("error", error instanceof Error ? error.message : String(error)); }
  finally {
    // A failed item stops this batch, so release it and every unprocessed item.
    pendingUploadCount.value = Math.max(0, pendingUploadCount.value - (selected.length - completed));
    if (fileInput.value) fileInput.value.value = "";
  }
}
function paste(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length) {
    event.preventDefault();
    if (props.threadId) void addFiles(files);
    else emit("error", t("ui.noThreadImage"));
    return;
  }
  const content = event.clipboardData?.getData("text/plain") ?? "";
  if (content.length < LONG_PASTE_THRESHOLD) return;
  event.preventDefault();
  const next = [...pastedTexts.value, { id: crypto.randomUUID(), content }];
  if (composeMessage(draft.value, next).length > MAX_MESSAGE_CHARACTERS) {
    emit("error", t("ui.tooLong"));
    return;
  }
  pastedTexts.value = next;
  if (props.threadId) pastedTextsByThread.set(props.threadId, next);
  else unboundPastedTexts = next;
}
async function removeResource(id: string): Promise<void> {
  try {
    if (!props.threadId) return;
    const threadId = props.threadId;
    await discardResource(id, threadId);
    const previous = resourcesByThread.get(threadId) ?? resources.value;
    resourcesByThread.set(threadId, previous.filter(resource => resource.status !== "ready" || resource.id !== id));
    if (props.threadId === threadId) resources.value = resourcesByThread.get(threadId)!;
  } catch (error) { emit("error", error instanceof Error ? error.message : String(error)); }
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
  if (text.length > MAX_MESSAGE_CHARACTERS) { emit("error", t("ui.tooLong")); return; }
  sending.value = true;
  emit("send", text, images.value.map(image => image.id), resources.value
    .filter((resource): resource is UploadedResource & { key: string; status: "ready" } => resource.status === "ready")
    .map(resource => resource.id));
}
function sent(threadId?: string): void {
  if (threadId) {
    localStorage.removeItem(`easy-code-draft:${threadId}`);
    for (const image of imagesByThread.get(threadId) ?? []) URL.revokeObjectURL(image.previewUrl);
    imagesByThread.delete(threadId);
    resourcesByThread.delete(threadId);
    pastedTextsByThread.delete(threadId);
  }
  if (!threadId || props.threadId === threadId) { draft.value = ""; images.value = []; resources.value = []; pastedTexts.value = []; sending.value = false; }
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
      <ElCard v-if="commandMatches.length" ref="commandSuggestionsRoot" class="composer-command-panel" shadow="always" :aria-label="t('ui.matchingCommands')">
        <ElScrollbar max-height="min(50vh, 360px)">
          <div class="composer-command-list">
            <ElButton v-for="command in commandMatches" :key="command.name" text @click="openCommand(command.name)"><strong>/{{ command.name }}</strong><span>{{ t(`command.${command.name}` as import('../../i18n/catalog.js').MessageKey) }}</span></ElButton>
          </div>
        </ElScrollbar>
      </ElCard>
      <Transition name="composer-attachment-tray">
        <div v-if="images.length || resources.length || pastedTexts.length" class="composer-attachment-tray">
          <TransitionGroup name="composer-attachment" tag="div" class="composer-attachments">
            <div v-for="image in images" :key="`image-${image.id}`" class="composer-image-card">
              <ElImage :src="image.previewUrl" :preview-src-list="previewUrls" fit="contain" :alt="image.label" />
              <ElButton class="attachment-remove" circle :icon="Close" :disabled="sending" :aria-label="t('ui.removeNamedImage', { name: image.label })" @click="removeImage(image.id)" />
            </div>
            <div v-for="resource in resources" :key="resource.key" class="composer-text-card" :class="{ 'composer-text-card--uploading': resource.status === 'uploading' }">
              <Loading v-if="resource.status === 'uploading'" class="composer-text-icon composer-upload-spinner" />
              <Document v-else class="composer-text-icon" />
              <div><strong>{{ resource.filename }}</strong><span>{{ Math.max(1, Math.ceil(resource.byteSize / 1024)) }} KB · {{ resource.status === "uploading" ? t('ui.preparingResource') : t('ui.readOnlyResource') }}</span></div>
              <ElButton v-if="resource.status === 'ready'" class="attachment-remove" circle :icon="Close" :disabled="sending" :aria-label="t('ui.removeResource')" @click="removeResource(resource.id)" />
            </div>
            <div v-for="item in pastedTexts" :key="`text-${item.id}`" class="composer-text-card">
              <Document class="composer-text-icon" />
              <div><strong>{{ t('ui.pastedText') }} · {{ item.content.length }} {{ t('ui.chars') }}</strong><span>{{ pastedTextPreview(item.content) }}</span></div>
              <ElButton class="attachment-remove" circle :icon="Close" :disabled="sending" :aria-label="t('ui.removeText')" @click="removeText(item.id)" />
            </div>
          </TransitionGroup>
        </div>
      </Transition>
      <div @paste.capture="paste" @keydown="keydown" @compositionstart="compositionStart" @compositionend="compositionEnd"><ElInput v-model="draft" type="textarea" :autosize="{ minRows: 2, maxRows: 10 }" :placeholder="busy ? t('ui.adjustTask') : t('ui.askAnything')" /></div>
      <div class="composer-bottom">
        <div class="composer-tools">
          <ElButton :icon="Plus" circle :title="t('ui.attachFiles')" :aria-label="t('ui.attachFiles')" :disabled="!threadId || uploading" @click="fileInput?.click()" />
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.docx,.pptx,.xls,.xlsx,.csv,.txt,.md,.markdown,.html,.htm,.xml,.json,.yaml,.yml" multiple hidden :disabled="!threadId" @change="addFiles(($event.target as HTMLInputElement).files)" />
          <ElButton class="composer-setting composer-approval" text :disabled="settingsDisabled" @click="emit('selectApproval')"><span class="composer-setting-label">{{ approvalLabel }}</span><CaretBottom /></ElButton>
          <ElButton class="composer-setting composer-orchestration" text :disabled="settingsDisabled" @click="emit('selectOrchestration')"><span class="composer-setting-label">{{ orchestrationLabel }}</span><CaretBottom /></ElButton>
        </div>
        <div class="composer-actions">
          <ElButton class="composer-setting composer-model" text :disabled="settingsDisabled" @click="emit('selectModel')"><span class="composer-setting-label">{{ modelLabel }}</span><CaretBottom /></ElButton>
          <ElTooltip :content="showStopButton ? t('ui.stopTask') : busy ? t('ui.sendAdjustment') : t('ui.sendHint')" placement="top">
            <ElButton class="composer-submit" type="primary" circle :icon="showStopButton ? VideoPause : Top" :aria-label="showStopButton ? t('ui.stopTask') : busy ? t('ui.sendAdjustment') : t('ui.sendMessage')" :disabled="!threadId || (!showStopButton && (!!decision || sending || uploading || !hasContent))" @click="showStopButton ? emit('stop') : send()" />
          </ElTooltip>
        </div>
      </div>
    </div>
  </div>
</template>
