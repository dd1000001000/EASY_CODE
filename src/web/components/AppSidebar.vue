<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElInput } from "element-plus";
import {
  Delete,
  Edit,
  Fold,
  Folder,
  FolderOpened,
  Loading,
  Plus,
  Search,
  WarningFilled,
} from "@element-plus/icons-vue";
import type { ProjectItem, ThreadItem } from "../api.js";
import { t } from "../i18n.js";

const props = defineProps<{
  collapsed: boolean;
  projects: readonly ProjectItem[];
  threads: readonly ThreadItem[];
  activeProjectId?: string;
  activeThreadId?: string;
  runningThreadIds: ReadonlySet<string>;
  expandedProjects: ReadonlySet<string>;
  switching: boolean;
  connected: boolean;
}>();
const emit = defineEmits<{
  "update:collapsed": [value: boolean];
  addProject: [];
  toggleProject: [id: string];
  newThread: [projectId: string];
  editProject: [project: ProjectItem];
  deleteProject: [project: ProjectItem];
  resumeThread: [threadId: string];
  renameThread: [thread: ThreadItem];
  deleteThread: [thread: ThreadItem];
}>();

const search = ref("");
const searchInput = ref<InstanceType<typeof ElInput>>();
const query = computed(() => search.value.trim().toLocaleLowerCase());
const sortedThreads = computed(() => [...props.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));

function projectThreads(id: string): ThreadItem[] {
  return sortedThreads.value.filter(
    (thread) => thread.workspaceId === id && (!query.value || thread.title.toLocaleLowerCase().includes(query.value)),
  );
}
function projectRunning(id: string): boolean {
  return sortedThreads.value.some((thread) => thread.workspaceId === id && props.runningThreadIds.has(thread.threadId));
}
/** While searching, every project with a matching conversation (or name) opens. */
function projectVisible(project: ProjectItem): boolean {
  return (
    !query.value || project.name.toLocaleLowerCase().includes(query.value) || projectThreads(project.id).length > 0
  );
}
function projectOpen(id: string): boolean {
  return Boolean(query.value) || props.expandedProjects.has(id);
}

defineExpose({
  focusSearch(): void {
    emit("update:collapsed", false);
    requestAnimationFrame(() => searchInput.value?.focus());
  },
});
</script>

<template>
  <aside class="sidebar">
    <Transition name="sidebar-brand" mode="out-in">
      <div v-if="collapsed" class="brand brand--collapsed">
        <ElButton
          class="brand-expand"
          text
          :title="t('ui.expandSidebar')"
          :aria-label="t('ui.expandSidebar')"
          @click="emit('update:collapsed', false)"
        >
          <img class="brand-mark" src="/easy-code-icon.svg?v=origami-dog" alt="" aria-hidden="true" />
        </ElButton>
      </div>
      <div v-else class="brand brand--expanded">
        <img class="brand-mark" src="/easy-code-icon.svg?v=origami-dog" alt="" aria-hidden="true" />
        <div class="brand-copy">
          <strong>EASY CODE</strong><small>{{ t("ui.localAgent") }}</small>
        </div>
        <ElButton
          class="brand-collapse"
          text
          :icon="Fold"
          :title="t('ui.collapseSidebar')"
          :aria-label="t('ui.collapseSidebar')"
          @click="emit('update:collapsed', true)"
        />
      </div>
    </Transition>
    <Transition name="sidebar-content">
      <div v-if="!collapsed" class="sidebar-content">
        <ElInput
          ref="searchInput"
          v-model="search"
          class="sidebar-search"
          clearable
          :prefix-icon="Search"
          :placeholder="t('ui.searchConversations')"
          :title="`${t('ui.searchConversations')} (Ctrl+K)`"
          :aria-label="t('ui.searchConversations')"
          @keydown.esc="search = ''"
        />
        <div class="sidebar-heading project-heading">
          <span>{{ t("ui.projects") }}</span
          ><ElButton
            class="project-add"
            text
            :icon="Plus"
            :title="t('ui.addProject')"
            :aria-label="t('ui.addProject')"
            :disabled="switching"
            @click="emit('addProject')"
          />
        </div>
        <nav class="thread-list" :aria-label="t('ui.projectNavigation')">
          <template v-for="project in projects" :key="project.id">
            <section v-if="projectVisible(project)" class="project-group">
              <div class="project-row" :class="{ current: activeProjectId === project.id }">
                <ElButton
                  class="project-toggle"
                  text
                  :title="
                    project.primaryUnavailable ? `${project.name} — ${t('ui.primaryFolderUnavailable')}` : project.name
                  "
                  :aria-expanded="projectOpen(project.id)"
                  @click="emit('toggleProject', project.id)"
                >
                  <FolderOpened v-if="projectOpen(project.id)" class="project-folder" /><Folder
                    v-else
                    class="project-folder"
                  /><span class="project-name">{{ project.name }}</span
                  ><WarningFilled
                    v-if="project.primaryUnavailable"
                    class="project-unavailable"
                    :aria-label="t('ui.primaryFolderUnavailable')"
                  /><Loading
                    v-if="projectRunning(project.id)"
                    class="project-loading"
                    :aria-label="t('ui.projectActive')"
                  />
                </ElButton>
                <ElButton
                  class="project-action project-action--add"
                  text
                  :icon="Plus"
                  :title="
                    project.primaryUnavailable
                      ? t('ui.primaryFolderUnavailable')
                      : project.ready === false
                        ? t('ui.attachFolderFirst')
                        : t('ui.newConversation')
                  "
                  :aria-label="t('ui.newConversation')"
                  :disabled="switching || project.ready === false"
                  @click="emit('newThread', project.id)"
                />
                <ElButton
                  class="project-action"
                  text
                  :icon="Edit"
                  :title="t('ui.editProject')"
                  :aria-label="t('ui.editProject')"
                  :disabled="switching"
                  @click="emit('editProject', project)"
                />
                <ElButton
                  class="project-action danger"
                  text
                  :icon="Delete"
                  :title="t('ui.removeProject')"
                  :aria-label="t('ui.removeProject')"
                  :disabled="switching || projectRunning(project.id)"
                  @click="emit('deleteProject', project)"
                />
              </div>
              <div v-if="projectOpen(project.id)" class="project-threads">
                <div
                  v-for="thread in projectThreads(project.id)"
                  :key="thread.threadId"
                  class="thread-item"
                  :class="{ active: activeThreadId === thread.threadId }"
                >
                  <ElButton
                    class="thread-row"
                    text
                    :disabled="switching"
                    :title="thread.threadId"
                    @click="emit('resumeThread', thread.threadId)"
                  >
                    <Loading v-if="runningThreadIds.has(thread.threadId)" class="thread-loading" /><span
                      v-else
                      class="thread-icon"
                      >◌</span
                    ><span>{{ thread.title }}</span>
                  </ElButton>
                  <ElButton
                    v-if="thread.canRename"
                    class="project-action"
                    text
                    :icon="Edit"
                    :title="t('ui.nameConversation')"
                    :aria-label="t('ui.nameConversation')"
                    :disabled="switching"
                    @click="emit('renameThread', thread)"
                  />
                  <ElButton
                    class="project-action danger"
                    text
                    :icon="Delete"
                    :title="t('ui.deleteConversation')"
                    :aria-label="t('ui.deleteConversation')"
                    :disabled="switching"
                    @click="emit('deleteThread', thread)"
                  />
                </div>
              </div>
            </section>
          </template>
          <p v-if="query && !projects.some(projectVisible)" class="sidebar-empty">
            {{ t("ui.noMatchingConversations") }}
          </p>
        </nav>
        <div class="sidebar-footer">
          <span :class="connected ? 'online-dot' : 'offline-dot'"></span
          >{{ connected ? t("ui.connected") : t("ui.reconnecting") }}
        </div>
      </div>
    </Transition>
  </aside>
</template>
