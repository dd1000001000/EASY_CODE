<script setup lang="ts">
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ElButton, ElCard, ElMessageBox, ElNotification } from "element-plus";
import { Close, Delete, Edit, Folder, FolderOpened, Loading, Plus } from "@element-plus/icons-vue";
import type { WebEntry, WebHistoryState, WebPatch, WebView } from "../web-contracts.js";
import type { WebCommandEntry } from "../web-command-catalog.js";
import type { PlanProposal } from "../core/types.js";
import { bootstrap, fetchHistoryPage, request, type ProjectItem, type ThreadItem, type WebSnapshot } from "./api.js";
import { displayProject, displayTitle, isConversationEntry, isNoticeEntry } from "./display-content.js";
import Composer from "./components/Composer.vue";
import CommandPanel from "./components/CommandPanel.vue";
import MessageRail from "./components/MessageRail.vue";
import TranscriptEntry from "./components/TranscriptEntry.vue";

const view = ref<WebView>({ session: null, entries: [], tasks: null, subagents: [], activities: [], review: null, decision: null, busy: false });
const history = ref<WebHistoryState>({ epoch: "", hasEarlier: false, markers: [] });
const historyLoading = ref(false);
const historyExpanded = ref(false);
const archiveEntries = ref<WebEntry[] | null>(null);
const archiveHasEarlier = ref(false);
const archiveHasLater = ref(false);
const threads = ref<ThreadItem[]>([]);
const projects = ref<ProjectItem[]>([]);
const commands = ref<WebCommandEntry[]>([]);
const commandPanelName = ref<string | null>(null);
const commandOutput = ref<WebEntry[]>([]);
const commandOutputLabel = ref("");
const commandOutputDismissed = ref(false);
let commandCaptureThreadId: string | undefined;
let commandRunSeen = false;
let activeNotification: ReturnType<typeof ElNotification> | undefined;
const runningThreadIds = ref<Set<string>>(new Set());
const expandedProjects = ref<Set<string>>(new Set());
const selectedProjectId = ref<string>();
const plan = ref<PlanProposal | null>(null);
const error = ref("");
const connected = ref(false);
const loading = ref(true);
const switching = ref(false);
const transcript = ref<HTMLElement>();
const visibleMessageIds = ref<Set<string>>(new Set());
const composer = ref<InstanceType<typeof Composer>>();
const now = ref(Date.now());
let timer: number | undefined;
let events: EventSource | undefined;
let sequence = -1;
let keepBottom = true;
const MAX_LIVE_ENTRIES = 200;

const session = computed(() => view.value.session);
const displayedEntries = computed(() => archiveEntries.value ?? view.value.entries);
const conversationEntries = computed(() => displayedEntries.value.filter(isConversationEntry));
const activeThread = computed(() => session.value?.threadId);
const selectedCommand = computed(() => commands.value.find(command => command.name === commandPanelName.value));
const sortedThreads = computed(() => [...threads.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
const activeProject = computed(() => displayProject(
  activeThread.value, session.value?.workspaceRoot, threads.value, projects.value, selectedProjectId.value,
));
const headerTitle = computed(() => displayTitle(activeThread.value, activeProject.value, threads.value));
const reviewLabel = computed(() => view.value.review?.phase === "main_brief"
  ? "Main agent is preparing the reviewer brief" : "Reviewer is independently inspecting the workspace");
const taskCount = computed(() => view.value.tasks?.tasks.length ?? 0);
const modelLabel = computed(() => session.value
  ? `${session.value.provider}/${session.value.model} · ${session.value.thinkingEffort}` : "Model");
const approvalLabel = computed(() => {
  switch (session.value?.commandExecutionMode) {
    case "auto_approve": return "Approval agent";
    case "unrestricted": return "Full access";
    default: return "Manual approval";
  }
});
const orchestrationLabel = computed(() => session.value?.orchestrationEnabled ? "DAG/agents on" : "DAG/agents off");
const liveAgents = computed(() => view.value.subagents.filter(agent => agent.status === "running" || agent.status === "stopping"));
const monitorActive = computed(() => view.value.tasks !== null || liveAgents.value.length > 0 || view.value.review !== null || view.value.activities.length > 0);
const unassignedAgents = computed(() => liveAgents.value.filter(agent => !view.value.tasks?.tasks.some(task => task.id === agent.taskId && agent.assignmentKind === "dag")));
function projectRunning(projectId: string): boolean {
  return projectThreads(projectId).some(thread => runningThreadIds.value.has(thread.threadId));
}
function agentForTask(taskId: string) { return liveAgents.value.find(agent => agent.assignmentKind === "dag" && agent.taskId === taskId); }
function agentStatus(agent: (typeof liveAgents.value)[number]): string {
  const activity = agent.activity;
  return `${activity?.kind === "thinking" ? "Thinking" : activity?.kind === "tool" ? `Tool: ${activity.label ?? "working"}` : agent.status} · ${elapsed(Date.parse(activity?.startedAt ?? agent.startedAt))}`;
}

function notify(text: string, kind: "info" | "success" | "warning" | "error" = "info"): void {
  activeNotification?.close();
  activeNotification = ElNotification({
    title: kind === "error" ? "Error" : kind === "warning" ? "Notice" : kind === "success" ? "Done" : "EASY CODE",
    message: noticePreview(text), type: kind, duration: 15_000, showClose: true, position: "top-right",
  });
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
  return name && commands.value.some(command => command.name === name) ? name : undefined;
}

function applySnapshot(snapshot: WebSnapshot): void {
  if (snapshot.view.session?.threadId === view.value.session?.threadId && snapshot.sequence < sequence) return;
  const sameHistory = snapshot.view.session?.threadId === view.value.session?.threadId &&
    snapshot.history.epoch === history.value.epoch;
  const preserveLoaded = sameHistory && (historyExpanded.value || !keepBottom);
  const recentIds = new Set(snapshot.view.entries.map(entry => entry.id));
  const entries = preserveLoaded
    ? [...view.value.entries.filter(entry => !recentIds.has(entry.id)), ...snapshot.view.entries]
    : snapshot.view.entries;
  sequence = snapshot.sequence;
  view.value = { ...snapshot.view, entries };
  history.value = { ...snapshot.history, hasEarlier: preserveLoaded ? history.value.hasEarlier : snapshot.history.hasEarlier };
  if (!sameHistory) {
    archiveEntries.value = null;
    archiveHasEarlier.value = false;
    archiveHasLater.value = false;
    historyExpanded.value = false;
    keepBottom = true;
  }
  threads.value = snapshot.threads;
  projects.value = snapshot.projects;
  runningThreadIds.value = new Set(snapshot.runningThreadIds);
  if (snapshot.view.session) {
    selectedProjectId.value = snapshot.projects.find(project => project.root === snapshot.view.session?.workspaceRoot)?.id;
  } else if (!snapshot.projects.some(project => project.id === selectedProjectId.value)) {
    selectedProjectId.value = undefined;
  }
  plan.value = snapshot.plan;
  loading.value = false;
}
function applyPatch(patch: WebPatch, nextSequence: number): void {
  if (Number.isFinite(nextSequence) && nextSequence <= sequence) return;
  sequence = nextSequence;
  if (patch.kind === "entry.append") {
    let entries = [...view.value.entries, patch.entry];
    if (keepBottom && !archiveEntries.value && entries.length > MAX_LIVE_ENTRIES) {
      entries = entries.slice(-MAX_LIVE_ENTRIES);
      history.value = { ...history.value, hasEarlier: true };
      historyExpanded.value = false;
    }
    view.value = { ...view.value, entries };
    if (patch.entry.kind === "user" && !history.value.markers.some(marker => marker.id === patch.entry.id)) {
      history.value = { ...history.value, markers: [...history.value.markers, {
        id: patch.entry.id,
        preview: (patch.entry.text.replace(/\s+/gu, " ").trim() || (patch.entry.images?.length ? "Image attachment" : "Your message")).slice(0, 120),
      }] };
    }
    if (isNoticeEntry(patch.entry)) {
      if (commandCaptureThreadId === activeThread.value && (patch.entry.kind === "info" || commandPanelName.value))
        commandOutput.value = [...commandOutput.value, patch.entry].slice(-20);
      else notify(patch.entry.text, patch.entry.kind);
    }
  }
  else if (patch.kind === "entry.replace") view.value = { ...view.value,
    entries: view.value.entries.map(entry => entry.id === patch.entry.id ? patch.entry : entry) };
  else if (patch.kind === "entries.reset") {
    view.value = { ...view.value, entries: patch.entries };
    if (patch.history) history.value = patch.history;
    archiveEntries.value = null;
    archiveHasEarlier.value = false;
    archiveHasLater.value = false;
    historyExpanded.value = false;
  }
  else if (patch.kind === "thread.title") threads.value = threads.value.map(thread =>
    thread.threadId === patch.threadId ? { ...thread, title: patch.title, canRename: false } : thread);
  else view.value = { ...view.value, ...patch.state };
}
async function refresh(): Promise<void> {
  try { applySnapshot(await request<WebSnapshot>("/api/state")); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
function connect(): void {
  events = new EventSource("/api/events");
  events.addEventListener("snapshot", event => {
    applySnapshot(JSON.parse((event as MessageEvent).data) as WebSnapshot);
    connected.value = true;
  });
  events.addEventListener("patch", event => {
    const message = event as MessageEvent;
    const update = JSON.parse(message.data) as { threadId: string; sequence: number; patch: WebPatch };
    if (update.threadId !== activeThread.value) return;
    const before = view.value.busy;
    const beforeThread = view.value.session?.threadId;
    applyPatch(update.patch, update.sequence);
    if ((before && !view.value.busy) || beforeThread !== view.value.session?.threadId) void refresh();
  });
  events.addEventListener("status", event => {
    const ids = (JSON.parse((event as MessageEvent).data) as { runningThreadIds: string[] }).runningThreadIds;
    if (commandCaptureThreadId) {
      if (ids.includes(commandCaptureThreadId)) commandRunSeen = true;
      else if (commandRunSeen) commandCaptureThreadId = undefined;
    }
    const completed = [...runningThreadIds.value].some(id => !ids.includes(id));
    runningThreadIds.value = new Set(ids);
    if (completed) void refresh();
  });
  events.onerror = () => { connected.value = false; };
  events.onopen = () => { connected.value = true; };
}
async function start(): Promise<void> {
  try {
    applySnapshot(await bootstrap());
    connect();
    commands.value = (await request<{ commands: WebCommandEntry[] }>("/api/commands")).commands;
  }
  catch (reason) { loading.value = false; error.value = reason instanceof Error ? reason.message : String(reason); }
}
watch(error, message => {
  if (!message) return;
  notify(message, "error");
  error.value = "";
});
watch(activeThread, (next, previous) => { if (next !== previous) { resetCommandOutput(); commandPanelName.value = null; } });
onMounted(() => { void start(); timer = window.setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => {
  activeNotification?.close();
  events?.close(); if (timer) clearInterval(timer);
});
function updateVisibleMessages(): void {
  const viewport = transcript.value;
  if (!viewport) { visibleMessageIds.value = new Set(); return; }
  const bounds = viewport.getBoundingClientRect();
  visibleMessageIds.value = new Set([...viewport.querySelectorAll<HTMLElement>(".entry--user[data-entry-id]")]
    .filter(element => { const box = element.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom; })
    .map(element => element.dataset.entryId!).filter(Boolean));
}
watch(displayedEntries, async () => { await nextTick(); updateVisibleMessages(); }, { flush: "post" });
async function loadOlder(): Promise<void> {
  const current = displayedEntries.value;
  const wasArchive = archiveEntries.value !== null;
  const before = current[0]?.id;
  const threadId = activeThread.value;
  const epoch = history.value.epoch;
  if (!threadId || !before || historyLoading.value || !(archiveEntries.value ? archiveHasEarlier.value : history.value.hasEarlier)) return;
  historyLoading.value = true;
  const viewport = transcript.value;
  const oldHeight = viewport?.scrollHeight ?? 0;
  const oldTop = viewport?.scrollTop ?? 0;
  try {
    const page = await fetchHistoryPage(threadId, epoch, { before });
    if (activeThread.value !== threadId || history.value.epoch !== page.epoch) return;
    if ((archiveEntries.value !== null) !== wasArchive) return;
    const latest = displayedEntries.value;
    const known = new Set(latest.map(entry => entry.id));
    const entries = [...page.entries.filter(entry => !known.has(entry.id)), ...latest];
    keepBottom = false;
    if (archiveEntries.value) {
      archiveEntries.value = entries;
      archiveHasEarlier.value = page.hasEarlier;
      archiveHasLater.value = page.hasLater;
    } else {
      view.value = { ...view.value, entries };
      history.value = { ...history.value, hasEarlier: page.hasEarlier };
      historyExpanded.value = true;
    }
    await nextTick();
    if (viewport) viewport.scrollTop = oldTop + viewport.scrollHeight - oldHeight;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { historyLoading.value = false; }
}
async function loadNewer(): Promise<void> {
  const current = archiveEntries.value;
  const after = current?.at(-1)?.id;
  const threadId = activeThread.value;
  const epoch = history.value.epoch;
  if (!current || !after || !threadId || !archiveHasLater.value || historyLoading.value) return;
  historyLoading.value = true;
  try {
    const page = await fetchHistoryPage(threadId, epoch, { after });
    if (activeThread.value !== threadId || history.value.epoch !== page.epoch || archiveEntries.value !== current) return;
    const known = new Set(current.map(entry => entry.id));
    archiveEntries.value = [...current, ...page.entries.filter(entry => !known.has(entry.id))];
    archiveHasLater.value = page.hasLater;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { historyLoading.value = false; }
}
async function jumpToEntry(id: string): Promise<void> {
  const viewport = transcript.value;
  if (!viewport || !activeThread.value) return;
  let element = [...viewport.querySelectorAll<HTMLElement>(".entry[data-entry-id]")]
    .find(item => item.dataset.entryId === id);
  if (!element) {
    const threadId = activeThread.value;
    try {
      const page = await fetchHistoryPage(threadId, history.value.epoch, { around: id });
      if (activeThread.value !== threadId || history.value.epoch !== page.epoch) return;
      archiveEntries.value = [...page.entries];
      archiveHasEarlier.value = page.hasEarlier;
      archiveHasLater.value = page.hasLater;
      keepBottom = false;
      await nextTick();
      element = [...viewport.querySelectorAll<HTMLElement>(".entry[data-entry-id]")]
        .find(item => item.dataset.entryId === id);
    } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); return; }
  }
  if (!viewport || !element) return;
  const top = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
  keepBottom = false;
  viewport.scrollTo({ top: Math.max(0, top - viewport.clientHeight / 4), behavior: "smooth" });
  updateVisibleMessages();
}
watch(() => [conversationEntries.value.length, conversationEntries.value.at(-1)?.text.length], async () => {
  if (!keepBottom || archiveEntries.value) return;
  await nextTick(); transcript.value?.scrollTo({ top: transcript.value.scrollHeight, behavior: "instant" });
});
function onScroll(): void {
  const element = transcript.value;
  if (element) keepBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
  updateVisibleMessages();
  if (element && element.scrollTop < 100) void loadOlder();
  if (element && archiveEntries.value && element.scrollHeight - element.scrollTop - element.clientHeight < 100) void loadNewer();
}
async function returnToLatest(): Promise<void> {
  archiveEntries.value = null;
  archiveHasEarlier.value = false;
  archiveHasLater.value = false;
  keepBottom = true;
  await nextTick();
  transcript.value?.scrollTo({ top: transcript.value.scrollHeight, behavior: "instant" });
  updateVisibleMessages();
}
async function send(text: string, imageIds: string[]): Promise<void> {
  if (!activeThread.value) return;
  if (archiveEntries.value) await returnToLatest();
  const threadId = activeThread.value;
  const command = webCommandName(text);
  if (command && view.value.busy) {
    composer.value?.failed();
    error.value = "Wait for the current request to finish before running a command.";
    return;
  }
  if (command) beginCommandOutput(`/${command}`); else resetCommandOutput();
  try {
    const route = view.value.busy ? "/api/adjustment" : "/api/message";
    await request(route, { threadId, text, imageIds });
    composer.value?.sent(threadId);
    error.value = "";
  } catch (reason) {
    if (command) resetCommandOutput();
    composer.value?.failed();
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}
async function executePanelCommand(text: string): Promise<void> {
  const threadId = activeThread.value;
  if (!threadId) return;
  beginCommandOutput(text.split(/\s/u, 1)[0] ?? text);
  try { await request("/api/message", { threadId, text, imageIds: [] }); }
  catch (reason) { resetCommandOutput(); error.value = reason instanceof Error ? reason.message : String(reason); }
}
function openCommand(name: string): void {
  if (!commands.value.some(command => command.name === name) || !activeThread.value || view.value.busy) return;
  commandPanelName.value = name;
  if (name === "mode") { resetCommandOutput(); return; }
  void executePanelCommand(name === "memory" ? "/memory short 8" : `/${name}`);
}
function closeCommand(): void { commandPanelName.value = null; resetCommandOutput(); }
async function cancelExternalCommand(): Promise<void> {
  try { await request("/api/ui/command/cancel", { threadId: activeThread.value }); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function stop(): Promise<void> {
  try { await request("/api/cancel", { threadId: activeThread.value }); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function chooseSetting(setting: "model" | "approval" | "orchestration"): Promise<void> {
  if (!activeThread.value) return;
  resetCommandOutput();
  try { await request(`/api/ui/${setting}`, { threadId: activeThread.value }); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function switchThread(action: "new" | "resume", threadId?: string, projectId?: string): Promise<void> {
  if (switching.value) return;
  switching.value = true;
  try {
    await request("/api/thread", { action, ...(threadId ? { threadId } : {}), ...(projectId ? { projectId } : {}) });
    error.value = "";
    await refresh();
    switching.value = false;
  }
  catch (reason) { switching.value = false; error.value = reason instanceof Error ? reason.message : String(reason); }
}
function toggleProject(id: string): void {
  selectedProjectId.value = id;
  const next = new Set(expandedProjects.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  expandedProjects.value = next;
}
function projectThreads(id: string): ThreadItem[] { return sortedThreads.value.filter(thread => thread.workspaceId === id); }
async function addProject(): Promise<void> {
  if (switching.value) return;
  switching.value = true;
  try {
    const folder = (await request<{ path: string | null }>("/api/folder/pick", {})).path;
    if (!folder) return;
    const result = await request<{ project: ProjectItem }>("/api/project/add", { path: folder });
    selectedProjectId.value = result.project.id;
    expandedProjects.value = new Set([...expandedProjects.value, result.project.id]);
    error.value = "";
    await refresh();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { switching.value = false; }
}
async function renameProject(project: ProjectItem): Promise<void> {
  let name: string;
  try { ({ value: name } = await ElMessageBox.prompt("Project name", "Rename project", { inputValue: project.name, inputPattern: /\S/u, inputErrorMessage: "Enter a name" })); }
  catch { return; }
  name = name.trim();
  if (!name || name === project.name) return;
  try { await request("/api/project/rename", { projectId: project.id, name }); await refresh(); notify("Project renamed", "success"); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function renameThread(thread: ThreadItem): Promise<void> {
  let name: string;
  try { ({ value: name } = await ElMessageBox.prompt("Choose a permanent conversation name", "Name conversation", { inputValue: thread.title, inputPattern: /\S/u, inputErrorMessage: "Enter a name" })); }
  catch { return; }
  name = name.trim();
  if (!name || name === thread.title) return;
  try { await request("/api/thread/rename", { threadId: thread.threadId, name }); await refresh(); notify("Conversation named", "success"); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function deleteThread(thread: ThreadItem): Promise<void> {
  const message = h("div", { class: "easy-code-confirm__body" }, [
    h("p", "This conversation and its saved memory will be permanently deleted."),
    h("div", { class: "easy-code-confirm__target" }, thread.title),
    h("small", "Project files will not be changed."),
  ]);
  try { await ElMessageBox.confirm(message, "Delete conversation?", {
    customClass: "easy-code-confirm", showClose: false, closeOnClickModal: false,
    cancelButtonText: "Keep conversation", confirmButtonText: "Delete conversation",
    confirmButtonClass: "easy-code-confirm__danger",
  }); }
  catch { return; }
  try {
    await request("/api/thread/delete", { threadId: thread.threadId, confirmThreadId: thread.threadId });
    await refresh(); notify("Conversation deleted", "success");
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function deleteProject(project: ProjectItem): Promise<void> {
  const message = h("div", { class: "easy-code-confirm__body" }, [
    h("p", "This project will be removed from EASY CODE along with its conversations and associated memories."),
    h("div", { class: "easy-code-confirm__target" }, [h("strong", project.name), h("small", project.root)]),
    h("small", "The folder and its source files will not be deleted."),
  ]);
  try { await ElMessageBox.confirm(message, "Remove project?", {
    customClass: "easy-code-confirm", showClose: false, closeOnClickModal: false,
    cancelButtonText: "Keep project", confirmButtonText: "Remove project",
    confirmButtonClass: "easy-code-confirm__danger",
  }); }
  catch { return; }
  try {
    await request("/api/project/delete", { projectId: project.id, confirmRoot: project.root });
    await refresh(); notify("Project removed", "success");
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function decide(id: string, value: string | undefined): Promise<void> {
  try {
    const result = await request<{ accepted: boolean }>("/api/decision", { threadId: activeThread.value, id, value });
    if (!result.accepted) throw new Error("That decision is no longer available.");
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function decidePlan(action: "approve" | "reject" | "adjust" | "defer"): Promise<void> {
  let feedback: string | undefined;
  if (action === "adjust") {
    try { feedback = (await ElMessageBox.prompt("What should change in the plan?", "Request plan changes", { inputPattern: /\S/u, inputErrorMessage: "Describe the changes" })).value.trim(); }
    catch { return; }
    if (!feedback) return;
  }
  try {
    await request("/api/plan", { threadId: activeThread.value, action, feedback });
    plan.value = null;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
function elapsed(startedAt: number): string { return `${Math.max(0, Math.floor((now.value - startedAt) / 1000))}s`; }
function noticePreview(text: string): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine;
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">E</span><div><strong>EASY CODE</strong><small>Local coding agent</small></div></div>
      <div class="sidebar-heading project-heading"><span>PROJECTS</span><ElButton class="project-add" text :icon="Plus" title="Add local project folder" aria-label="Add local project folder" :disabled="switching" @click="addProject" /></div>
      <nav class="thread-list" aria-label="Projects and conversations">
        <section v-for="project in projects" :key="project.id" class="project-group">
          <div class="project-row" :class="{ current: activeProject?.id === project.id }">
            <ElButton class="project-toggle" text :title="project.root" :aria-expanded="expandedProjects.has(project.id)" @click="toggleProject(project.id)">
              <FolderOpened v-if="expandedProjects.has(project.id)" class="project-folder" /><Folder v-else class="project-folder" /><span class="project-name">{{ project.name }}</span><Loading v-if="projectRunning(project.id)" class="project-loading" aria-label="Project is active" />
            </ElButton>
            <ElButton class="project-action project-action--add" text :icon="Plus" title="New conversation in this project" aria-label="New conversation in this project" :disabled="switching" @click="switchThread('new', undefined, project.id)" />
            <ElButton class="project-action" text :icon="Edit" title="Rename project" aria-label="Rename project" :disabled="switching" @click="renameProject(project)" />
            <ElButton class="project-action danger" text :icon="Delete" title="Remove project and conversations" aria-label="Remove project and conversations" :disabled="switching" @click="deleteProject(project)" />
          </div>
          <div v-if="expandedProjects.has(project.id)" class="project-threads">
            <div v-for="thread in projectThreads(project.id)" :key="thread.threadId" class="thread-item" :class="{ active: activeThread === thread.threadId }">
              <ElButton class="thread-row" text :disabled="switching" :title="thread.threadId" @click="switchThread('resume', thread.threadId)">
                <Loading v-if="runningThreadIds.has(thread.threadId)" class="thread-loading" /><span v-else class="thread-icon">◌</span><span>{{ thread.title }}</span>
              </ElButton>
              <ElButton v-if="thread.canRename" class="project-action" text :icon="Edit" title="Name conversation" aria-label="Name conversation" :disabled="switching" @click="renameThread(thread)" />
              <ElButton class="project-action danger" text :icon="Delete" title="Delete conversation and its memory" aria-label="Delete conversation and its memory" :disabled="switching" @click="deleteThread(thread)" />
            </div>
          </div>
        </section>
      </nav>
      <div class="sidebar-footer"><span :class="connected ? 'online-dot' : 'offline-dot'"></span>{{ connected ? 'Local connection active' : 'Reconnecting…' }}</div>
    </aside>

    <main class="main-column">
      <header class="topbar">
        <div><h1>{{ headerTitle }}</h1><p>{{ session ? `Mode: ${session.mode} · Environment: ${session.commandEnvironment} · Tasks: ${taskCount} · Agents: ${liveAgents.length}` : activeProject?.root || 'Choose a local working folder' }}</p></div>
        <div class="top-actions"><span class="context-pill">ctx {{ session?.contextTokens ?? 0 }}</span></div>
      </header>

      <div v-if="loading" class="loading-state">Connecting to EASY CODE…</div>
      <div v-else class="transcript-frame">
        <MessageRail :markers="history.markers" :visible-ids="visibleMessageIds" @navigate="jumpToEntry" />
        <ElButton v-if="archiveEntries" class="return-to-latest" round @click="returnToLatest">Back to latest messages</ElButton>
        <div ref="transcript" class="transcript" @scroll="onScroll" @toggle.capture="updateVisibleMessages">
          <div class="conversation-width">
            <div v-if="archiveEntries ? archiveHasEarlier : history.hasEarlier" class="history-load"><ElButton text :loading="historyLoading" @click="loadOlder">Load earlier messages</ElButton></div>
            <div v-if="!conversationEntries.length && !(archiveEntries ? archiveHasEarlier : history.hasEarlier)" class="empty-state"><div class="empty-symbol">✦</div><h2>{{ activeThread ? 'What would you like to work on?' : activeProject ? 'Open a conversation' : 'Add a local project' }}</h2><p>{{ activeThread ? 'Ask about your code, make a change, or explore this workspace.' : activeProject ? 'Choose an existing conversation or create one with the + button.' : 'Use the + next to Projects to choose a working folder.' }}</p></div>
            <TranscriptEntry v-for="entry in conversationEntries" :key="entry.id" :entry="entry" />
            <div v-if="archiveEntries && archiveHasLater" class="history-load"><ElButton text :loading="historyLoading" @click="loadNewer">Load newer messages</ElButton></div>
            <section v-if="plan" class="plan-actions"><strong>Plan awaiting your decision</strong><div><ElButton type="primary" @click="decidePlan('approve')">Approve and run</ElButton><ElButton @click="decidePlan('adjust')">Request changes</ElButton><ElButton type="danger" plain @click="decidePlan('reject')">Reject</ElButton><ElButton @click="decidePlan('defer')">Later</ElButton></div></section>
          </div>
        </div>
        <ElCard v-if="monitorActive" class="task-monitor-card" shadow="always">
          <section v-if="view.tasks" class="monitor-section"><h3>Tasks {{ view.tasks.completed }}/{{ view.tasks.total }}</h3><ul><li v-for="task in view.tasks.tasks" :key="task.id">{{ task.status === 'completed' ? '✓' : '○' }} {{ task.title }}<div v-if="agentForTask(task.id)" class="task-agent">{{ agentForTask(task.id)?.taskTitle }} · {{ agentStatus(agentForTask(task.id)!) }}</div></li></ul></section>
          <section v-if="unassignedAgents.length" class="monitor-section"><h3>Subagents</h3><ul><li v-for="agent in unassignedAgents" :key="agent.id">{{ agent.taskTitle }} · {{ agentStatus(agent) }}</li></ul></section>
          <section v-if="view.review" class="monitor-section"><h3>Reviewer</h3><p>{{ reviewLabel }} · {{ elapsed(view.review.startedAt) }}</p></section>
          <section v-if="view.activities.length" class="monitor-section"><h3>In progress</h3><ul><li v-for="activity in view.activities" :key="activity.id">{{ activity.text }}</li></ul></section>
        </ElCard>
        <ElCard v-if="commandOutput.length && !commandOutputDismissed && !selectedCommand" class="command-output-overlay" shadow="always" aria-label="Command output">
          <div class="command-output-heading"><strong>{{ commandOutputLabel || 'Command output' }}</strong><ElButton text circle :icon="Close" aria-label="Close command output" @click="commandOutputDismissed = true" /></div>
          <div class="command-output-body"><pre v-for="entry in commandOutput" :key="entry.id">{{ entry.text }}</pre></div>
        </ElCard>
      </div>
      <Composer ref="composer" :busy="view.busy" :thread-id="activeThread" :model-label="modelLabel" :approval-label="approvalLabel" :orchestration-label="orchestrationLabel" :settings-disabled="!activeThread || view.busy || switching || !!view.decision" :decision="selectedCommand?.name === 'mcp' ? null : view.decision" :commands="commands" @send="send" @stop="stop" @select-model="chooseSetting('model')" @select-approval="chooseSetting('approval')" @select-orchestration="chooseSetting('orchestration')" @open-command="openCommand" @submit-decision="decide" @error="error = $event">
        <template #command-panel><CommandPanel v-if="selectedCommand" :command="selectedCommand" :commands="commands" :entries="commandOutput" :decision="view.decision" :session="session" :running="!!activeThread && runningThreadIds.has(activeThread)" @execute="executePanelCommand" @close="closeCommand" @decide="decide" @cancel-external="cancelExternalCommand" /></template>
      </Composer>
    </main>
  </div>
</template>
