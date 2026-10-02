<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from "vue";
import { ElButton, ElCard, ElMessageBox, ElNotification } from "element-plus";
import type { WebEntry, WebPatch } from "../web-contracts.js";
import type { WebCommandEntry } from "../web-command-catalog.js";
import { request, type ProjectItem, type ThreadItem } from "./api.js";
import { displayProject, displayTitle } from "./display-content.js";
import { errorMessage } from "./errors.js";
import { useOutsideDismiss } from "./use-outside-dismiss.js";
import { setLanguage, t } from "./i18n.js";
import { parseLanguage, type Language } from "../i18n/language.js";
import { approvalLabel, modeLabel, modelLabel, orchestrationLabel } from "./session-labels.js";
import { useConversation } from "./use-conversation.js";
import AppSidebar from "./components/AppSidebar.vue";
import TopBar from "./components/TopBar.vue";
import TaskMonitor from "./components/TaskMonitor.vue";
import ProjectEditorDialog from "./components/ProjectEditorDialog.vue";
import Composer from "./components/Composer.vue";
import CommandPanel from "./components/CommandPanel.vue";
import MessageRail from "./components/MessageRail.vue";
import ConversationTurn from "./components/ConversationTurn.vue";
import { compactionRunning } from "../ui/compaction.js";
import { LONG_TURN_NOTIFY_MS, formatDuration } from "../ui/duration.js";
import { notifyAttention, requestAttentionPermission } from "./attention.js";

const transcript = ref<HTMLElement>();
const composer = ref<InstanceType<typeof Composer>>();
const sidebar = ref<InstanceType<typeof AppSidebar>>();
const commands = ref<WebCommandEntry[]>([]);
const commandPanelName = ref<string | null>(null);
const commandOutput = ref<WebEntry[]>([]);
const commandOutputLabel = ref("");
const commandOutputDismissed = ref(false);
const commandOutputRoot = ref<{ $el: HTMLElement }>();
let commandCaptureThreadId: string | undefined;
let commandRunSeen = false;
useOutsideDismiss(commandOutputRoot, () => {
  commandOutputDismissed.value = true;
});
let activeNotification: ReturnType<typeof ElNotification> | undefined;
const expandedProjects = ref<Set<string>>(new Set());
const editingProject = ref<ProjectItem | null>(null);
const switching = ref(false);
const sidebarCollapsed = ref(false);
const now = ref(Date.now());
let timer: number | undefined;
/** Decisions already announced (or already on screen when the page loaded), by ID. */
const announcedDecisions = new Set<string>();

const conversation = useConversation(transcript, {
  onSnapshot(snapshot) {
    if (snapshot.view.decision) announcedDecisions.add(snapshot.view.decision.id);
  },
  onPatch: announce,
  onNotice(entry) {
    if (commandCaptureThreadId === activeThread.value && (entry.kind === "info" || commandPanelName.value))
      commandOutput.value = [...commandOutput.value, entry].slice(-20);
    else if (entry.kind !== "info") notify(entry.text, entry.kind);
  },
  onRunningThreads(ids) {
    if (!commandCaptureThreadId) return;
    if (ids.includes(commandCaptureThreadId)) commandRunSeen = true;
    else if (commandRunSeen) commandCaptureThreadId = undefined;
  },
  onError: reportError,
});
const {
  view,
  history,
  historyLoading,
  archiveEntries,
  archiveHasLater,
  threads,
  projects,
  runningThreadIds,
  selectedProjectId,
  plan,
  connected,
  loading,
  visibleMessageIds,
  session,
  activeThread,
  conversationEntries,
  conversationTurns,
  hasEarlier,
} = conversation;

const EMPTY_THREAD_TITLES = [
  "ui.emptyThreadTitle",
  "ui.emptyThreadTitleIdea",
  "ui.emptyThreadTitleSmallChange",
  "ui.emptyThreadTitleFeature",
  "ui.emptyThreadTitleHelp",
  "ui.emptyThreadTitleStuck",
  "ui.emptyThreadTitleForward",
  "ui.emptyThreadTitleExplore",
] as const;
const emptyThreadTitleIndex = ref(0);
const emptyThreadOpenSerial = ref(0);
function pickEmptyThreadTitle(): void {
  emptyThreadTitleIndex.value = Math.floor(Math.random() * EMPTY_THREAD_TITLES.length);
  emptyThreadOpenSerial.value += 1;
}

const compacting = computed(() => compactionRunning(view.value.compaction));
const selectedCommand = computed(() => commands.value.find((command) => command.name === commandPanelName.value));
const activeProject = computed(() =>
  displayProject(
    activeThread.value,
    session.value?.workspaceRoot,
    threads.value,
    projects.value,
    selectedProjectId.value,
  ),
);
const headerTitle = computed(() => displayTitle(activeThread.value, activeProject.value, threads.value));
const headerHint = computed(() =>
  activeProject.value
    ? activeProject.value.ready === false
      ? t("ui.attachFolderHint")
      : t("ui.emptyProjectHint")
    : t("ui.emptyNoProjectHint"),
);
const liveAgentCount = computed(
  () => view.value.subagents.filter((agent) => agent.status === "running" || agent.status === "stopping").length,
);
const monitorActive = computed(
  () =>
    view.value.tasks !== null ||
    liveAgentCount.value > 0 ||
    view.value.review !== null ||
    view.value.activities.length > 0,
);
/** The user's messages in this conversation, oldest first, for ↑/↓ in the composer. */
const sentMessages = computed(() =>
  conversationEntries.value.filter((entry) => entry.kind === "user" && entry.text.trim()).map((entry) => entry.text),
);

function projectRunning(projectId: string): boolean {
  return threads.value.some(
    (thread) => thread.workspaceId === projectId && runningThreadIds.value.has(thread.threadId),
  );
}

function notify(text: string, kind: "success" | "warning" | "error"): void {
  activeNotification?.close();
  activeNotification = ElNotification({
    title: kind === "error" ? t("ui.errorTitle") : kind === "warning" ? t("ui.noticeTitle") : t("ui.doneTitle"),
    message: noticePreview(text),
    type: kind,
    duration: 15_000,
    showClose: true,
    position: "top-right",
  });
}
function reportError(message: string): void {
  if (message) notify(message, "error");
}
function noticePreview(text: string): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine;
}

/**
 * Notify a user who switched away when any thread finishes a long request or
 * waits on a decision. Checked before the active-thread filter: a task in a
 * background conversation is exactly the one the user is not watching.
 */
function announce(threadId: string, patch: WebPatch): void {
  const thread = threads.value.find((item) => item.threadId === threadId)?.title;
  const withThread = (message: string): string => (thread ? `${thread}\n${message}` : message);
  if (patch.kind === "turn.completed") {
    if (patch.summary.durationMs < LONG_TURN_NOTIFY_MS) return;
    notifyAttention(
      withThread(t("ui.taskFinishedNotice", { elapsed: formatDuration(patch.summary.durationMs) })),
      `turn-${threadId}`,
    );
    return;
  }
  const decision = patch.kind === "state" ? patch.state.decision : undefined;
  if (!decision || announcedDecisions.has(decision.id)) return;
  announcedDecisions.add(decision.id);
  const message =
    decision.kind === "approval"
      ? t("ui.approvalNeededNotice", { title: decision.title })
      : t("ui.decisionNeededNotice", { title: decision.title });
  notifyAttention(withThread(message), `decision-${decision.id}`);
}

function resetCommandOutput(): void {
  commandCaptureThreadId = undefined;
  commandRunSeen = false;
  commandOutput.value = [];
  commandOutputLabel.value = "";
  commandOutputDismissed.value = false;
}
function beginCommandOutput(label: string): void {
  resetCommandOutput();
  commandCaptureThreadId = activeThread.value;
  commandOutputLabel.value = label;
}
function webCommandName(text: string): string | undefined {
  const match = /^\/([a-z0-9_-]+)(?:\s|$)/iu.exec(text.trim());
  const name = match?.[1]?.toLowerCase();
  return name && commands.value.some((command) => command.name === name) ? name : undefined;
}

/** Run a request and report its failure; resolves false when it failed. */
async function attempt(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (reason) {
    reportError(errorMessage(reason));
    return false;
  }
}

watch(activeThread, (next, previous) => {
  if (next === previous) return;
  resetCommandOutput();
  commandPanelName.value = null;
  if (next) pickEmptyThreadTitle();
});
function onKeydown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (event.key.toLowerCase() === "k") {
    event.preventDefault();
    sidebar.value?.focusSearch();
  }
}
onMounted(() => {
  void conversation.start().then(async () => {
    await attempt(async () => {
      commands.value = (await request<{ commands: WebCommandEntry[] }>("/api/commands")).commands;
    });
  });
  timer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
  window.addEventListener("resize", conversation.updateVisibleMessages);
  window.addEventListener("keydown", onKeydown);
});
onUnmounted(() => {
  activeNotification?.close();
  conversation.stop();
  if (timer) clearInterval(timer);
  window.removeEventListener("resize", conversation.updateVisibleMessages);
  window.removeEventListener("keydown", onKeydown);
});

async function send(text: string, imageIds: string[], resourceIds: string[]): Promise<void> {
  if (!activeThread.value) return;
  // Sending is a user action, the only moment a browser lets a page ask to show notifications.
  requestAttentionPermission();
  if (compacting.value) {
    composer.value?.failed();
    return;
  }
  if (archiveEntries.value) await conversation.returnToLatest();
  const threadId = activeThread.value;
  const command = webCommandName(text);
  if (command && view.value.busy) {
    composer.value?.failed();
    reportError(t("ui.waitCurrent"));
    return;
  }
  if (command && command !== "compact") beginCommandOutput(`/${command}`);
  else resetCommandOutput();
  try {
    const route = view.value.busy ? "/api/adjustment" : "/api/message";
    await request(route, { threadId, text, imageIds, resourceIds });
    composer.value?.sent(threadId);
  } catch (reason) {
    if (command) resetCommandOutput();
    composer.value?.failed();
    reportError(errorMessage(reason));
  }
}
async function executePanelCommand(text: string): Promise<void> {
  const threadId = activeThread.value;
  if (!threadId) return;
  beginCommandOutput(text.split(/\s/u, 1)[0] ?? text);
  if (!(await attempt(() => request("/api/message", { threadId, text, imageIds: [] })))) resetCommandOutput();
}
function openCommand(name: string): void {
  if (!commands.value.some((command) => command.name === name) || !activeThread.value || view.value.busy) return;
  if (name === "compact") {
    void send("/compact", [], []);
    return;
  }
  commandPanelName.value = name;
  void executePanelCommand(name === "memory" ? "/memory short 8" : `/${name}`);
}
function closeCommand(): void {
  commandPanelName.value = null;
  resetCommandOutput();
}
function cancelExternalCommand(): void {
  void attempt(() => request("/api/ui/command/cancel", { threadId: activeThread.value }));
}
function stop(): void {
  void attempt(() => request("/api/cancel", { threadId: activeThread.value }));
}
function chooseSetting(setting: "model" | "approval" | "orchestration" | "mode"): void {
  if (!activeThread.value) return;
  resetCommandOutput();
  void attempt(() => request(`/api/ui/${setting}`, { threadId: activeThread.value }));
}
function changeLanguage(value: string): void {
  void attempt(async () => {
    const requested = parseLanguage(value);
    const result = await request<{ language: Language }>("/api/command", { text: `/language ${requested}` });
    setLanguage(result.language);
  });
}
async function switchThread(action: "new" | "resume", threadId?: string, projectId?: string): Promise<void> {
  if (switching.value) return;
  const previousThreadId = activeThread.value;
  switching.value = true;
  try {
    await request("/api/thread", { action, ...(threadId ? { threadId } : {}), ...(projectId ? { projectId } : {}) });
    await conversation.refresh();
    if (action === "resume" && threadId === previousThreadId && activeThread.value === threadId) pickEmptyThreadTitle();
  } catch (reason) {
    reportError(errorMessage(reason));
  } finally {
    switching.value = false;
  }
}
function toggleProject(id: string): void {
  selectedProjectId.value = id;
  const next = new Set(expandedProjects.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedProjects.value = next;
}
async function addProject(): Promise<void> {
  if (switching.value) return;
  let name: string;
  try {
    ({ value: name } = await ElMessageBox.prompt(t("ui.newProjectPrompt"), t("ui.newProjectTitle"), {
      inputValue: t("ui.untitledProject"),
      inputPattern: /\S/u,
      inputErrorMessage: t("ui.enterName"),
    }));
  } catch {
    return;
  }
  switching.value = true;
  await attempt(async () => {
    const result = await request<{ project: ProjectItem }>("/api/project/add", { name: name.trim() });
    selectedProjectId.value = result.project.id;
    expandedProjects.value = new Set([...expandedProjects.value, result.project.id]);
    await conversation.refresh();
  });
  switching.value = false;
}
async function projectSaved(): Promise<void> {
  await conversation.refresh();
  notify(t("ui.projectSaved"), "success");
}
async function renameThread(thread: ThreadItem): Promise<void> {
  let name: string;
  try {
    ({ value: name } = await ElMessageBox.prompt(t("ui.permanentName"), t("ui.renameConversationTitle"), {
      inputValue: thread.title,
      inputPattern: /\S/u,
      inputErrorMessage: t("ui.enterName"),
    }));
  } catch {
    return;
  }
  name = name.trim();
  if (!name || name === thread.title) return;
  if (await attempt(() => request("/api/thread/rename", { threadId: thread.threadId, name }))) {
    await conversation.refresh();
    notify(t("ui.conversationNamed"), "success");
  }
}
/** Ask before removing something; resolves true when the user confirmed. */
async function confirmRemoval(
  body: string,
  target: ReturnType<typeof h> | string,
  note: string,
  question: string,
  keep: string,
  remove: string,
): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      h("div", { class: "easy-code-confirm__body" }, [
        h("p", body),
        h("div", { class: "easy-code-confirm__target" }, target),
        h("small", note),
      ]),
      question,
      {
        customClass: "easy-code-confirm",
        showClose: false,
        closeOnClickModal: false,
        cancelButtonText: keep,
        confirmButtonText: remove,
        confirmButtonClass: "easy-code-confirm__danger",
      },
    );
    return true;
  } catch {
    return false;
  }
}
async function deleteThread(thread: ThreadItem): Promise<void> {
  const confirmed = await confirmRemoval(
    t("ui.deleteConversationBody"),
    thread.title,
    t("ui.filesUnchanged"),
    t("ui.deleteConversationQuestion"),
    t("ui.keepConversation"),
    t("ui.deleteConversationTitle"),
  );
  if (!confirmed) return;
  const payload = { threadId: thread.threadId, confirmThreadId: thread.threadId };
  if (await attempt(() => request("/api/thread/delete", payload))) {
    await conversation.refresh();
    notify(t("ui.conversationDeleted"), "success");
  }
}
async function deleteProject(project: ProjectItem): Promise<void> {
  const confirmed = await confirmRemoval(
    t("ui.removeProjectBody"),
    h("strong", project.name),
    t("ui.folderUnchanged"),
    t("ui.removeProjectQuestion"),
    t("ui.keepProject"),
    t("ui.removeProjectTitle"),
  );
  if (!confirmed) return;
  if (await attempt(() => request("/api/project/delete", { projectId: project.id, confirmProjectId: project.id }))) {
    editingProject.value = null;
    await conversation.refresh();
    notify(t("ui.projectRemoved"), "success");
  }
}
function decide(id: string, value: string | undefined): void {
  void attempt(async () => {
    const result = await request<{ accepted: boolean }>("/api/decision", { threadId: activeThread.value, id, value });
    if (!result.accepted) throw new Error(t("ui.decisionExpired"));
  });
}
async function decidePlan(action: "approve" | "reject" | "adjust"): Promise<void> {
  let feedback: string | undefined;
  if (action === "adjust") {
    try {
      feedback = (
        await ElMessageBox.prompt(t("ui.planPrompt"), t("ui.planPromptTitle"), {
          inputPattern: /\S/u,
          inputErrorMessage: t("ui.planPromptError"),
        })
      ).value.trim();
    } catch {
      return;
    }
    if (!feedback) return;
  }
  if (await attempt(() => request("/api/plan", { threadId: activeThread.value, action, feedback }))) plan.value = null;
}
</script>

<template>
  <div class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <AppSidebar
      ref="sidebar"
      v-model:collapsed="sidebarCollapsed"
      :projects="projects"
      :threads="threads"
      :active-project-id="activeProject?.id"
      :active-thread-id="activeThread"
      :running-thread-ids="runningThreadIds"
      :expanded-projects="expandedProjects"
      :switching="switching"
      :connected="connected"
      @add-project="addProject"
      @toggle-project="toggleProject"
      @new-thread="switchThread('new', undefined, $event)"
      @edit-project="editingProject = $event"
      @delete-project="deleteProject"
      @resume-thread="switchThread('resume', $event)"
      @rename-thread="renameThread"
      @delete-thread="deleteThread"
    />

    <main class="main-column">
      <TopBar
        :title="headerTitle"
        :session="session"
        :hint="headerHint"
        :task-count="view.tasks?.tasks.length ?? 0"
        :agent-count="liveAgentCount"
        @change-language="changeLanguage"
      />

      <div v-if="loading" class="loading-state">{{ t("ui.connecting") }}</div>
      <div v-else class="transcript-frame">
        <MessageRail :markers="history.markers" :visible-ids="visibleMessageIds" @navigate="conversation.jumpToEntry" />
        <ElButton v-if="archiveEntries" class="return-to-latest" round @click="conversation.returnToLatest">{{
          t("ui.backToLatest")
        }}</ElButton>
        <div
          ref="transcript"
          class="transcript"
          @scroll="conversation.onScroll"
          @toggle.capture="conversation.updateVisibleMessages"
        >
          <div class="conversation-width">
            <div v-if="hasEarlier" class="history-load">
              <ElButton text :loading="historyLoading" @click="conversation.loadOlder">{{
                t("ui.loadEarlier")
              }}</ElButton>
            </div>
            <Transition name="empty-state" mode="out-in">
              <div
                v-if="!conversationEntries.length && !hasEarlier"
                :key="`${activeThread ?? activeProject?.id ?? 'no-project'}:${emptyThreadOpenSerial}`"
                class="empty-state"
              >
                <img class="empty-symbol" src="/easy-code-icon.svg?v=origami-dog" alt="" aria-hidden="true" />
                <h2>
                  {{
                    activeThread
                      ? t(EMPTY_THREAD_TITLES[emptyThreadTitleIndex]!)
                      : activeProject
                        ? t("ui.emptyProjectTitle")
                        : t("ui.emptyNoProjectTitle")
                  }}
                </h2>
                <p>{{ activeThread ? t("ui.emptyThreadHint") : headerHint }}</p>
              </div>
            </Transition>
            <ConversationTurn v-for="turn in conversationTurns" :key="turn.id" :turn="turn" />
            <div v-if="archiveEntries && archiveHasLater" class="history-load">
              <ElButton text :loading="historyLoading" @click="conversation.loadNewer">{{
                t("ui.loadNewer")
              }}</ElButton>
            </div>
            <section v-if="plan" class="plan-actions">
              <strong>{{ t("ui.planAwaiting") }}</strong>
              <div>
                <ElButton type="primary" @click="decidePlan('approve')">{{ t("ui.approveRun") }}</ElButton
                ><ElButton @click="decidePlan('adjust')">{{ t("ui.requestChanges") }}</ElButton
                ><ElButton type="danger" plain @click="decidePlan('reject')">{{ t("ui.reject") }}</ElButton>
              </div>
            </section>
          </div>
        </div>
        <TaskMonitor v-if="monitorActive" :view="view" :now="now" />
        <ElCard
          v-if="commandOutput.length && !commandOutputDismissed && !selectedCommand"
          ref="commandOutputRoot"
          class="command-output-overlay"
          shadow="always"
          :aria-label="t('ui.commandOutput')"
        >
          <div class="command-output-heading">
            <strong>{{ commandOutputLabel || t("ui.commandOutput") }}</strong>
          </div>
          <div class="command-output-body">
            <pre v-for="entry in commandOutput" :key="entry.id">{{ entry.text }}</pre>
          </div>
        </ElCard>
      </div>
      <Composer
        ref="composer"
        :compacting="compacting"
        :busy="view.busy"
        :thread-id="activeThread"
        :model-label="modelLabel(session)"
        :approval-label="approvalLabel(session)"
        :orchestration-label="orchestrationLabel(session)"
        :mode-label="modeLabel(session)"
        :settings-disabled="!activeThread || view.busy || switching || !!view.decision"
        :decision="selectedCommand?.name === 'mcp' ? null : view.decision"
        :commands="commands"
        :sent-messages="sentMessages"
        @send="send"
        @stop="stop"
        @select-model="chooseSetting('model')"
        @select-approval="chooseSetting('approval')"
        @select-orchestration="chooseSetting('orchestration')"
        @select-mode="chooseSetting('mode')"
        @open-command="openCommand"
        @submit-decision="decide"
        @error="reportError"
      >
        <template #command-panel
          ><CommandPanel
            v-if="selectedCommand"
            :command="selectedCommand"
            :commands="commands"
            :entries="commandOutput"
            :decision="view.decision"
            :running="!!activeThread && runningThreadIds.has(activeThread)"
            @execute="executePanelCommand"
            @close="closeCommand"
            @decide="decide"
            @cancel-external="cancelExternalCommand"
        /></template>
      </Composer>
    </main>
  </div>
  <ProjectEditorDialog
    :project="editingProject"
    :running="!!editingProject && projectRunning(editingProject.id)"
    @close="editingProject = null"
    @saved="projectSaved"
    @delete="deleteProject"
    @error="reportError"
    @warning="notify($event, 'warning')"
  />
</template>
