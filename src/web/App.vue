<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { WebPatch, WebView } from "../web-contracts.js";
import type { PlanProposal } from "../core/types.js";
import { bootstrap, request, type ThreadItem, type WebSnapshot } from "./api.js";
import Composer from "./components/Composer.vue";
import DecisionDialog from "./components/DecisionDialog.vue";
import TranscriptEntry from "./components/TranscriptEntry.vue";

const view = ref<WebView>({ session: null, entries: [], tasks: null, subagents: [], activities: [], review: null, decision: null, busy: false });
const threads = ref<ThreadItem[]>([]);
const plan = ref<PlanProposal | null>(null);
const error = ref("");
const connected = ref(false);
const loading = ref(true);
const switching = ref(false);
const transcript = ref<HTMLElement>();
const composer = ref<InstanceType<typeof Composer>>();
const now = ref(Date.now());
let timer: number | undefined;
let events: EventSource | undefined;
let sequence = -1;
let keepBottom = true;

const session = computed(() => view.value.session);
const activeThread = computed(() => session.value?.threadId);
const sortedThreads = computed(() => [...threads.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
const reviewLabel = computed(() => view.value.review?.phase === "main_brief"
  ? "Main agent is preparing the reviewer brief" : "Reviewer is independently inspecting the workspace");
const taskCount = computed(() => view.value.tasks?.tasks.length ?? 0);

function applySnapshot(snapshot: WebSnapshot): void {
  sequence = snapshot.sequence;
  view.value = snapshot.view;
  threads.value = snapshot.threads;
  plan.value = snapshot.plan;
  loading.value = false;
  switching.value = false;
}
function applyPatch(patch: WebPatch, nextSequence: number): void {
  if (Number.isFinite(nextSequence) && nextSequence <= sequence) return;
  sequence = nextSequence;
  if (patch.kind === "entry.append") view.value = { ...view.value, entries: [...view.value.entries, patch.entry] };
  else if (patch.kind === "entry.replace") view.value = { ...view.value,
    entries: view.value.entries.map(entry => entry.id === patch.entry.id ? patch.entry : entry) };
  else if (patch.kind === "entries.reset") view.value = { ...view.value, entries: patch.entries };
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
    const before = view.value.busy;
    const beforeThread = view.value.session?.threadId;
    applyPatch(JSON.parse(message.data) as WebPatch, Number(message.lastEventId));
    if ((before && !view.value.busy) || beforeThread !== view.value.session?.threadId) void refresh();
  });
  events.onerror = () => { connected.value = false; };
  events.onopen = () => { connected.value = true; };
}
async function start(): Promise<void> {
  try { applySnapshot(await bootstrap()); connect(); }
  catch (reason) { loading.value = false; error.value = reason instanceof Error ? reason.message : String(reason); }
}
onMounted(() => { void start(); timer = window.setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { events?.close(); if (timer) clearInterval(timer); });
watch(() => [view.value.entries.length, view.value.entries.at(-1)?.text.length], async () => {
  if (!keepBottom) return;
  await nextTick(); transcript.value?.scrollTo({ top: transcript.value.scrollHeight, behavior: "instant" });
});
function onScroll(): void {
  const element = transcript.value;
  if (element) keepBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
}
async function send(text: string, imageIds: string[]): Promise<void> {
  try {
    const route = view.value.busy ? "/api/adjustment" : "/api/message";
    await request(route, { text, imageIds });
    composer.value?.sent();
    error.value = "";
  } catch (reason) {
    composer.value?.failed();
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}
async function stop(): Promise<void> {
  try { await request("/api/cancel", {}); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function quickCommand(command: string): Promise<void> {
  try { await request("/api/message", { text: command }); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function switchThread(action: "new" | "resume", threadId?: string): Promise<void> {
  if (switching.value) return;
  switching.value = true;
  try { await request("/api/thread", { action, ...(threadId ? { threadId } : {}) }); }
  catch (reason) { switching.value = false; error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function decide(id: string, value: string | undefined): Promise<void> {
  try {
    const result = await request<{ accepted: boolean }>("/api/decision", { id, value });
    if (!result.accepted) throw new Error("That decision is no longer available.");
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
async function decidePlan(action: "approve" | "reject" | "adjust" | "defer"): Promise<void> {
  let feedback: string | undefined;
  if (action === "adjust") {
    feedback = window.prompt("What should change in the plan?")?.trim();
    if (!feedback) return;
  }
  try {
    await request("/api/plan", { action, feedback });
    plan.value = null;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
function shortId(value: string): string { return value.slice(0, 8); }
function elapsed(startedAt: number): string { return `${Math.max(0, Math.floor((now.value - startedAt) / 1000))}s`; }
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">E</span><div><strong>EASY CODE</strong><small>Local coding agent</small></div></div>
      <button class="new-thread" :disabled="switching || view.busy" @click="switchThread('new')">＋ New conversation</button>
      <div class="sidebar-heading">WORKSPACE</div>
      <div class="workspace-name" :title="session?.workspaceRoot">▣ {{ session?.workspaceRoot || 'Loading…' }}</div>
      <div class="sidebar-heading">CONVERSATIONS</div>
      <nav class="thread-list" aria-label="Conversations">
        <button v-for="thread in sortedThreads" :key="thread.threadId" class="thread-row" :class="{ active: activeThread === thread.threadId }"
          :disabled="switching || view.busy" :title="thread.threadId" @click="switchThread('resume', thread.threadId)">
          <span class="thread-icon">◌</span><span>{{ thread.goal || `Thread ${shortId(thread.threadId)}` }}</span>
        </button>
      </nav>
      <div class="sidebar-footer"><span :class="connected ? 'online-dot' : 'offline-dot'"></span>{{ connected ? 'Local connection active' : 'Reconnecting…' }}</div>
    </aside>

    <main class="main-column">
      <header class="topbar">
        <div><h1>{{ session?.workspaceRoot?.split(/[\\/]/).at(-1) || 'EASY CODE' }}</h1><p>{{ session?.provider }}/{{ session?.model }} · {{ session?.mode }} · thinking {{ session?.thinkingEffort }}</p></div>
        <div class="top-actions"><span class="context-pill">ctx {{ session?.contextTokens ?? 0 }}</span><button class="ghost" @click="quickCommand('/model')">Model</button><button class="ghost" @click="quickCommand('/approval')">Permissions</button></div>
      </header>

      <div v-if="error" class="error-banner" role="alert">{{ error }} <button class="plain-link" @click="error = ''">Dismiss</button></div>
      <div v-if="loading" class="loading-state">Connecting to EASY CODE…</div>
      <div v-else ref="transcript" class="transcript" @scroll="onScroll">
        <div class="conversation-width">
          <div v-if="!view.entries.length" class="empty-state"><div class="empty-symbol">✦</div><h2>What would you like to work on?</h2><p>Ask about your code, make a change, or explore this workspace.</p></div>
          <TranscriptEntry v-for="entry in view.entries" :key="entry.id" :entry="entry" />
          <section v-if="plan" class="plan-actions"><strong>Plan awaiting your decision</strong><div><button @click="decidePlan('approve')">Approve and run</button><button class="ghost" @click="decidePlan('adjust')">Request changes</button><button class="ghost danger" @click="decidePlan('reject')">Reject</button><button class="ghost" @click="decidePlan('defer')">Later</button></div></section>
          <div v-if="view.review" class="live-note"><span class="pulse"></span>{{ reviewLabel }} · {{ elapsed(view.review.startedAt) }}</div>
          <div v-for="activity in view.activities" :key="activity.id" class="live-note"><span class="pulse"></span>{{ activity.text }}</div>
        </div>
      </div>
      <Composer ref="composer" :busy="view.busy" :thread-id="activeThread" @send="send" @stop="stop" @error="error = $event" />
      <footer class="statusbar"><span>{{ session?.mode ?? 'auto' }}</span><span>{{ session?.commandExecutionMode ?? 'manual' }}</span><span>{{ session?.commandEnvironment ?? 'sandbox' }}</span><span>{{ session?.model }}</span><span>tasks {{ taskCount }}</span><span>agents {{ view.subagents.length }}</span></footer>
    </main>

    <aside class="activity-sidebar">
      <div class="activity-header"><h2>Activity</h2><small>Thread {{ activeThread ? shortId(activeThread) : '—' }}</small></div>
      <section class="activity-section"><h3>Quick actions</h3>
        <div class="quick-actions"><button v-for="item in ['/mcp', '/skills', '/memory', '/tools', '/tasks', '/usage', '/changes', '/context']" :key="item" class="ghost" @click="quickCommand(item)">{{ item }}</button></div>
      </section>
      <section v-if="view.tasks" class="activity-section"><h3>Tasks {{ view.tasks.completed }}/{{ view.tasks.total }}</h3><ul><li v-for="task in view.tasks.tasks" :key="task.id">{{ task.status === 'completed' ? '✓' : '○' }} {{ task.title }}</li></ul></section>
      <section v-if="view.subagents.length" class="activity-section"><h3>Subagents</h3><ul><li v-for="agent in view.subagents" :key="agent.id">{{ agent.status }} · {{ agent.id }}</li></ul></section>
      <section v-if="view.review" class="activity-section"><h3>Reviewer</h3><p>{{ reviewLabel }}</p></section>
      <section class="activity-section activity-tip"><h3>Tip</h3><p>You can send an adjustment while the agent is working. It will be applied at the next model boundary.</p></section>
    </aside>
    <DecisionDialog v-if="view.decision" :decision="view.decision" @submit="decide" />
  </div>
</template>
