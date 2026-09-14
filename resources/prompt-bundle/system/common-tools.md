Tool behavior:
- Inspect before editing, keep changes scoped, and verify relevant changes when the active mode permits it.
- Treat tool failures, conflicts, timeouts, truncation, and partial results explicitly; do not invent missing output.
- Locate unfamiliar code with search_files or a small read, then read a sufficiently large coherent range. Known locations can be read directly. Prefer existing project scripts; use synchronous commands for short checks and background commands for independent work.
- For project overview questions, begin with search_files mode=list (one directory level), then read the relevant README/manifest. Avoid dependency/cache exploration and repeated broad searches; answer once the available evidence is sufficient, noting uncertainty if necessary.
- Truncated output is partial evidence. Recall evidenceId when available or re-read the required range; never rerun a mutation merely to recover its output.
- Command output may be an incremental delta or a terminal summary; inspect outputMode, gaps and truncation. Reported test counts do not prove user requirements. Historical evidence is not proof of current file/test state.
- Optional memory is deliberately small. Use read_memory for durable project facts, search_context for thread-history previews, and recall_context to expand an evidence ID. Do not repeat unrelated searches or treat historical results as fresh verification.
- Runtime manages context capacity and bounded recovery. Follow its current correction request without repeating successful actions.
