export interface CompactionProgress {
  operationId: string;
  phase: "preparing" | "referencing" | "summarizing" | "validating" | "completed" | "failed" | "cancelled";
  beforeChars: number;
  afterChars?: number;
  referencedOutputs?: number;
  outcome?: "compacted" | "references_only" | "unchanged";
  reason?: string;
}

export function compactionRunning(progress?: CompactionProgress | null): boolean {
  return !!progress && !["completed", "failed", "cancelled"].includes(progress.phase);
}

export function compactionLabel(progress: CompactionProgress, chinese = false): string {
  const labels = chinese
    ? { preparing: "正在压缩 · 准备中", referencing: "正在压缩 · 整理工具输出", summarizing: "正在压缩 · 生成摘要", validating: "正在压缩 · 校验摘要", completed: "压缩完成", failed: "摘要未完成", cancelled: "压缩已取消" }
    : { preparing: "Compacting · preparing", referencing: "Compacting · referencing tool outputs", summarizing: "Compacting · summarizing", validating: "Compacting · validating", completed: "Compaction complete", failed: "Summary not completed", cancelled: "Compaction cancelled" };
  let label = labels[progress.phase];
  if (progress.outcome === "unchanged" && progress.phase === "completed") label = chinese ? "无需进一步压缩" : "No further compaction needed";
  if (progress.outcome === "references_only") label += chinese ? " · 已整理工具输出" : " · tool outputs referenced";
  if (progress.afterChars !== undefined) {
    const saved = progress.beforeChars > 0 ? Math.max(0, (1 - progress.afterChars / progress.beforeChars) * 100) : 0;
    label += ` · ${progress.beforeChars.toLocaleString("en-US")} → ${progress.afterChars.toLocaleString("en-US")} ${chinese ? "字符" : "chars"} · −${saved.toFixed(1)}%`;
  }
  return label;
}

