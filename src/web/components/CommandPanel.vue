<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElCard, ElDescriptions, ElDescriptionsItem, ElInput, ElInputNumber, ElMessageBox, ElOption, ElScrollbar, ElSelect, ElTabPane, ElTabs, ElTag } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";
import type { WebEntry, WebDecision } from "../../web-contracts.js";
import type { WebCommandEntry } from "../../web-command-catalog.js";
import type { UISessionInfo } from "../../ui/contracts.js";
import { useOutsideDismiss } from "../use-outside-dismiss.js";
import { t } from "../i18n.js";
import type { MessageKey } from "../../i18n/catalog.js";

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
const memoryLimit = ref<number | undefined>(8);
const validMemoryLimit = computed(() => Number.isSafeInteger(memoryLimit.value) &&
  memoryLimit.value !== undefined && memoryLimit.value >= 1 && memoryLimit.value <= 100);
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
function commandDescription(name: string): string { return t(`command.${name}` as MessageKey); }
function localizedScope(scope: string): string {
  return scope === "global" ? t("ui.global") : scope === "project" ? t("ui.project") : scope;
}
watch(() => props.command.name, () => { search.value = ""; memoryTab.value = "short"; memoryScope.value = "all"; });
watch(search, () => { toolPage.value = 0; });

function execute(text: string): void { emit("execute", text); }
async function revoke(index: number, prefix: string): Promise<void> {
  try {
    await ElMessageBox.confirm(t("ui.revokePrompt", { prefix }), t("ui.revokeTitle"), { type: "warning", confirmButtonText: t("ui.revoke") });
    execute(`/permissions revoke ${index}`);
  } catch { /* Confirmation dismissed. */ }
}
function memoryQuery(): void {
  if (memoryTab.value === "short") {
    if (validMemoryLimit.value) execute(`/memory short ${memoryLimit.value}`);
  }
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
useOutsideDismiss(panelRoot, close);
</script>

<template>
  <ElCard ref="panelRoot" class="web-command-panel" shadow="always" role="dialog" :aria-label="`/${command.name} interface`" @keydown.esc.stop.prevent="close">
    <div class="web-command-heading"><div><strong>/{{ command.name }}</strong><small>{{ commandDescription(command.name) }}</small></div></div>
    <ElScrollbar max-height="min(48vh, 430px)">
      <div class="web-command-content">
        <template v-if="command.name === 'mode'">
          <p class="web-command-note">{{ t('ui.modeHint') }}</p>
          <div class="web-command-choice-grid">
            <ElButton v-for="mode in ['plan', 'auto', 'code']" :key="mode" :type="session?.mode === mode ? 'primary' : 'default'" plain :disabled="running" @click="execute(`/mode ${mode}`)">{{ t(`ui.mode${mode[0]?.toUpperCase()}${mode.slice(1)}` as MessageKey) }}<span v-if="session?.mode === mode"> · {{ t('ui.current') }}</span></ElButton>
          </div>
        </template>
        <template v-else-if="command.name === 'mcp'">
          <p v-if="!decision" class="web-command-note">{{ running ? t('ui.mcpWorking') : t('ui.mcpHint') }}</p>
          <template v-if="isMcpDecision && decision">
            <strong class="web-command-section-title">{{ decision.title }}</strong>
            <p v-if="decision.description" class="web-command-note">{{ decision.description }}</p>
            <div class="web-command-choice-list"><ElButton v-for="choice in decision.choices" :key="choice.id" text :disabled="choice.disabled" @click="emit('decide', decision.id, choice.id)"><span><strong>{{ choice.label }}</strong><small v-if="choice.detail">{{ choice.detail }}</small></span></ElButton></div>
          </template>
          <ElButton v-if="authorizationPending" type="warning" plain @click="emit('cancelExternal')">{{ t('ui.cancelAuthorization') }}</ElButton>
          <ElButton v-if="!running && !decision" :icon="Refresh" text @click="execute('/mcp')">{{ t('ui.refreshServers') }}</ElButton>
          <pre v-for="entry in entries" :key="entry.id" class="web-command-text">{{ entry.text }}</pre>
        </template>
        <template v-else-if="command.name === 'memory'">
          <ElTabs v-model="memoryTab" @tab-change="memoryQuery">
            <ElTabPane :label="t('ui.shortTerm')" name="short" /><ElTabPane :label="t('ui.longTerm')" name="long" />
          </ElTabs>
          <div class="web-command-controls" v-if="memoryTab === 'short'"><span>{{ t('ui.recentMessages') }}</span><ElInputNumber v-model="memoryLimit" :min="1" :max="100" :precision="0" :controls="false" :disabled="running" :aria-label="t('ui.recentMessages')" style="width:110px" @keydown.enter.stop.prevent="memoryQuery" /><ElButton :icon="Refresh" text :disabled="running || !validMemoryLimit" @click="memoryQuery">{{ t('ui.refresh') }}</ElButton></div>
          <div class="web-command-controls" v-else><span>{{ t('ui.scope') }}</span><ElSelect v-model="memoryScope" style="width:160px" @change="memoryQuery"><ElOption :label="t('ui.all')" value="all" /><ElOption :label="t('ui.global')" value="global" /><ElOption :label="t('ui.project')" value="project" /></ElSelect><ElButton :icon="Refresh" text :disabled="running" @click="memoryQuery">{{ t('ui.refresh') }}</ElButton></div>
          <div v-if="memoryTab === 'long' && memoryRows.length" class="web-command-records"><div v-for="memory in memoryRows" :key="String(memory.id)" class="web-command-record"><div class="web-command-record-title"><strong>{{ memory.category }}</strong><ElTag size="small">{{ localizedScope(String(memory.scope)) }}</ElTag><ElTag size="small" :type="memory.status === 'active' ? 'success' : 'info'">{{ memory.status }}</ElTag></div><p>{{ memory.content }}</p><small>{{ memory.id }} · {{ memory.updatedAt }}</small></div></div>
        </template>
        <template v-else-if="command.name === 'permissions'">
          <p class="web-command-note">{{ formatValue(objectData.osSandbox) }}</p>
          <strong class="web-command-section-title">{{ t('ui.savedGrants') }}</strong>
          <ElButton :icon="Refresh" text :disabled="running" @click="execute('/permissions')">{{ t('ui.refresh') }}</ElButton>
          <div v-if="grantRows.length" class="web-command-records"><div v-for="grant in grantRows" :key="grant.index" class="web-command-record"><span>{{ grant.prefix }}</span><ElButton size="small" type="danger" plain :disabled="running" @click="revoke(grant.index, grant.prefix)">{{ t('ui.revoke') }}</ElButton></div></div><p v-else class="web-command-note">{{ t('ui.noGrants') }}</p>
        </template>
        <template v-else-if="command.name === 'tools'">
          <ElInput v-model="search" clearable :placeholder="t('ui.searchTools')" />
          <p class="web-command-note">{{ t('ui.toolsMatch', { count: tools.length, page: toolPage + 1, pages: Math.max(1, Math.ceil(tools.length / 40)) }) }}</p>
          <div class="web-command-records"><div v-for="tool in visibleTools" :key="String(tool.id)" class="web-command-record"><div class="web-command-record-title"><strong>{{ tool.name }}</strong><ElTag size="small" :type="tool.available ? 'success' : 'info'">{{ tool.available ? t('ui.available') : t('ui.unavailable') }}</ElTag><ElTag v-if="tool.mutating" size="small" type="warning">{{ t('ui.mutating') }}</ElTag></div><p>{{ tool.description || t('ui.noDescription') }}</p><small>{{ tool.source }} · {{ formatValue(tool.effects) }}</small></div></div>
          <div class="web-command-actions"><ElButton size="small" :disabled="toolPage === 0" @click="toolPage--">{{ t('ui.previous') }}</ElButton><ElButton size="small" :disabled="(toolPage + 1) * 40 >= tools.length" @click="toolPage++">{{ t('ui.next') }}</ElButton></div>
        </template>
        <template v-else-if="command.name === 'help'">
          <div class="web-command-choice-list"><div v-for="item in commands" :key="item.name" class="web-command-help-row"><strong>/{{ item.name }}</strong><span>{{ commandDescription(item.name) }}</span></div></div>
          <p class="web-command-note">{{ t('ui.commandHelpHint') }}</p>
        </template>
        <template v-else-if="command.name === 'workspace'">
          <div class="web-command-actions"><ElButton :icon="Refresh" :disabled="running" @click="execute('/workspace refresh')">{{ t('ui.refreshInventory') }}</ElButton></div>
        </template>
        <template v-else-if="command.name === 'skills'"><ElTabs v-model="skillsTab"><ElTabPane :label="t('ui.userSkills')" name="user" /><ElTabPane :label="t('ui.projectSkills')" name="project" /></ElTabs><p class="web-command-note">{{ skills[skillsTab]?.directory }}</p><div class="web-command-records"><div v-for="skill in skills[skillsTab]?.items ?? []" :key="skill.name" class="web-command-record"><strong>{{ skill.name }}</strong><p>{{ skill.description }}</p></div></div><p v-if="!skills[skillsTab]?.items.length" class="web-command-note">{{ t('ui.noSkills') }}</p></template>
        <template v-if="!['mcp','tools','skills','help'].includes(command.name)">
          <ElDescriptions v-if="plainFields.length" :column="1" border size="small"><ElDescriptionsItem v-for="[key,value] in plainFields" :key="key" :label="key">{{ formatValue(value) }}</ElDescriptionsItem></ElDescriptions>
          <div v-for="[key,value] in nestedFields" :key="key" class="web-command-nested"><strong>{{ key }}</strong><pre>{{ formatValue(value) }}</pre></div>
          <pre v-if="!parsed && entries.length" v-for="entry in entries" :key="entry.id" class="web-command-text">{{ entry.text }}</pre>
        </template>
        <p v-if="!entries.length && !decision && command.name !== 'mode' && command.name !== 'help'" class="web-command-note">{{ running ? t('ui.loading') : t('ui.noData') }}</p>
      </div>
    </ElScrollbar>
  </ElCard>
</template>
