<script setup lang="ts">
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ElButton, ElCard, ElDialog, ElInput, ElMessageBox, ElNotification, ElOption, ElSelect } from "element-plus";
import { Close, Delete, Edit, Fold, Folder, FolderOpened, Loading, Plus } from "@element-plus/icons-vue";
import type { WebEntry, WebHistoryState, WebPatch, WebView } from "../web-contracts.js";
import type { WebCommandEntry } from "../web-command-catalog.js";
import type { PlanProposal } from "../core/types.js";
import { bootstrap, fetchHistoryPage, request, type ProjectItem, type ThreadItem, type WebSnapshot } from "./api.js";
import { activeMessageIdsForViewport, displayProject, displayTitle, groupConversationTurns, isConversationEntry, isNoticeEntry, toolRunContinuesAcross, turnContinuesAcross } from "./display-content.js";
import { useOutsideDismiss } from "./use-outside-dismiss.js";
import { language, setLanguage, t } from "./i18n.js";
import { parseLanguage, type Language } from "../i18n/language.js";
import Composer from "./components/Composer.vue";
import CommandPanel from "./components/CommandPanel.vue";
import MessageRail from "./components/MessageRail.vue";
import ConversationTurn from "./components/ConversationTurn.vue";

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
const commandOutputRoot = ref<{ $el: HTMLElement }>();
let commandCaptureThreadId: string | undefined;
let commandRunSeen = false;
useOutsideDismiss(commandOutputRoot, () => { commandOutputDismissed.value = true; });
let activeNotification: ReturnType<typeof ElNotification> | undefined;
const runningThreadIds = ref<Set<string>>(new Set());
const expandedProjects = ref<Set<string>>(new Set());
const selectedProjectId = ref<string>();
interface ProjectEditorFolder {
  clientId: string;
  folderId?: string;
  key: string;
  path: string;
}
interface ProjectEditorDraft {
  projectId: string;
  name: string;
  folders: ProjectEditorFolder[];
  primaryClientId?: string;
}
const projectEditor = ref<ProjectEditorDraft | null>(null);
const projectEditorOpen = ref(false);
const plan = ref<PlanProposal | null>(null);
const error = ref("");
const connected = ref(false);
const loading = ref(true);
const switching = ref(false);
const sidebarCollapsed = ref(false);
const transcript = ref<HTMLElement>();
const visibleMessageIds = ref<Set<string>>(new Set());
const composer = ref<InstanceType<typeof Composer>>();
const now = ref(Date.now());
let timer: number | undefined;
let events: EventSource | undefined;
let sequence = -1;
let keepBottom = true;
const MAX_LIVE_ENTRIES = 200;
const EMPTY_THREAD_TITLES = [
  "ui.emptyThreadTitle", "ui.emptyThreadTitleIdea", "ui.emptyThreadTitleSmallChange",
  "ui.emptyThreadTitleFeature", "ui.emptyThreadTitleHelp", "ui.emptyThreadTitleStuck",
  "ui.emptyThreadTitleForward", "ui.emptyThreadTitleExplore",
] as const;
const emptyThreadTitleIndex = ref(0);
const emptyThreadOpenSerial = ref(0);
function pickEmptyThreadTitle(): void {
  emptyThreadTitleIndex.value = Math.floor(Math.random() * EMPTY_THREAD_TITLES.length);
  emptyThreadOpenSerial.value += 1;
}

const session = computed(() => view.value.session);
const displayedEntries = computed(() => archiveEntries.value ?? view.value.entries);
const conversationEntries = computed(() => displayedEntries.value.filter(isConversationEntry));
const conversationTurns = computed(() => groupConversationTurns(conversationEntries.value));
const activeThread = computed(() => session.value?.threadId);
const selectedCommand = computed(() => commands.value.find(command => command.name === commandPanelName.value));
const sortedThreads = computed(() => [...threads.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
const activeProject = computed(() => displayProject(
  activeThread.value, session.value?.workspaceRoot, threads.value, projects.value, selectedProjectId.value,
));
const editingProject = computed(() => projects.value.find(project => project.id === projectEditor.value?.projectId));
const headerTitle = computed(() => displayTitle(activeThread.value, activeProject.value, threads.value));
const reviewLabel = computed(() => view.value.review?.phase === "main_brief"
  ? t("ui.reviewBrief") : t("ui.reviewInspect"));
const taskCount = computed(() => view.value.tasks?.tasks.length ?? 0);
const modelLabel = computed(() => session.value
  ? `${session.value.provider}/${session.value.model} · ${session.value.thinkingEffort === "none" ? t("ui.effortNone") :
    session.value.thinkingEffort === "low" ? t("ui.effortLow") : session.value.thinkingEffort === "medium" ? t("ui.effortMedium") : t("ui.effortHigh")}` : t("ui.model"));
const modeLabel = computed(() => session.value?.mode === "plan" ? t("ui.modePlan")
  : session.value?.mode === "code" ? t("ui.modeCode") : t("ui.modeAuto"));
const environmentLabel = computed(() => session.value?.commandEnvironment === "host" ? t("ui.environmentHost")
  : session.value?.commandEnvironment === "container" ? t("ui.environmentContainer") : t("ui.environmentSandbox"));
const approvalLabel = computed(() => {
  switch (session.value?.commandExecutionMode) {
    case "auto_approve": return t("ui.approvalAgent");
    case "unrestricted": return t("ui.fullAccess");
    default: return t("ui.manualApproval");
  }
});
const orchestrationLabel = computed(() => session.value?.orchestrationEnabled ? t("ui.dagOn") : t("ui.dagOff"));
const liveAgents = computed(() => view.value.subagents.filter(agent => agent.status === "running" || agent.status === "stopping"));
const monitorActive = computed(() => view.value.tasks !== null || liveAgents.value.length > 0 || view.value.review !== null || view.value.activities.length > 0);
const unassignedAgents = computed(() => liveAgents.value.filter(agent => !view.value.tasks?.tasks.some(task => task.id === agent.taskId && agent.assignmentKind === "dag")));
function projectRunning(projectId: string): boolean {
  return projectThreads(projectId).some(thread => runningThreadIds.value.has(thread.threadId));
}
function agentForTask(taskId: string) { return liveAgents.value.find(agent => agent.assignmentKind === "dag" && agent.taskId === taskId); }
function agentStatus(agent: (typeof liveAgents.value)[number]): string {
  const activity = agent.activity;
  return `${activity?.kind === "thinking" ? t("ui.thinking") : activity?.kind === "tool" ? `${t("ui.tool")}: ${activity.label ?? t("ui.working")}` : agent.status} · ${elapsed(Date.parse(activity?.startedAt ?? agent.startedAt))}`;
}

function notify(text: string, kind: "success" | "warning" | "error"): void {
  activeNotification?.close();
  activeNotification = ElNotification({
    title: kind === "error" ? t("ui.errorTitle") : kind === "warning" ? t("ui.noticeTitle") : t("ui.doneTitle"),
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
  setLanguage(snapshot.language);
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
    selectedProjectId.value = snapshot.view.session.projectId ??
      snapshot.projects.find(project => project.root === snapshot.view.session?.workspaceRoot)?.id;
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
      let start = entries.length - MAX_LIVE_ENTRIES;
      while (start > 0 && (turnContinuesAcross(entries, start) || toolRunContinuesAcross(entries, start))) start -= 1;
      entries = entries.slice(start);
      history.value = { ...history.value, hasEarlier: true };
      historyExpanded.value = false;
    }
    view.value = { ...view.value, entries };
    if (patch.entry.kind === "user" && !history.value.markers.some(marker => marker.id === patch.entry.id)) {
      history.value = { ...history.value, markers: [...history.value.markers, {
        id: patch.entry.id,
        preview: (patch.entry.text.replace(/\s+/gu, " ").trim() || (patch.entry.images?.length ? t("ui.imageAttachment") : t("ui.yourMessage"))).slice(0, 120),
      }] };
    }
    if (isNoticeEntry(patch.entry)) {
      if (commandCaptureThreadId === activeThread.value && (patch.entry.kind === "info" || commandPanelName.value))
        commandOutput.value = [...commandOutput.value, patch.entry].slice(-20);
      else if (patch.entry.kind !== "info") notify(patch.entry.text, patch.entry.kind);
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
  events.addEventListener("language", event => {
    setLanguage(parseLanguage((JSON.parse((event as MessageEvent).data) as { language: string }).language));
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
watch(activeThread, (next, previous) => {
  if (next === previous) return;
  resetCommandOutput();
  commandPanelName.value = null;
  if (next) pickEmptyThreadTitle();
});
onMounted(() => {
  void start();
  timer = window.setInterval(() => { now.value = Date.now(); }, 1000);
  window.addEventListener("resize", updateVisibleMessages);
});
onUnmounted(() => {
  activeNotification?.close();
  events?.close(); if (timer) clearInterval(timer);
  window.removeEventListener("resize", updateVisibleMessages);
});
function updateVisibleMessages(): void {
  const viewport = transcript.value;
  if (!viewport) { visibleMessageIds.value = new Set(); return; }
  const bounds = viewport.getBoundingClientRect();
  const users = [...viewport.querySelectorAll<HTMLElement>(".entry--user[data-entry-id]")].flatMap(element => {
    const id = element.dataset.entryId;
    if (!id) return [];
    const box = element.getBoundingClientRect();
    return [{ id, top: box.top, bottom: box.bottom }];
  });
  const turns = [...viewport.querySelectorAll<HTMLElement>(".conversation-turn[data-user-entry-id]")].map(element => {
    const box = element.getBoundingClientRect();
    return { requestId: element.dataset.userEntryId, top: box.top, bottom: box.bottom };
  });
  visibleMessageIds.value = new Set(activeMessageIdsForViewport(
    { top: bounds.top, bottom: bounds.bottom }, users, turns));
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
  const hiddenProcess = element.closest<HTMLDetailsElement>("details.turn-process:not([open])");
  if (hiddenProcess) {
    hiddenProcess.open = true;
    await nextTick();
  }
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
async function send(text: string, imageIds: string[], resourceIds: string[]): Promise<void> {
  if (!activeThread.value) return;
  if (archiveEntries.value) await returnToLatest();
  const threadId = activeThread.value;
  const command = webCommandName(text);
  if (command && view.value.busy) {
    composer.value?.failed();
    error.value = t("ui.waitCurrent");
    return;
  }
  if (command) beginCommandOutput(`/${command}`); else resetCommandOutput();
  try {
    const route = view.value.busy ? "/api/adjustment" : "/api/message";
    await request(route, { threadId, text, imageIds, resourceIds });
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
async function changeLanguage(value: string): Promise<void> {
  try {
    const requested = parseLanguage(value);
    const result = await request<{ language: Language }>("/api/command", { text: `/language ${requested}` });
    setLanguage(result.language);
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function switchThread(action: "new" | "resume", threadId?: string, projectId?: string): Promise<void> {
  if (switching.value) return;
  const previousThreadId = activeThread.value;
  switching.value = true;
  try {
    await request("/api/thread", { action, ...(threadId ? { threadId } : {}), ...(projectId ? { projectId } : {}) });
    error.value = "";
    await refresh();
    if (action === "resume" && threadId === previousThreadId && activeThread.value === threadId)
      pickEmptyThreadTitle();
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
  let name: string;
  try { ({ value: name } = await ElMessageBox.prompt(t("ui.newProjectPrompt"), t("ui.newProjectTitle"), {
    inputValue: t("ui.untitledProject"), inputPattern: /\S/u, inputErrorMessage: t("ui.enterName"),
  })); } catch { return; }
  switching.value = true;
  try {
    const result = await request<{ project: ProjectItem }>("/api/project/add", { name: name.trim() });
    selectedProjectId.value = result.project.id;
    expandedProjects.value = new Set([...expandedProjects.value, result.project.id]);
    error.value = "";
    await refresh();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { switching.value = false; }
}
function openProjectEditor(project: ProjectItem): void {
  const folders = (project.folders ?? []).filter(item => item.active).map(item => ({
    clientId: item.id, folderId: item.id, key: item.key, path: item.path,
  }));
  projectEditor.value = {
    projectId: project.id,
    name: project.name,
    folders,
    primaryClientId: folders.find(item => item.folderId === project.primaryFolderId)?.clientId ?? folders[0]?.clientId,
  };
  projectEditorOpen.value = true;
}
function folderName(folder: ProjectEditorFolder): string {
  const value = folder.path.replace(/[\\/]+$/gu, "");
  return value.split(/[\\/]/gu).pop() || folder.key;
}
async function addProjectFolder(): Promise<void> {
  const editor = projectEditor.value;
  if (!editor || switching.value) return;
  switching.value = true;
  try {
    const folder = (await request<{ path: string | null }>("/api/folder/pick", {})).path;
    if (!folder) return;
    const normalized = folder.replace(/[\\/]+$/gu, "").toLocaleLowerCase();
    if (editor.folders.some(item => item.path.replace(/[\\/]+$/gu, "").toLocaleLowerCase() === normalized)) {
      notify(t("ui.folderAlreadyAdded"), "warning"); return;
    }
    const added = { clientId: `draft-folder-${Date.now()}-${Math.random()}`, key: folderName({ clientId: "", key: "", path: folder }), path: folder };
    editor.folders.push(added);
    editor.primaryClientId ??= added.clientId;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { switching.value = false; }
}
function removeProjectFolder(clientId: string): void {
  const editor = projectEditor.value;
  if (!editor) return;
  editor.folders = editor.folders.filter(folder => folder.clientId !== clientId);
  if (editor.primaryClientId === clientId) editor.primaryClientId = editor.folders[0]?.clientId;
}
function setPrimaryProjectFolder(clientId: string): void {
  if (projectEditor.value?.folders.some(folder => folder.clientId === clientId)) projectEditor.value.primaryClientId = clientId;
}
async function saveProjectEditor(): Promise<void> {
  const editor = projectEditor.value;
  if (!editor || switching.value || !editor.name.trim()) return;
  const primary = editor.folders.find(folder => folder.clientId === editor.primaryClientId);
  switching.value = true;
  try {
    await request("/api/project/edit", {
      projectId: editor.projectId,
      name: editor.name.trim(),
      retainedFolderIds: editor.folders.flatMap(folder => folder.folderId ? [folder.folderId] : []),
      addedFolderPaths: editor.folders.flatMap(folder => folder.folderId ? [] : [folder.path]),
      ...(primary?.folderId ? { primaryFolderId: primary.folderId } : primary ? { primaryFolderPath: primary.path } : {}),
    });
    projectEditorOpen.value = false;
    await refresh(); notify(t("ui.projectSaved"), "success");
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { switching.value = false; }
}
async function renameThread(thread: ThreadItem): Promise<void> {
  let name: string;
  try { ({ value: name } = await ElMessageBox.prompt(t("ui.permanentName"), t("ui.renameConversationTitle"), { inputValue: thread.title, inputPattern: /\S/u, inputErrorMessage: t("ui.enterName") })); }
  catch { return; }
  name = name.trim();
  if (!name || name === thread.title) return;
  try { await request("/api/thread/rename", { threadId: thread.threadId, name }); await refresh(); notify(t("ui.conversationNamed"), "success"); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function deleteThread(thread: ThreadItem): Promise<void> {
  const message = h("div", { class: "easy-code-confirm__body" }, [
    h("p", t("ui.deleteConversationBody")),
    h("div", { class: "easy-code-confirm__target" }, thread.title),
    h("small", t("ui.filesUnchanged")),
  ]);
  try { await ElMessageBox.confirm(message, t("ui.deleteConversationQuestion"), {
    customClass: "easy-code-confirm", showClose: false, closeOnClickModal: false,
    cancelButtonText: t("ui.keepConversation"), confirmButtonText: t("ui.deleteConversationTitle"),
    confirmButtonClass: "easy-code-confirm__danger",
  }); }
  catch { return; }
  try {
    await request("/api/thread/delete", { threadId: thread.threadId, confirmThreadId: thread.threadId });
    await refresh(); notify(t("ui.conversationDeleted"), "success");
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function deleteProject(project: ProjectItem): Promise<boolean> {
  const message = h("div", { class: "easy-code-confirm__body" }, [
    h("p", t("ui.removeProjectBody")),
    h("div", { class: "easy-code-confirm__target" }, h("strong", project.name)),
    h("small", t("ui.folderUnchanged")),
  ]);
  try { await ElMessageBox.confirm(message, t("ui.removeProjectQuestion"), {
    customClass: "easy-code-confirm", showClose: false, closeOnClickModal: false,
    cancelButtonText: t("ui.keepProject"), confirmButtonText: t("ui.removeProjectTitle"),
    confirmButtonClass: "easy-code-confirm__danger",
  }); }
  catch { return false; }
  try {
    await request("/api/project/delete", { projectId: project.id, confirmProjectId: project.id });
    projectEditorOpen.value = false;
    await refresh(); notify(t("ui.projectRemoved"), "success"); return true;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); return false; }
}
async function decide(id: string, value: string | undefined): Promise<void> {
  try {
    const result = await request<{ accepted: boolean }>("/api/decision", { threadId: activeThread.value, id, value });
    if (!result.accepted) throw new Error(t("ui.decisionExpired"));
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function decidePlan(action: "approve" | "reject" | "adjust"): Promise<void> {
  let feedback: string | undefined;
  if (action === "adjust") {
    try { feedback = (await ElMessageBox.prompt(t("ui.planPrompt"), t("ui.planPromptTitle"), { inputPattern: /\S/u, inputErrorMessage: t("ui.planPromptError") })).value.trim(); }
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
  <div class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <aside class="sidebar">
      <Transition name="sidebar-brand" mode="out-in">
        <div v-if="sidebarCollapsed" class="brand brand--collapsed">
          <ElButton class="brand-expand" text :title="t('ui.expandSidebar')" :aria-label="t('ui.expandSidebar')" @click="sidebarCollapsed = false">
            <img class="brand-mark" src="/easy-code-icon.svg?v=origami-dog" alt="" aria-hidden="true" />
          </ElButton>
        </div>
        <div v-else class="brand brand--expanded">
          <img class="brand-mark" src="/easy-code-icon.svg?v=origami-dog" alt="" aria-hidden="true" />
          <div class="brand-copy"><strong>EASY CODE</strong><small>{{ t('ui.localAgent') }}</small></div>
          <ElButton class="brand-collapse" text :icon="Fold" :title="t('ui.collapseSidebar')" :aria-label="t('ui.collapseSidebar')" @click="sidebarCollapsed = true" />
        </div>
      </Transition>
      <Transition name="sidebar-content">
        <div v-if="!sidebarCollapsed" class="sidebar-content">
          <div class="sidebar-heading project-heading"><span>{{ t('ui.projects') }}</span><ElButton class="project-add" text :icon="Plus" :title="t('ui.addProject')" :aria-label="t('ui.addProject')" :disabled="switching" @click="addProject" /></div>
          <nav class="thread-list" :aria-label="t('ui.projectNavigation')">
        <section v-for="project in projects" :key="project.id" class="project-group">
          <div class="project-row" :class="{ current: activeProject?.id === project.id }">
            <ElButton class="project-toggle" text :title="project.name" :aria-expanded="expandedProjects.has(project.id)" @click="toggleProject(project.id)">
              <FolderOpened v-if="expandedProjects.has(project.id)" class="project-folder" /><Folder v-else class="project-folder" /><span class="project-name">{{ project.name }}</span><Loading v-if="projectRunning(project.id)" class="project-loading" :aria-label="t('ui.projectActive')" />
            </ElButton>
            <ElButton class="project-action project-action--add" text :icon="Plus" :title="project.ready === false ? t('ui.attachFolderFirst') : t('ui.newConversation')" :aria-label="t('ui.newConversation')" :disabled="switching || project.ready === false" @click="switchThread('new', undefined, project.id)" />
            <ElButton class="project-action" text :icon="Edit" :title="t('ui.editProject')" :aria-label="t('ui.editProject')" :disabled="switching" @click="openProjectEditor(project)" />
            <ElButton class="project-action danger" text :icon="Delete" :title="t('ui.removeProject')" :aria-label="t('ui.removeProject')" :disabled="switching || projectRunning(project.id)" @click="deleteProject(project)" />
          </div>
          <div v-if="expandedProjects.has(project.id)" class="project-threads">
            <div v-for="thread in projectThreads(project.id)" :key="thread.threadId" class="thread-item" :class="{ active: activeThread === thread.threadId }">
              <ElButton class="thread-row" text :disabled="switching" :title="thread.threadId" @click="switchThread('resume', thread.threadId)">
                <Loading v-if="runningThreadIds.has(thread.threadId)" class="thread-loading" /><span v-else class="thread-icon">◌</span><span>{{ thread.title }}</span>
              </ElButton>
              <ElButton v-if="thread.canRename" class="project-action" text :icon="Edit" :title="t('ui.nameConversation')" :aria-label="t('ui.nameConversation')" :disabled="switching" @click="renameThread(thread)" />
              <ElButton class="project-action danger" text :icon="Delete" :title="t('ui.deleteConversation')" :aria-label="t('ui.deleteConversation')" :disabled="switching" @click="deleteThread(thread)" />
            </div>
          </div>
        </section>
          </nav>
          <div class="sidebar-footer"><span :class="connected ? 'online-dot' : 'offline-dot'"></span>{{ connected ? t('ui.connected') : t('ui.reconnecting') }}</div>
        </div>
      </Transition>
    </aside>

    <main class="main-column">
      <header class="topbar">
        <div><h1>{{ headerTitle }}</h1><p>{{ session ? `${t('ui.mode')}: ${modeLabel} · ${t('ui.environment')}: ${environmentLabel} · ${t('ui.tasks')}: ${taskCount} · ${t('ui.agents')}: ${liveAgents.length} · ctx ${session.contextTokens ?? 0}` : activeProject ? (activeProject.ready === false ? t('ui.attachFolderHint') : t('ui.emptyProjectHint')) : t('ui.emptyNoProjectHint') }}</p></div>
        <div class="top-actions"><ElSelect class="language-switcher" :model-value="language" :aria-label="t('ui.selectLanguage')" @change="changeLanguage"><ElOption label="English" value="en_us" /><ElOption label="简体中文" value="zh_cn" /></ElSelect></div>
      </header>

      <div v-if="loading" class="loading-state">{{ t('ui.connecting') }}</div>
      <div v-else class="transcript-frame">
        <MessageRail :markers="history.markers" :visible-ids="visibleMessageIds" @navigate="jumpToEntry" />
        <ElButton v-if="archiveEntries" class="return-to-latest" round @click="returnToLatest">{{ t('ui.backToLatest') }}</ElButton>
        <div ref="transcript" class="transcript" @scroll="onScroll" @toggle.capture="updateVisibleMessages">
          <div class="conversation-width">
            <div v-if="archiveEntries ? archiveHasEarlier : history.hasEarlier" class="history-load"><ElButton text :loading="historyLoading" @click="loadOlder">{{ t('ui.loadEarlier') }}</ElButton></div>
            <Transition name="empty-state" mode="out-in">
              <div v-if="!conversationEntries.length && !(archiveEntries ? archiveHasEarlier : history.hasEarlier)" :key="`${activeThread ?? activeProject?.id ?? 'no-project'}:${emptyThreadOpenSerial}`" class="empty-state"><img class="empty-symbol" src="/easy-code-icon.svg?v=origami-dog" alt="" aria-hidden="true" /><h2>{{ activeThread ? t(EMPTY_THREAD_TITLES[emptyThreadTitleIndex]!) : activeProject ? t('ui.emptyProjectTitle') : t('ui.emptyNoProjectTitle') }}</h2><p>{{ activeThread ? t('ui.emptyThreadHint') : activeProject ? t('ui.emptyProjectHint') : t('ui.emptyNoProjectHint') }}</p></div>
            </Transition>
            <ConversationTurn v-for="turn in conversationTurns" :key="turn.id" :turn="turn" />
            <div v-if="archiveEntries && archiveHasLater" class="history-load"><ElButton text :loading="historyLoading" @click="loadNewer">{{ t('ui.loadNewer') }}</ElButton></div>
            <section v-if="plan" class="plan-actions"><strong>{{ t('ui.planAwaiting') }}</strong><div><ElButton type="primary" @click="decidePlan('approve')">{{ t('ui.approveRun') }}</ElButton><ElButton @click="decidePlan('adjust')">{{ t('ui.requestChanges') }}</ElButton><ElButton type="danger" plain @click="decidePlan('reject')">{{ t('ui.reject') }}</ElButton></div></section>
          </div>
        </div>
        <ElCard v-if="monitorActive" class="task-monitor-card" shadow="always">
          <section v-if="view.tasks" class="monitor-section"><h3>{{ t('ui.tasks') }} {{ view.tasks.completed }}/{{ view.tasks.total }}</h3><ul><li v-for="task in view.tasks.tasks" :key="task.id">{{ task.status === 'completed' ? '✓' : '○' }} {{ task.title }}<div v-if="agentForTask(task.id)" class="task-agent">{{ agentForTask(task.id)?.taskTitle }} · {{ agentStatus(agentForTask(task.id)!) }}</div></li></ul></section>
          <section v-if="unassignedAgents.length" class="monitor-section"><h3>{{ t('ui.subagents') }}</h3><ul><li v-for="agent in unassignedAgents" :key="agent.id">{{ agent.taskTitle }} · {{ agentStatus(agent) }}</li></ul></section>
          <section v-if="view.review" class="monitor-section"><h3>{{ t('ui.reviewer') }}</h3><p>{{ reviewLabel }} · {{ elapsed(view.review.startedAt) }}</p></section>
          <section v-if="view.activities.length" class="monitor-section"><h3>{{ t('ui.inProgress') }}</h3><ul><li v-for="activity in view.activities" :key="activity.id">{{ activity.text }}</li></ul></section>
        </ElCard>
        <ElCard v-if="commandOutput.length && !commandOutputDismissed && !selectedCommand" ref="commandOutputRoot" class="command-output-overlay" shadow="always" :aria-label="t('ui.commandOutput')">
          <div class="command-output-heading"><strong>{{ commandOutputLabel || t('ui.commandOutput') }}</strong></div>
          <div class="command-output-body"><pre v-for="entry in commandOutput" :key="entry.id">{{ entry.text }}</pre></div>
        </ElCard>
      </div>
      <Composer ref="composer" :busy="view.busy" :thread-id="activeThread" :model-label="modelLabel" :approval-label="approvalLabel" :orchestration-label="orchestrationLabel" :settings-disabled="!activeThread || view.busy || switching || !!view.decision" :decision="selectedCommand?.name === 'mcp' ? null : view.decision" :commands="commands" @send="send" @stop="stop" @select-model="chooseSetting('model')" @select-approval="chooseSetting('approval')" @select-orchestration="chooseSetting('orchestration')" @open-command="openCommand" @submit-decision="decide" @error="error = $event">
        <template #command-panel><CommandPanel v-if="selectedCommand" :command="selectedCommand" :commands="commands" :entries="commandOutput" :decision="view.decision" :session="session" :running="!!activeThread && runningThreadIds.has(activeThread)" @execute="executePanelCommand" @close="closeCommand" @decide="decide" @cancel-external="cancelExternalCommand" /></template>
      </Composer>
    </main>
  </div>
  <ElDialog v-model="projectEditorOpen" class="project-editor-dialog" width="min(520px, calc(100vw - 28px))" :title="t('ui.editProjectTitle')" destroy-on-close @closed="projectEditor = null">
    <div v-if="projectEditor" class="project-editor-body">
      <label class="project-editor-field">
        <span>{{ t('ui.projectName') }}</span>
        <ElInput v-model="projectEditor.name" maxlength="120" :placeholder="t('ui.enterName')" />
      </label>
      <section class="project-editor-folders">
        <strong>{{ t('ui.sourceFolders') }}</strong>
        <div class="project-editor-folder-list">
          <div v-for="folder in projectEditor.folders" :key="folder.clientId" class="project-editor-folder" :title="folder.path">
            <Folder class="project-editor-folder-icon" />
            <span class="project-editor-folder-name">{{ folderName(folder) }}</span>
            <span v-if="folder.clientId === projectEditor.primaryClientId" class="project-editor-primary">{{ t('ui.primaryFolder') }}</span>
            <ElButton v-else class="project-editor-make-primary" text @click="setPrimaryProjectFolder(folder.clientId)">{{ t('ui.makePrimary') }}</ElButton>
            <ElButton class="project-editor-remove-folder" text :icon="Close" :title="t('ui.removeProjectFolder')" :aria-label="t('ui.removeProjectFolder')" @click="removeProjectFolder(folder.clientId)" />
          </div>
          <ElButton class="project-editor-add-folder" text :icon="Plus" :loading="switching" @click="addProjectFolder">{{ t('ui.addFolder') }}</ElButton>
        </div>
      </section>
    </div>
    <template #footer>
      <div class="project-editor-footer">
        <ElButton v-if="editingProject" class="project-editor-delete" type="danger" plain :disabled="switching || projectRunning(editingProject.id)" @click="deleteProject(editingProject)">{{ t('ui.removeProjectTitle') }}</ElButton>
        <span class="project-editor-footer-spacer"></span>
        <ElButton :disabled="switching" @click="projectEditorOpen = false">{{ t('ui.cancel') }}</ElButton>
        <ElButton type="primary" :loading="switching" :disabled="!projectEditor?.name.trim() || !!(editingProject && projectRunning(editingProject.id))" @click="saveProjectEditor">{{ t('ui.save') }}</ElButton>
      </div>
    </template>
  </ElDialog>
</template>
