<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElButton, ElCard, ElDescriptions, ElDescriptionsItem, ElInput, ElMessageBox, ElOption, ElScrollbar, ElSelect, ElTabPane, ElTabs, ElTag } from "element-plus";
import { Close, Refresh } from "@element-plus/icons-vue";
import type { WebEntry, WebDecision } from "../../web-contracts.js";
import type { WebCommandEntry } from "../../web-command-catalog.js";
import type { UISessionInfo } from "../../ui/contracts.js";

const props = defineProps<{
  command: WebCommandEntry;
  commands: readonly WebCommandEntry[];
  entries: readonly WebEntry[];
  decision: WebDecision | null;
  session: UISessionInfo | null;
  running: boolean;
}>();
const emit = defineEmits<{
  execute: [text: string];
  close: [];
  decide: [id: string, value: string | undefined];
  cancelExternal: [];
}>();
const search = ref("");
const toolPage = ref(0);
const skillsTab = ref("user");
const memoryTab = ref("short");
const memoryLimit = ref("8");
const memoryScope = ref("all");
const panelRoot = ref<{ $el: HTMLElement }>();
const parsed = computed<unknown>(() => {
  for (const entry of [...props.entries].reverse()) {
    try { return JSON.parse(entry.text) as unknown; } catch { /* Other notices are not structured results. */ }
  }
  return null;
});
const objectData = computed<Record<string, unknown>>(() =>
  parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
    ? parsed.value as Record<string, unknown> : {});
const tools = computed(() => Array.isArray(parsed.value)
  ? (parsed.value as Record<string, unknown>[]).filter(item =>
      [item.name, item.description, item.source].some(value =>
        String(value ?? "").toLowerCase().includes(search.value.toLowerCase()))) : []);
const visibleTools = computed(() => tools.value.slice(toolPage.value * 40, (toolPage.value + 1) * 40));
const skills = computed(() => {
  const sections: Record<string, { directory: string; items: { name: string; description: string }[] }> = {
    user: { directory: "", items: [] }, project: { directory: "", items: [] },
  };
  let scope = "user";
  for (const entry of props.entries) for (const line of entry.text.split("\n")) {
    const heading = /^(User|Project) Skills \((.*)\)$/u.exec(line.trim());
    if (heading) { scope = heading[1]!.toLowerCase(); sections[scope]!.directory = heading[2]!; continue; }
    const item = /^\s{2}(.+?) — (.*)$/u.exec(line);
    if (item) sections[scope]!.items.push({ name: item[1]!, description: item[2]! });
  }
  return sections;
});
const memoryRows = computed(() => {
  const value = objectData.value;
  if (Array.isArray(value.global) || Array.isArray(value.project))
    return [...(Array.isArray(value.global) ? value.global : []), ...(Array.isArray(value.project) ? value.project : [])] as Record<string, unknown>[];
  return value.id ? [value] : [];
});
const grantRows = computed(() => Array.isArray(objectData.value.threadExecutableGrants)
  ? objectData.value.threadExecutableGrants as { index: number; prefix: string }[] : []);
const plainFields = computed(() => Object.entries(objectData.value)
  .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value)));
const nestedFields = computed(() => Object.entries(objectData.value)
  .filter(([, value]) => value !== null && typeof value === "object"));
const isMcpDecision = computed(() => props.command.name === "mcp" && props.decision?.kind === "choice");
const authorizationPending = computed(() => props.running && !props.decision &&
  props.entries.some(entry => entry.text.includes("Waiting for MCP authorization")));
watch(() => props.command.name, () => { search.value = ""; memoryTab.value = "short"; memoryScope.value = "all"; });
watch(search, () => { toolPage.value = 0; });

function execute(text: string): void { emit("execute", text); }
async function revoke(index: number, prefix: string): Promise<void> {
  try {
    await ElMessageBox.confirm(`Revoke this Thread grant?\n${prefix}`, "Revoke permission", { type: "warning", confirmButtonText: "Revoke" });
    execute(`/permissions revoke ${index}`);
  } catch { /* Confirmation dismissed. */ }
}
async function forget(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm(`Expire memory ${id}? This will stop ordinary recall.`, "Forget memory", { type: "warning", confirmButtonText: "Forget" });
    execute(`/memory forget ${id}`);
  } catch { /* Confirmation dismissed. */ }
}
async function move(id: string, scope: string): Promise<void> {
  const target = scope === "global" ? "project" : "global";
  try {
    await ElMessageBox.confirm(`Move memory ${id} from ${scope} to ${target}?`, "Move memory", { type: "warning", confirmButtonText: "Move" });
    execute(`/memory move ${id} ${target}`);
  } catch { /* Confirmation dismissed. */ }
}
function memoryQuery(): void {
  if (memoryTab.value === "short") execute(`/memory short ${memoryLimit.value}`);
  else execute(`/memory long ${memoryScope.value}`);
}
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}
function close(): void {
  if (isMcpDecision.value && props.decision) emit("decide", props.decision.id, undefined);
  if (props.command.name === "mcp" && props.running && !props.decision) emit("cancelExternal");
  emit("close");
}
function outsidePointer(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (panelRoot.value?.$el.contains(target) || target.closest(".el-overlay, .el-popper")) return;
  if (props.command.name === "mcp" && props.running) return;
  close();
}
onMounted(() => document.addEventListener("pointerdown", outsidePointer, true));
onUnmounted(() => document.removeEventListener("pointerdown", outsidePointer, true));
</script>

<template>
  <ElCard ref="panelRoot" class="web-command-panel" shadow="always" role="dialog" :aria-label="`/${command.name} interface`" @keydown.esc.stop.prevent="close">
    <div class="web-command-heading"><div><strong>/{{ command.name }}</strong><small>{{ command.description }}</small></div><ElButton text circle :icon="Close" aria-label="Close command panel" @click="close" /></div>
    <ElScrollbar max-height="min(48vh, 430px)">
      <div class="web-command-content">
        <template v-if="command.name === 'mode'">
          <p class="web-command-note">Choose how the agent handles the current conversation.</p>
          <div class="web-command-choice-grid">
            <ElButton v-for="mode in ['plan', 'auto', 'code']" :key="mode" :type="session?.mode === mode ? 'primary' : 'default'" plain :disabled="running" @click="execute(`/mode ${mode}`)">{{ mode }}<span v-if="session?.mode === mode"> · current</span></ElButton>
          </div>
        </template>
        <template v-else-if="command.name === 'mcp'">
          <p v-if="!decision" class="web-command-note">{{ running ? 'Working with the MCP server…' : 'Choose a configured server to inspect or manage it.' }}</p>
          <template v-if="isMcpDecision && decision">
            <strong class="web-command-section-title">{{ decision.title }}</strong>
            <p v-if="decision.description" class="web-command-note">{{ decision.description }}</p>
            <div class="web-command-choice-list"><ElButton v-for="choice in decision.choices" :key="choice.id" text :disabled="choice.disabled" @click="emit('decide', decision.id, choice.id)"><span><strong>{{ choice.label }}</strong><small v-if="choice.detail">{{ choice.detail }}</small></span></ElButton></div>
          </template>
          <ElButton v-if="authorizationPending" type="warning" plain @click="emit('cancelExternal')">Cancel authorization</ElButton>
          <ElButton v-if="!running && !decision" :icon="Refresh" text @click="execute('/mcp')">Refresh servers</ElButton>
          <pre v-for="entry in entries" :key="entry.id" class="web-command-text">{{ entry.text }}</pre>
        </template>
        <template v-else-if="command.name === 'memory'">
          <ElTabs v-model="memoryTab" @tab-change="memoryQuery">
            <ElTabPane label="Short-term" name="short" /><ElTabPane label="Long-term" name="long" />
          </ElTabs>
          <div class="web-command-controls" v-if="memoryTab === 'short'"><span>Recent messages</span><ElSelect v-model="memoryLimit" style="width:110px" @change="memoryQuery"><ElOption v-for="count in ['8','20','50','100']" :key="count" :label="count" :value="count" /></ElSelect><ElButton :icon="Refresh" text :disabled="running" @click="memoryQuery">Refresh</ElButton></div>
          <div class="web-command-controls" v-else><span>Scope</span><ElSelect v-model="memoryScope" style="width:160px" @change="memoryQuery"><ElOption label="All" value="all" /><ElOption label="Global" value="global" /><ElOption label="Project" value="project" /></ElSelect><ElButton :icon="Refresh" text :disabled="running" @click="memoryQuery">Refresh</ElButton></div>
          <div v-if="memoryTab === 'long' && memoryRows.length" class="web-command-records"><div v-for="memory in memoryRows" :key="String(memory.id)" class="web-command-record"><div class="web-command-record-title"><strong>{{ memory.category }}</strong><ElTag size="small">{{ memory.scope }}</ElTag><ElTag size="small" :type="memory.status === 'active' ? 'success' : 'info'">{{ memory.status }}</ElTag></div><p>{{ memory.content }}</p><small>{{ memory.id }} · {{ memory.updatedAt }}</small><div v-if="memory.status === 'active'" class="web-command-actions"><ElButton size="small" :disabled="running" @click="move(String(memory.id), String(memory.scope))">Move to {{ memory.scope === 'global' ? 'project' : 'global' }}</ElButton><ElButton size="small" type="danger" plain :disabled="running" @click="forget(String(memory.id))">Forget</ElButton></div></div></div>
        </template>
        <template v-else-if="command.name === 'permissions'">
          <p class="web-command-note">{{ formatValue(objectData.osSandbox) }}</p>
          <strong class="web-command-section-title">Saved grants for this Thread</strong>
          <ElButton :icon="Refresh" text :disabled="running" @click="execute('/permissions')">Refresh</ElButton>
          <div v-if="grantRows.length" class="web-command-records"><div v-for="grant in grantRows" :key="grant.index" class="web-command-record"><span>{{ grant.prefix }}</span><ElButton size="small" type="danger" plain :disabled="running" @click="revoke(grant.index, grant.prefix)">Revoke</ElButton></div></div><p v-else class="web-command-note">No saved grants.</p>
        </template>
        <template v-else-if="command.name === 'tools'">
          <ElInput v-model="search" clearable placeholder="Search tools" />
          <p class="web-command-note">{{ tools.length }} matching tools · page {{ toolPage + 1 }} / {{ Math.max(1, Math.ceil(tools.length / 40)) }}</p>
          <div class="web-command-records"><div v-for="tool in visibleTools" :key="String(tool.id)" class="web-command-record"><div class="web-command-record-title"><strong>{{ tool.name }}</strong><ElTag size="small" :type="tool.available ? 'success' : 'info'">{{ tool.available ? 'Available' : 'Unavailable' }}</ElTag><ElTag v-if="tool.mutating" size="small" type="warning">Mutating</ElTag></div><p>{{ tool.description || 'No description provided.' }}</p><small>{{ tool.source }} · {{ formatValue(tool.effects) }}</small></div></div>
          <div class="web-command-actions"><ElButton size="small" :disabled="toolPage === 0" @click="toolPage--">Previous</ElButton><ElButton size="small" :disabled="(toolPage + 1) * 40 >= tools.length" @click="toolPage++">Next</ElButton></div>
        </template>
        <template v-else-if="command.name === 'help'">
          <div class="web-command-choice-list"><div v-for="item in commands" :key="item.name" class="web-command-help-row"><strong>/{{ item.name }}</strong><span>{{ item.description }}</span></div></div>
          <p class="web-command-note">Model, approval, DAG/agents, images, projects and conversations have dedicated controls in the page.</p>
        </template>
        <template v-else-if="command.name === 'workspace'">
          <div class="web-command-actions"><ElButton :icon="Refresh" :disabled="running" @click="execute('/workspace refresh')">Refresh inventory</ElButton></div>
        </template>
        <template v-else-if="command.name === 'skills'"><ElTabs v-model="skillsTab"><ElTabPane label="User skills" name="user" /><ElTabPane label="Project skills" name="project" /></ElTabs><p class="web-command-note">{{ skills[skillsTab]?.directory }}</p><div class="web-command-records"><div v-for="skill in skills[skillsTab]?.items ?? []" :key="skill.name" class="web-command-record"><strong>{{ skill.name }}</strong><p>{{ skill.description }}</p></div></div><p v-if="!skills[skillsTab]?.items.length" class="web-command-note">No skills in this scope.</p></template>
        <template v-if="!['mcp','tools','skills','help'].includes(command.name)">
          <ElDescriptions v-if="plainFields.length" :column="1" border size="small"><ElDescriptionsItem v-for="[key,value] in plainFields" :key="key" :label="key">{{ formatValue(value) }}</ElDescriptionsItem></ElDescriptions>
          <div v-for="[key,value] in nestedFields" :key="key" class="web-command-nested"><strong>{{ key }}</strong><pre>{{ formatValue(value) }}</pre></div>
          <pre v-if="!parsed && entries.length" v-for="entry in entries" :key="entry.id" class="web-command-text">{{ entry.text }}</pre>
        </template>
        <p v-if="!entries.length && !decision && command.name !== 'mode' && command.name !== 'help'" class="web-command-note">{{ running ? 'Loading…' : 'No data yet.' }}</p>
      </div>
    </ElScrollbar>
  </ElCard>
</template>
