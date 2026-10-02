<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElCard } from "element-plus";
import { ArrowDown, ArrowUp } from "@element-plus/icons-vue";
import type { WebView } from "../../web-contracts.js";
import { subagentDisplayLabel } from "../../subagents/display-name.js";
import { t } from "../i18n.js";

const props = defineProps<{ view: WebView; now: number }>();

/** Collapsed to its header line, so the monitor never hides the conversation for long. */
const collapsed = ref(false);
const liveAgents = computed(() =>
  props.view.subagents.filter((agent) => agent.status === "running" || agent.status === "stopping"),
);
const unassignedAgents = computed(() =>
  liveAgents.value.filter(
    (agent) => !props.view.tasks?.tasks.some((task) => task.id === agent.taskId && agent.assignmentKind === "dag"),
  ),
);
const reviewLabel = computed(() =>
  props.view.review?.phase === "main_brief" ? t("ui.reviewBrief") : t("ui.reviewInspect"),
);
const headline = computed(() => {
  const tasks = props.view.tasks;
  if (tasks) return `${t("ui.tasks")} ${tasks.completed}/${tasks.total}`;
  if (liveAgents.value.length) return `${t("ui.subagents")} · ${liveAgents.value.length}`;
  if (props.view.review) return t("ui.reviewer");
  return t("ui.inProgress");
});

function agentForTask(taskId: string) {
  return liveAgents.value.find((agent) => agent.assignmentKind === "dag" && agent.taskId === taskId);
}
function elapsed(startedAt: number): string {
  return `${Math.max(0, Math.floor((props.now - startedAt) / 1000))}s`;
}
function agentStatus(agent: (typeof liveAgents.value)[number]): string {
  const activity = agent.activity;
  const doing =
    activity?.kind === "thinking"
      ? t("ui.thinking")
      : activity?.kind === "tool"
        ? `${t("ui.tool")}: ${activity.label ?? t("ui.working")}`
        : agent.status;
  return `${doing} · ${elapsed(Date.parse(activity?.startedAt ?? agent.startedAt))}`;
}
</script>

<template>
  <ElCard class="task-monitor-card" :class="{ 'is-collapsed': collapsed }" shadow="always">
    <div class="monitor-header">
      <strong>{{ headline }}</strong>
      <ElButton
        text
        :icon="collapsed ? ArrowDown : ArrowUp"
        :title="collapsed ? t('ui.expandMonitor') : t('ui.collapseMonitor')"
        :aria-label="collapsed ? t('ui.expandMonitor') : t('ui.collapseMonitor')"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      />
    </div>
    <template v-if="!collapsed">
      <section v-if="view.tasks" class="monitor-section">
        <ul>
          <li v-for="task in view.tasks.tasks" :key="task.id">
            {{ task.status === "completed" ? "✓" : "○" }} {{ task.title }}
            <div v-if="agentForTask(task.id)" class="task-agent">
              {{ subagentDisplayLabel(agentForTask(task.id)!) }} · {{ agentStatus(agentForTask(task.id)!) }}
            </div>
            <div v-else-if="task.assignedAgentName" class="task-agent">{{ task.assignedAgentName }}</div>
          </li>
        </ul>
      </section>
      <section v-if="unassignedAgents.length" class="monitor-section">
        <h3>{{ t("ui.subagents") }}</h3>
        <ul>
          <li v-for="agent in unassignedAgents" :key="agent.id">
            {{ subagentDisplayLabel(agent) }} · {{ agent.taskTitle }} · {{ agentStatus(agent) }}
          </li>
        </ul>
      </section>
      <section v-if="view.review" class="monitor-section">
        <h3>{{ t("ui.reviewer") }}</h3>
        <p>{{ reviewLabel }} · {{ elapsed(view.review.startedAt) }}</p>
      </section>
      <section v-if="view.activities.length" class="monitor-section">
        <h3>{{ t("ui.inProgress") }}</h3>
        <ul>
          <li v-for="activity in view.activities" :key="activity.id">{{ activity.text }}</li>
        </ul>
      </section>
    </template>
  </ElCard>
</template>
