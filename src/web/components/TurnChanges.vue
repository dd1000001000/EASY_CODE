<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CopyDocument,
  Document,
  DocumentAdd,
  DocumentDelete,
} from "@element-plus/icons-vue";
import type { WebTurnChangedFile, WebTurnDiffResponse } from "../../web-contracts.js";
import type { FileChangeKind, TurnFileDiff } from "../../ui/contracts.js";
import { request } from "../api.js";
import type { MessageKey } from "../../i18n/catalog.js";
import { t } from "../i18n.js";
import FileDiffView from "./FileDiffView.vue";

/** Rows shown before "Show N more"; enough for most requests without pushing the next one down. */
const VISIBLE_FILES = 4;
const KIND_LABEL: Readonly<Record<FileChangeKind, MessageKey>> = {
  created: "ui.fileCreated",
  modified: "ui.fileModified",
  deleted: "ui.fileDeleted",
};
const KIND_ICON = { created: DocumentAdd, modified: Document, deleted: DocumentDelete } as const;

const props = defineProps<{
  files: readonly WebTurnChangedFile[];
  /** The request, for loading a file's saved diff when it is opened. */
  threadId?: string;
  turnId?: string;
}>();
const expanded = ref(false);
const copiedPath = ref<string>();
/** Files whose diff is open. */
const openFiles = ref<Set<string>>(new Set());
type DiffState = { status: "loading" } | { status: "ready"; diff: TurnFileDiff } | { status: "unavailable" };
/** Diffs are loaded when a file is first opened, then kept while the answer is on screen. */
const diffs = ref<Record<string, DiffState>>({});

function canOpen(file: WebTurnChangedFile): boolean {
  return file.hasDiff === true && Boolean(props.threadId && props.turnId);
}

async function loadDiff(path: string): Promise<void> {
  diffs.value = { ...diffs.value, [path]: { status: "loading" } };
  let state: DiffState = { status: "unavailable" };
  try {
    const query = new URLSearchParams({ threadId: props.threadId ?? "", turnId: props.turnId ?? "", path });
    const { diff } = await request<WebTurnDiffResponse>(`/api/turn-diff?${query}`);
    if (diff) state = { status: "ready", diff };
  } catch {
    // Shown as unavailable; closing and opening the file asks again.
  }
  diffs.value = { ...diffs.value, [path]: state };
}

function toggleFile(path: string): void {
  const next = new Set(openFiles.value);
  if (next.has(path)) {
    next.delete(path);
    if (diffs.value[path]?.status === "unavailable") {
      const rest = { ...diffs.value };
      delete rest[path];
      diffs.value = rest;
    }
  } else {
    next.add(path);
    if (!diffs.value[path]) void loadDiff(path);
  }
  openFiles.value = next;
}

function diffOf(path: string): TurnFileDiff | undefined {
  const state = diffs.value[path];
  return state?.status === "ready" ? state.diff : undefined;
}

const shown = computed(() => (expanded.value ? props.files : props.files.slice(0, VISIBLE_FILES)));
const hidden = computed(() => props.files.length - VISIBLE_FILES);
/** "2 added · 1 modified", in the order a reader cares about. */
const breakdown = computed(() =>
  (["created", "modified", "deleted"] as const)
    .map((kind) => [kind, props.files.filter((file) => file.change === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${t(KIND_LABEL[kind])} ${count}`)
    .join(" · "),
);
/** Lines over the files whose counts are known; undefined when none are. */
const totals = computed(() => {
  const counted = props.files.flatMap((file) => (file.lines ? [file.lines] : []));
  if (!counted.length) return undefined;
  return counted.reduce((sum, lines) => ({ added: sum.added + lines.added, removed: sum.removed + lines.removed }), {
    added: 0,
    removed: 0,
  });
});

function split(path: string): { name: string; directory: string } {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash < 0
    ? { name: path, directory: "" }
    : { name: path.slice(slash + 1), directory: path.slice(0, slash + 1) };
}
async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    copiedPath.value = path;
    window.setTimeout(() => {
      if (copiedPath.value === path) copiedPath.value = undefined;
    }, 1500);
  } catch {
    // Clipboard access can be refused; the path stays readable in the row.
  }
}
</script>

<template>
  <section class="turn-changes" :aria-label="t('ui.filesChanged', { count: files.length })">
    <header class="turn-changes-header">
      <strong>{{ files.length === 1 ? t("ui.fileChanged") : t("ui.filesChanged", { count: files.length }) }}</strong>
      <span class="turn-changes-breakdown">{{ breakdown }}</span>
      <span v-if="totals" class="turn-line-counts turn-line-counts--total"
        ><span class="turn-lines-added">+{{ totals.added }}</span
        ><span class="turn-lines-removed">−{{ totals.removed }}</span></span
      >
    </header>
    <ul class="turn-changes-list">
      <li v-for="file in shown" :key="file.path">
        <div class="turn-change-row">
          <button
            type="button"
            class="turn-change"
            :class="[`turn-change--${file.change}`, { 'is-open': openFiles.has(file.path) }]"
            :title="canOpen(file) ? `${file.path}\n${t('ui.showChanges')}` : `${file.path}\n${t('ui.noDiffAvailable')}`"
            :aria-expanded="canOpen(file) ? openFiles.has(file.path) : undefined"
            :disabled="!canOpen(file)"
            @click="toggleFile(file.path)"
          >
            <ArrowRight v-if="canOpen(file)" class="turn-change-chevron" /><span
              v-else
              class="turn-change-chevron"
            ></span>
            <component :is="KIND_ICON[file.change]" class="turn-change-icon" />
            <span class="turn-change-path"
              ><span class="turn-change-name">{{ split(file.path).name }}</span
              ><span class="turn-change-directory">{{ split(file.path).directory }}</span></span
            >
            <span v-if="file.lines" class="turn-line-counts"
              ><span class="turn-lines-added">+{{ file.lines.added }}</span
              ><span class="turn-lines-removed">−{{ file.lines.removed }}</span></span
            >
            <span class="turn-change-kind">{{ t(KIND_LABEL[file.change]) }}</span>
          </button>
          <button
            type="button"
            class="turn-change-copy"
            :title="copiedPath === file.path ? t('ui.copied') : t('ui.copyPath')"
            :aria-label="t('ui.copyPath')"
            @click="copyPath(file.path)"
          >
            <CopyDocument />
          </button>
        </div>
        <template v-if="canOpen(file) && openFiles.has(file.path)">
          <FileDiffView v-if="diffOf(file.path)" :path="file.path" :diff="diffOf(file.path)!" />
          <p v-else class="file-diff-status" role="status">
            {{ diffs[file.path]?.status === "loading" ? t("ui.diffLoading") : t("ui.diffUnavailable") }}
          </p>
        </template>
      </li>
    </ul>
    <button
      v-if="hidden > 0"
      type="button"
      class="turn-changes-toggle"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span>{{ expanded ? t("ui.showFewerFiles") : t("ui.showMoreFiles", { count: hidden }) }}</span>
      <ArrowUp v-if="expanded" class="turn-changes-toggle-icon" /><ArrowDown v-else class="turn-changes-toggle-icon" />
    </button>
  </section>
</template>
