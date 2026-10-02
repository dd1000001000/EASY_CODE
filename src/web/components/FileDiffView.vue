<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import type { TurnFileDiff } from "../../ui/contracts.js";
import {
  codeLanguageEpoch,
  codeLinesHtmlIfReady,
  resolveCodeLanguage,
  subscribeCodeLanguages,
  type CodeLanguage,
} from "../../highlight/shiki.js";
import { t } from "../i18n.js";

const props = defineProps<{ path: string; diff: TurnFileDiff }>();

interface DiffRow {
  kind: "hunk" | "context" | "added" | "removed";
  oldNumber?: number;
  newNumber?: number;
  /** Escaped HTML of the line's code. */
  html: string;
}

/** Repaint once the file's grammar has loaded; until then lines show plain. */
const epoch = ref(codeLanguageEpoch());
const unsubscribe = subscribeCodeLanguages(() => {
  epoch.value = codeLanguageEpoch();
});
onUnmounted(unsubscribe);

const language = computed<CodeLanguage | undefined>(() => {
  const name = props.path.slice(Math.max(props.path.lastIndexOf("/"), props.path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return resolveCodeLanguage(dot > 0 ? name.slice(dot + 1) : name.toLowerCase());
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

/** Each side of a hunk highlighted as a whole, so multi-line syntax (strings, comments) colours correctly. */
function sideHtml(lines: readonly string[]): readonly string[] {
  const code = lines.join("\n");
  const highlighted = language.value ? codeLinesHtmlIfReady(code, language.value) : undefined;
  return highlighted && highlighted.length === lines.length ? highlighted : lines.map(escapeHtml);
}

const rows = computed<DiffRow[]>(() => {
  void epoch.value;
  const result: DiffRow[] = [];
  for (const hunk of props.diff.hunks) {
    const oldSide = sideHtml(hunk.lines.filter((line) => !line.startsWith("+")).map((line) => line.slice(1)));
    const newSide = sideHtml(hunk.lines.filter((line) => !line.startsWith("-")).map((line) => line.slice(1)));
    const oldCount = hunk.lines.filter((line) => !line.startsWith("+")).length;
    const newCount = hunk.lines.filter((line) => !line.startsWith("-")).length;
    result.push({
      kind: "hunk",
      html: escapeHtml(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`),
    });
    let oldIndex = 0;
    let newIndex = 0;
    for (const line of hunk.lines) {
      if (line.startsWith("-")) {
        result.push({ kind: "removed", oldNumber: hunk.oldStart + oldIndex, html: oldSide[oldIndex] ?? "" });
        oldIndex += 1;
      } else if (line.startsWith("+")) {
        result.push({ kind: "added", newNumber: hunk.newStart + newIndex, html: newSide[newIndex] ?? "" });
        newIndex += 1;
      } else {
        result.push({
          kind: "context",
          oldNumber: hunk.oldStart + oldIndex,
          newNumber: hunk.newStart + newIndex,
          html: newSide[newIndex] ?? "",
        });
        oldIndex += 1;
        newIndex += 1;
      }
    }
  }
  return result;
});
</script>

<template>
  <div class="file-diff" role="table" :aria-label="path">
    <div class="file-diff-scroll">
      <div
        v-for="(row, index) in rows"
        :key="index"
        class="file-diff-row"
        :class="`file-diff-row--${row.kind}`"
        role="row"
      >
        <template v-if="row.kind === 'hunk'">
          <span class="file-diff-hunk" role="cell" v-html="row.html"></span>
        </template>
        <template v-else>
          <span class="file-diff-number" role="cell">{{ row.oldNumber ?? "" }}</span>
          <span class="file-diff-number" role="cell">{{ row.newNumber ?? "" }}</span>
          <span class="file-diff-sign" role="cell" aria-hidden="true">{{
            row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""
          }}</span>
          <span class="file-diff-code shiki" role="cell" v-html="row.html"></span>
        </template>
      </div>
    </div>
    <p v-if="diff.truncated" class="file-diff-note">{{ t("ui.diffTruncated") }}</p>
  </div>
</template>
