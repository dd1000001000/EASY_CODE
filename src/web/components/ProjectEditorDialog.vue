<script setup lang="ts">
import { ref, watch } from "vue";
import { ElButton, ElDialog, ElInput } from "element-plus";
import { Close, Folder, Plus } from "@element-plus/icons-vue";
import { request, type ProjectItem } from "../api.js";
import { errorMessage } from "../errors.js";
import { t } from "../i18n.js";

interface EditorFolder {
  clientId: string;
  folderId?: string;
  key: string;
  path: string;
}
interface EditorDraft {
  name: string;
  folders: EditorFolder[];
  primaryClientId?: string;
}

const props = defineProps<{
  /** The project being edited; the dialog is open while it is set. */
  project: ProjectItem | null;
  running: boolean;
}>();
const emit = defineEmits<{
  close: [];
  saved: [];
  delete: [project: ProjectItem];
  error: [message: string];
  warning: [message: string];
}>();

const open = ref(false);
const draft = ref<EditorDraft | null>(null);
const busy = ref(false);

watch(
  () => props.project,
  (project) => {
    open.value = Boolean(project);
    if (!project) return;
    const folders = (project.folders ?? [])
      .filter((item) => item.active)
      .map((item) => ({ clientId: item.id, folderId: item.id, key: item.key, path: item.path }));
    draft.value = {
      name: project.name,
      folders,
      primaryClientId:
        folders.find((item) => item.folderId === project.primaryFolderId)?.clientId ?? folders[0]?.clientId,
    };
  },
  { immediate: true },
);

function folderName(folder: EditorFolder): string {
  const value = folder.path.replace(/[\\/]+$/gu, "");
  return value.split(/[\\/]/gu).pop() || folder.key;
}
async function addFolder(): Promise<void> {
  const editor = draft.value;
  if (!editor || busy.value) return;
  busy.value = true;
  try {
    const folder = (await request<{ path: string | null }>("/api/folder/pick", {})).path;
    if (!folder) return;
    const normalized = folder.replace(/[\\/]+$/gu, "").toLocaleLowerCase();
    if (editor.folders.some((item) => item.path.replace(/[\\/]+$/gu, "").toLocaleLowerCase() === normalized)) {
      emit("warning", t("ui.folderAlreadyAdded"));
      return;
    }
    const added = {
      clientId: `draft-folder-${Date.now()}-${Math.random()}`,
      key: folderName({ clientId: "", key: "", path: folder }),
      path: folder,
    };
    editor.folders.push(added);
    editor.primaryClientId ??= added.clientId;
  } catch (reason) {
    emit("error", errorMessage(reason));
  } finally {
    busy.value = false;
  }
}
function removeFolder(clientId: string): void {
  const editor = draft.value;
  if (!editor) return;
  editor.folders = editor.folders.filter((folder) => folder.clientId !== clientId);
  if (editor.primaryClientId === clientId) editor.primaryClientId = editor.folders[0]?.clientId;
}
function setPrimary(clientId: string): void {
  if (draft.value?.folders.some((folder) => folder.clientId === clientId)) draft.value.primaryClientId = clientId;
}
async function save(): Promise<void> {
  const editor = draft.value;
  const project = props.project;
  if (!editor || !project || busy.value || !editor.name.trim()) return;
  const primary = editor.folders.find((folder) => folder.clientId === editor.primaryClientId);
  busy.value = true;
  try {
    await request("/api/project/edit", {
      projectId: project.id,
      name: editor.name.trim(),
      retainedFolderIds: editor.folders.flatMap((folder) => (folder.folderId ? [folder.folderId] : [])),
      addedFolderPaths: editor.folders.flatMap((folder) => (folder.folderId ? [] : [folder.path])),
      ...(primary?.folderId
        ? { primaryFolderId: primary.folderId }
        : primary
          ? { primaryFolderPath: primary.path }
          : {}),
    });
    open.value = false;
    emit("saved");
  } catch (reason) {
    emit("error", errorMessage(reason));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ElDialog
    v-model="open"
    class="project-editor-dialog"
    width="min(520px, calc(100vw - 28px))"
    :title="t('ui.editProjectTitle')"
    destroy-on-close
    @closed="emit('close')"
  >
    <div v-if="draft" class="project-editor-body">
      <label class="project-editor-field">
        <span>{{ t("ui.projectName") }}</span>
        <ElInput v-model="draft.name" maxlength="120" :placeholder="t('ui.enterName')" />
      </label>
      <section class="project-editor-folders">
        <strong>{{ t("ui.sourceFolders") }}</strong>
        <div class="project-editor-folder-list">
          <div
            v-for="folder in draft.folders"
            :key="folder.clientId"
            class="project-editor-folder"
            :title="folder.path"
          >
            <Folder class="project-editor-folder-icon" />
            <span class="project-editor-folder-name">{{ folderName(folder) }}</span>
            <span v-if="folder.clientId === draft.primaryClientId" class="project-editor-primary">{{
              t("ui.primaryFolder")
            }}</span>
            <ElButton v-else class="project-editor-make-primary" text @click="setPrimary(folder.clientId)">{{
              t("ui.makePrimary")
            }}</ElButton>
            <ElButton
              class="project-editor-remove-folder"
              text
              :icon="Close"
              :title="t('ui.removeProjectFolder')"
              :aria-label="t('ui.removeProjectFolder')"
              @click="removeFolder(folder.clientId)"
            />
          </div>
          <ElButton class="project-editor-add-folder" text :icon="Plus" :loading="busy" @click="addFolder">{{
            t("ui.addFolder")
          }}</ElButton>
        </div>
      </section>
    </div>
    <template #footer>
      <div class="project-editor-footer">
        <ElButton
          v-if="project"
          class="project-editor-delete"
          type="danger"
          plain
          :disabled="busy || running"
          @click="emit('delete', project)"
          >{{ t("ui.removeProjectTitle") }}</ElButton
        >
        <span class="project-editor-footer-spacer"></span>
        <ElButton :disabled="busy" @click="open = false">{{ t("ui.cancel") }}</ElButton>
        <ElButton type="primary" :loading="busy" :disabled="!draft?.name.trim() || running" @click="save">{{
          t("ui.save")
        }}</ElButton>
      </div>
    </template>
  </ElDialog>
</template>
