import assert from "node:assert/strict";
import {
  compactionActivityLabel,
  compactionDuration,
  compactionLabel,
  compactionNoticeKind,
  type CompactionProgress,
} from "../src/ui/compaction.js";
import { describe, it } from "./harness.js";

describe("Compaction status text and timing", () => {
  const base: CompactionProgress = {
    operationId: "timed",
    mode: "manual",
    phase: "summarizing",
    beforeChars: 1000,
    startedAt: 1000,
  };
  it("counts elapsed time across phases and freezes it at completion", () => {
    assert.equal(compactionLabel(base, true, 65000), "正在压缩 · 1m 04s");
    assert.equal(compactionLabel(base, false, 65000), "Compacting · 1m 04s");
    const completed = { ...base, phase: "completed" as const, completedAt: 65000, afterChars: 200 };
    assert.equal(
      compactionLabel(completed, false, 999999),
      "Compaction complete · took 1m 04s · 1,000 → 200 chars · 800 chars removed (80.0%)",
    );
    assert.equal(
      compactionLabel(completed, true, 999999),
      "压缩完成 · 耗时 1m 04s · 1,000 → 200 字符 · 减少 800 字符（80.0%）",
    );
    assert.equal(compactionDuration(base, 0), "0s");
  });
  it("reports automatic timing without size statistics and handles interrupted legacy history", () => {
    const automatic = { ...base, mode: "automatic" as const };
    assert.equal(compactionLabel(automatic, true, 13000), "自动压缩中 · 12s");
    assert.equal(compactionLabel(automatic, false, 13000), "Auto-compacting · 12s");
    const completed = { ...automatic, phase: "completed" as const, completedAt: 13000, afterChars: 200 };
    assert.equal(compactionLabel(completed, true), "自动压缩完成 · 耗时 12s");
    assert.equal(compactionLabel(completed, false), "Auto-compaction complete · took 12s");
    assert.equal(compactionDuration({ ...base, phase: "cancelled" }), undefined);
  });
  it("labels a run that left history unchanged as neither a success nor a size report", () => {
    const automatic: CompactionProgress = {
      ...base,
      mode: "automatic",
      phase: "completed",
      outcome: "unchanged",
      completedAt: 13000,
    };
    assert.equal(compactionLabel(automatic, true), "自动压缩未改动历史 · 耗时 12s");
    assert.equal(compactionLabel(automatic, false), "Auto-compaction made no changes · took 12s");
    const manual: CompactionProgress = {
      ...base,
      phase: "completed",
      outcome: "unchanged",
      completedAt: 13000,
      afterChars: 1000,
    };
    assert.equal(compactionLabel(manual, true), "无需进一步压缩 · 耗时 12s");
    assert.equal(compactionLabel(manual, false), "No further compaction needed · took 12s");
    assert.equal(compactionNoticeKind(automatic), "info");
    assert.equal(compactionNoticeKind({ ...automatic, outcome: "compacted" }), "success");
    assert.equal(compactionNoticeKind({ ...automatic, phase: "cancelled" }), "warning");
    assert.equal(compactionNoticeKind(base), "info");
  });
  it("never mixes languages in any phase", () => {
    const phases = ["preparing", "summarizing", "completed", "failed", "cancelled"] as const;
    for (const mode of ["manual", "automatic"] as const) {
      for (const [phase, outcome] of [
        ...phases.map((phase) => [phase, undefined] as const),
        ["completed", "unchanged"] as const,
      ]) {
        const progress: CompactionProgress = {
          ...base,
          mode,
          phase,
          completedAt: 13000,
          afterChars: 200,
          ...(outcome ? { outcome } : {}),
        };
        assert.doesNotMatch(compactionLabel(progress, false, 13000), /[一-鿿]/u, `${mode}/${phase}`);
        assert.match(compactionLabel(progress, true, 13000), /[一-鿿]/u, `${mode}/${phase}`);
        assert.doesNotMatch(
          compactionLabel(progress, true, 13000),
          /\b(?:Compact|Auto|Summary|took|chars)\b/u,
          `${mode}/${phase}`,
        );
      }
      assert.doesNotMatch(compactionActivityLabel({ ...base, mode }, false), /[一-鿿]/u);
    }
  });
});
