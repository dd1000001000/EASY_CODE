/** Deterministic display summary only. Never feeds ProgressGuard or asserts requirements passed. */
export function summarizeVerification(text: string, maximumDiagnostics: number): {
  framework: string; reportedSummary: string; diagnostics: { text: string; occurrences: number }[];
  diagnosticsTruncated: boolean;
} | undefined {
  const lines = text.split(/\r?\n/u);
  const summaries = lines.filter((line) =>
    /^=+\s*(?:\d+ (?:passed|failed|error|errors|skipped|deselected|xfailed|xpassed|warnings?)[, ]*)+ in .+=+$/u.test(line.trim()) ||
    /^Tests:\s+.+\btotal\s*$/u.test(line.trim()) ||
    /^Tests\s+.+\(\d+\)\s*$/u.test(line.trim()) ||
    /^# (?:tests|pass|fail|cancelled|skipped|todo) \d+$/u.test(line.trim()) ||
    /^No tests (?:found|collected|ran)\b/iu.test(line.trim()));
  const node = summaries.some((line) => /^# tests /u.test(line));
  // Multiple independent summaries may be multiple test runs: retain raw excerpts.
  if (!summaries.length || (!node && summaries.length !== 1)) return undefined;
  if (node && (summaries.filter((line) => /^# tests /u.test(line)).length !== 1 ||
      !summaries.some((line) => /^# fail /u.test(line)) || !summaries.some((line) => /^# pass /u.test(line)))) return undefined;
  const groups = new Map<string, { text: string; occurrences: number }>();
  for (let i = 0; i < lines.length; i += 1) {
    if (!/(?:\b(?:FAIL(?:ED)?|ERROR|Error|AssertionError|warn(?:ing)?|deprecat\w*|security|notice|experimental|unsupported|not ok)\b|^E\s+|^\s*[×✗])/iu.test(lines[i]!)) continue;
    // Keep exact values and a small stack/assertion neighborhood, group only exact repeats.
    const value = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 4)).join("\n");
    const existing = groups.get(value);
    if (existing) existing.occurrences += 1;
    else groups.set(value, { text: value, occurrences: 1 });
  }
  return { framework: node ? "node_test" : summaries[0]!.trim().startsWith("=") ? "pytest" : "test_summary",
    reportedSummary: summaries.join("\n"), diagnostics: [...groups.values()].slice(0, maximumDiagnostics),
    diagnosticsTruncated: groups.size > maximumDiagnostics };
}
