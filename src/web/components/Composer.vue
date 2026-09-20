<script setup lang="ts">
import { ref, watch } from "vue";
import { discardImage, uploadImage } from "../api.js";

const props = defineProps<{ busy: boolean; threadId?: string }>();
const emit = defineEmits<{ send: [text: string, imageIds: string[]]; stop: [] ; error: [message: string] }>();
const draft = ref("");
const images = ref<{ id: string; label: string; mediaType: string }[]>([]);
const uploading = ref(false);
const sending = ref(false);
const fileInput = ref<HTMLInputElement>();
watch(() => props.threadId, (next, previous) => {
  if (previous) localStorage.setItem(`easy-code-draft:${previous}`, draft.value);
  draft.value = next ? localStorage.getItem(`easy-code-draft:${next}`) ?? "" : "";
  images.value = [];
}, { immediate: true });
watch(draft, value => { if (props.threadId) localStorage.setItem(`easy-code-draft:${props.threadId}`, value); });

async function addFiles(files: FileList | File[] | null): Promise<void> {
  if (!files?.length) return;
  uploading.value = true;
  try {
    for (const file of Array.from(files)) images.value.push(await uploadImage(file));
  } catch (error) { emit("error", error instanceof Error ? error.message : String(error)); }
  finally { uploading.value = false; if (fileInput.value) fileInput.value.value = ""; }
}
function paste(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith("image/"));
  if (!files.length) return;
  event.preventDefault();
  void addFiles(files);
}
async function removeImage(id: string): Promise<void> {
  try {
    await discardImage(id);
    images.value = images.value.filter(image => image.id !== id);
  } catch (error) { emit("error", error instanceof Error ? error.message : String(error)); }
}
function send(): void {
  if (sending.value || uploading.value || (!draft.value.trim() && !images.value.length)) return;
  sending.value = true;
  emit("send", draft.value, images.value.map(image => image.id));
}
function sent(): void { draft.value = ""; images.value = []; sending.value = false; }
function failed(): void { sending.value = false; }
function keydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); }
}
defineExpose({ sent, failed });
</script>

<template>
  <div class="composer-wrap">
    <div class="composer">
      <div v-if="images.length" class="composer-images">
        <span v-for="image in images" :key="image.id" class="image-tag">▣ {{ image.label }} <button type="button" title="Remove from draft" @click="removeImage(image.id)">×</button></span>
      </div>
      <textarea v-model="draft" :placeholder="busy ? 'Adjust the current task…' : 'Ask EASY CODE anything…'" rows="3" @paste="paste" @keydown="keydown" />
      <div class="composer-bottom">
        <div class="composer-tools">
          <button type="button" class="icon-button" title="Attach images" :disabled="uploading" @click="fileInput?.click()">＋</button>
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden @change="addFiles(($event.target as HTMLInputElement).files)" />
          <span>{{ busy ? 'Adjustment will be applied at the next model boundary' : 'Ctrl+Enter to send' }}</span>
        </div>
        <div class="composer-actions">
          <button v-if="busy" class="ghost" type="button" @click="emit('stop')">Stop</button>
          <button type="button" :disabled="sending || uploading || (!draft.trim() && !images.length)" @click="send">{{ uploading ? 'Uploading…' : busy ? 'Adjust' : 'Send' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
