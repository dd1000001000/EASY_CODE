# Lightweight Runtime

Operational defaults live in `src/config/runtime-defaults.json` and ship in the
compiled package. `easy-code config defaults` prints a complete, credential-free
TOML configuration. See [config.example.toml](config.example.toml).

Configuration precedence: defaults → user TOML → workspace TOML → environment.
Use `[limits]`, `[limits.steps]` and `[limits.providerTimeoutMs]`; maps merge by
field. `EASY_CODE_LIMITS_JSON` accepts the same limits object for headless runs.
Old flat limit settings, snake_case limit names and `EASY_CODE_MAX_*` limit
variables are intentionally unsupported. Invalid or unknown limits fail startup.
Provider credentials and trust-root restrictions are unchanged.

## Budget semantics

- Actor steps default to none/low/medium **40**, high **80**. Routing, compaction
  and the actor's reviewer requests share that cap. Finalization and protocol
  correction never grant extra model requests beyond it.
- `maxModelRequests` limits actual provider attempts across parent and children,
  including transport retries. Runtime disables hidden adapter retries and owns
  bounded retries. Explicit control-plane requests may prohibit retries.
- `maxTaskTokens` counts input + output, not cache/reasoning subsets twice.
  Reservations include estimated input and the maximum response; concurrent
  requests cannot reserve the same remaining budget. Missing usage or failed
  requests conservatively consume their reservation. This is a local estimate,
  not a provider billing guarantee.
- Shared debits are written to the parent journal before dispatch. Resume of
  existing children retains the shared budget and charges any crashed in-flight
  reservations. A new user turn without running children starts a fresh budget.
  Compaction transactions separately retain their original attempt ceiling.
- `maxContextTokens = 0` means no additional token cap, not a guessed model
  window. Configure a real supported ceiling to use token-window management.
  Context reserves and maximum response tokens remain provider-neutral.
- File/path/schema validation ceilings, sandbox capability limits and evidence
  integrity constraints are safety bounds, not tunable task budgets.

## Orchestration

`/orchestration` opens the existing up/down/Enter/Esc picker. `/orchestration on`
and `/orchestration off` are also accepted in noninteractive use. Defaults are off
for new lightweight sessions; the selected state is saved in the thread and shown
as `DAG/agents on|off` in the CLI. `/status` shows limits and shared usage.

Off hides DAG/subagent tools when no existing work needs them. With existing
work, management remains available but new DAGs and child spawns are rejected by
Runtime/tool boundaries. No child is canceled or DAG silently completed by the
switch. The isolated read-only stagnation reviewer stays enabled, with its
existing evidence, one-review-per-scope and experiment requirements.

Headless launchers can explicitly select the configuration with
`EASY_CODE_ORCHESTRATION_ENABLED=true|false` (strict boolean text, overriding
TOML). The SWE-bench adapter sends `true` into each task container and binds that
setting into checkpoint identity. Ordinary CLI defaults remain off. Existing
thread-level selections still take precedence when resuming a thread.

## Commands, output and cache

Short commands use synchronous execution. An omitted `poll_command.waitMs`
waits internally in bounded slices until completion or the configured deadline;
these slices do not call the model. Explicit `waitMs = 0` is an immediate probe.
Steering wakes the wait without killing the process; cancellation remains a
separate operation. The original process timeout still applies.

File reads default to 100 lines for locating code. Explicit ranges allow up to
1,000 lines, with a separate 12,000 estimated-token result budget and remaining
request capacity. Only complete lines are returned, with actual range, full-file
hash and `nextStartLine`; an individual over-budget line returns an explicit error.
Known locations can be read directly. `search_files` provides filename/glob or
literal-text discovery without shell commands, dependencies or a language index.
It reports scan/result caps and skipped files, skips links and common generated/
dependency directories, and uses existing path/revocation checks. Explicit paths
can target ordinary excluded directories, not bypass protected paths. Search
does not grant read-before-write authorization. No automatic read suppression or
batch-read tool is introduced.

For project orientation, use `search_files` with `mode: "list"`: it lists files
and directories at one level without a shell or command approval. Recursive
search is breadth-first, skips Python site-packages and caches, and supports
bounded flat brace globs such as `*.{json,md,toml}`. Unsupported patterns fail
explicitly. `maxDepth` is capped by `searchMaxDepth` (default 64); depth/entry
truncation is reported as partial evidence. `searchRepeatWarningCount` defaults
to 3: repeated identical searches/results produce a Runtime hint to narrow the
search or answer, not a reviewer, task failure or automatic termination. Bounded
search fingerprints and the threshold are journaled with observations for replay.

Command projections retain up to 12,000 chars for inspect/query answers, 2,000 for
successful operations and 8,000 for failures. Complete recognized pytest/Jest/
Vitest/Node summary output can be represented by reported counts and bounded,
exact-grouped diagnostics. Unknown/ambiguous/truncated output falls back to head/
tail excerpts; zero exit does not establish test discovery or requirement coverage.
Identity, terminal status, exit code and infrastructure failures are retained. Original
captured evidence remains subject to its own capture limit and is stored before
projection; existing evidence recall can page it when available. ProgressGuard
continues to consume the raw result, never a clipped model projection.

Running polls use append-only stream cursors from committed model-visible tool
messages in the current request. Cursor prefix hashes are checked; changed
redaction, non-append-only captures and truncation produce marked snapshot gaps.
No prior visible cursor (including after phase retirement) means a fresh snapshot.
The first terminal result uses cumulative evidence rather than just the last
delta. No mutable cursor advances before a tool-result journal commit.

## Optional memory

Automatic long-term-memory plus RAG injection starts at 2,000 estimated tokens,
with a 6,000-token ceiling after terminal failures or a phase transition; request
capacity can lower either. Explicit `manage_memory search` with `scope: history`
returns short current-thread previews, then `recall` pages either `context_` or
`evidence_` references under workspace/thread checks. The default search scope
remains long-term memory. Up to three bounded queries and six selected items are configurable.
Candidates use shared lexical relevance and reciprocal source ranks, never a
direct comparison of vector scores from different indexes. Weak matches may
produce no results. Exact duplicates and known stale versions are excluded;
negations, qualifications and differing file versions are not semantically merged.
User constraints, current intent, unresolved errors and experiments remain in the
authoritative continuity layer outside this optional budget.

Task diaries are rejected for new durable-memory proposals; stable facts retain
their source requirements, revision history and exact-duplicate no-op behavior.
Existing rows are not mass-deleted or rewritten. Invalid proposals and exact
active duplicates do not require new embeddings. No additional summarizer model
is invoked. `context.memory.selected` reports projected tokens, dropped records,
cache/search counts and local retrieval time; these are distinct from provider
usage/billing. Quality and total successful-task cost still require benchmark tests.

Prompts avoid repeated tool-schema explanations. Stable policy/tool/project
guidance precedes environment and task data; environment time is anchored to the
run rather than regenerated each model step. This preserves longer prefixes but
does not guarantee a provider cache hit or a benchmark quality improvement.
