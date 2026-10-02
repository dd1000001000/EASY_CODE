<script setup lang="ts">
import { computed } from "vue";
import { ElButton, ElOption, ElSelect } from "element-plus";
import { Monitor, Moon, Sunny } from "@element-plus/icons-vue";
import type { UISessionInfo } from "../../ui/contracts.js";
import { language, t } from "../i18n.js";
import { contextUsage, environmentLabel, modeLabel } from "../session-labels.js";
import { nextTheme, themePreference } from "../theme.js";

const props = defineProps<{
  title: string;
  session: UISessionInfo | null;
  /** Shown instead of the session details when no conversation is open. */
  hint: string;
  taskCount: number;
  agentCount: number;
}>();
const emit = defineEmits<{ changeLanguage: [value: string] }>();

const context = computed(() => contextUsage(props.session));
const themeLabel = computed(() =>
  themePreference.value === "dark"
    ? t("ui.themeDark")
    : themePreference.value === "light"
      ? t("ui.themeLight")
      : t("ui.themeSystem"),
);
const themeIcon = computed(() =>
  themePreference.value === "dark" ? Moon : themePreference.value === "light" ? Sunny : Monitor,
);
</script>

<template>
  <header class="topbar">
    <div class="topbar-heading">
      <h1>{{ title }}</h1>
      <div v-if="session" class="topbar-meta">
        <span class="meta-chip">{{ t("ui.mode") }} · {{ modeLabel(session) }}</span>
        <span class="meta-chip">{{ environmentLabel(session) }}</span>
        <span v-if="taskCount" class="meta-chip">{{ t("ui.tasks") }} · {{ taskCount }}</span>
        <span v-if="agentCount" class="meta-chip meta-chip--accent">{{ t("ui.agents") }} · {{ agentCount }}</span>
        <span v-if="context" class="meta-chip meta-context" :title="t('ui.contextUsage')">
          <span>{{ t("ui.context") }} {{ context.label }}</span>
          <span v-if="context.ratio !== undefined" class="meta-context-bar" aria-hidden="true">
            <span
              :class="{ 'is-high': context.ratio > 0.8 }"
              :style="{ width: `${Math.max(4, Math.round(context.ratio * 100))}%` }"
            ></span>
          </span>
        </span>
      </div>
      <p v-else>{{ hint }}</p>
    </div>
    <div class="top-actions">
      <ElButton
        class="theme-switcher"
        text
        :icon="themeIcon"
        :title="themeLabel"
        :aria-label="themeLabel"
        @click="nextTheme"
      />
      <ElSelect
        class="language-switcher"
        :model-value="language"
        :aria-label="t('ui.selectLanguage')"
        @change="emit('changeLanguage', $event)"
        ><ElOption label="English" value="en_us" /><ElOption label="简体中文" value="zh_cn"
      /></ElSelect>
    </div>
  </header>
</template>
