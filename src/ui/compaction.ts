export interface CompactionProgress {
  operationId: string;
  mode?: "manual" | "automatic";
  turnId?: string;
  startedAt?: number;
  completedAt?: number;
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

/** Notice severity: a run that left history unchanged is informational, not a success. */
export function compactionNoticeKind(progress: CompactionProgress): "info" | "success" | "warning" {
  if (compactionRunning(progress)) return "info";
  if (progress.phase !== "completed") return "warning";
  return progress.outcome === "unchanged" ? "info" : "success";
}

export function compactionDuration(progress: CompactionProgress, now = Date.now()): string | undefined {
  if (progress.startedAt === undefined || (!compactionRunning(progress) && progress.completedAt === undefined))
    return undefined;
  const seconds = Math.max(0, Math.floor(((progress.completedAt ?? now) - progress.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Base running label; activity indicators render their own elapsed timer. */
export function compactionActivityLabel(progress: CompactionProgress, chinese = false): string {
  const automatic = progress.mode === "automatic";
  return chinese ? (automatic ? "自动压缩中" : "正在压缩") : automatic ? "Auto-compacting" : "Compacting";
}

export function compactionLabel(progress: CompactionProgress, chinese = false, now = Date.now()): string {
  const automatic = progress.mode === "automatic";
  const duration = compactionDuration(progress, now);
  if (compactionRunning(progress))
    return `${compactionActivityLabel(progress, chinese)}${duration ? ` · ${duration}` : ""}`;
  const unchanged = progress.phase === "completed" && progress.outcome === "unchanged";
  const labels = chinese
    ? {
        completed: automatic ? "自动压缩完成" : "压缩完成",
        unchanged: automatic ? "自动压缩未改动历史" : "无需进一步压缩",
        cancelled: automatic ? "自动压缩已取消" : "压缩已取消",
        failed: "摘要未完成",
      }
    : {
        completed: automatic ? "Auto-compaction complete" : "Compaction complete",
        unchanged: automatic ? "Auto-compaction made no changes" : "No further compaction needed",
        cancelled: automatic ? "Auto-compaction cancelled" : "Compaction cancelled",
        failed: "Summary not completed",
      };
  let label = unchanged
    ? labels.unchanged
    : progress.phase === "completed"
      ? labels.completed
      : progress.phase === "cancelled"
        ? labels.cancelled
        : labels.failed;
  if (duration) label += chinese ? ` · 耗时 ${duration}` : ` · took ${duration}`;
  if (!automatic && !unchanged && progress.afterChars !== undefined) {
    const removed = Math.max(0, progress.beforeChars - progress.afterChars);
    const saved = progress.beforeChars > 0 ? (removed / progress.beforeChars) * 100 : 0;
    const before = progress.beforeChars.toLocaleString("en-US");
    const after = progress.afterChars.toLocaleString("en-US");
    const amount = removed.toLocaleString("en-US");
    return chinese
      ? `${label} · ${before} → ${after} 字符 · 减少 ${amount} 字符（${saved.toFixed(1)}%）`
      : `${label} · ${before} → ${after} chars · ${amount} chars removed (${saved.toFixed(1)}%)`;
  }
  return label;
}
