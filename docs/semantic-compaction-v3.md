# Runtime-owned context maintenance

## One recovery pipeline

Both token-managed and character-only sessions use the same controller:

1. Build and measure the next normal request, including system instructions,
   tool schemas, Runtime continuity and optional memory. Remove optional retrieval
   before sacrificing conversation history.
2. Reference older large tool bodies and bound aggregate tool bodies in each
   complete parallel-call batch. The original messages remain in Journal.
3. Choose a complete assistant/tool-exchange prefix. Prefer two recent exchanges,
   then reduce that tail locally if an empty-summary lower bound cannot fit.
   Read, write and command exchanges use the same rule. Verification phase events
   are observations, not permission to release history.
4. Make one best-effort handoff submission, without a length-only correction.
   Each text field/item has a 1200-character bound; clip oversized prefixes locally
   at safe UTF-16 boundaries. Preserve the complete business candidate in Journal.
   Aggregate storage overflow uses a valid JSON text-prefix wrapper marked lossy
   and unverified. Ordinary non-thinking prose may supply that wrapper; thinking
   alone never supplies a summary. Journal records original text and clipping diagnostics.
   Invalid JSON, types, missing required fields and unavailable summaries use local
   recovery. Unknown evidence is never promoted to verified fact. Capacity is still
   checked after repair; clipping is not a guarantee of sufficient context space.
5. Replace older whole exchanges and an oversized prior summary with precise
   Journal references and an explicit incomplete/unverified notice.
6. If necessary, archive the newest CLOSED exchange whole, including its thinking,
   and continue the SAME task from minimal pinned state. This is a lossy rebase,
   not a rewritten chain of thought, a new task, a workspace rollback, or a process
   restart.
7. If the minimal required input still cannot fit, return reason=limit_reached
   with failure.code=context_capacity_exhausted and recoverable=true. Preserve
   history, files, pending work and budgets. Never mark a DAG node completed.

No summary is guaranteed lossless. Missing historical details must be recovered
before relying on them. A reference is not evidence of successful verification.

## Capacity and cost

- When maxContextTokens is enabled, use the shared provider-neutral token estimate,
  calibrated from actual input usage. Output, future tools and safety have reserves.
  Character length is diagnostic, not a second model-token window.
- With maxContextTokens=0, use the character working budget with tool/safety
  headroom. This does not discover a provider's native window.
- Every acceptance path measures the next NORMAL envelope, never just the smaller
  compact-only request. A summary request also must fit before dispatch.
- contextCompactionTriggerRatio=0.8 starts maintenance; contextCompactionTargetRatio=0.55
  is a desirable target, NOT a mandatory acceptance threshold. A safe request above
  that target can proceed.
- contextCompactionMinGrowthRatio=0.1 prevents another paid summary after tiny
  growth. An unchanged history is not resummarized just because retrieval changes.
  Hard overflow and an explicit request bypass the appropriate soft guards.
- compactionAttempts remains available for historical transaction replay. New
  transactions do not make a second summary call for length overflow. An explicit
  parent submission counts as attempt one. Resume never resets spent attempts.
- contextSummaryMaxTokens=2048 bounds only retained summary storage (including the
  wrapper), alongside the 12,000-character ceiling. No output-token limit is sent
  to the server. Local output reservations and actual-usage settlement remain;
  an in-flight request may exceed its reservation. Transport size/timeout guards
  are separate from text retention, and never turn partial JSON into an executable call.
- contextToolBatchTokens=16000 budgets model-visible tool bodies across an entire
  multi-call exchange. References and protocol metadata have an irreducible cost;
  if that alone is large, overall capacity recovery retires the complete group.
- contextToolReferenceMinChars=4096 controls old large-output reclamation. A batch
  may also reference individually smaller bodies when their sum exceeds its budget.
- contextMaxRebasesPerRequest=1 permits one emergency rebase per durable user-request
  scope; 0 disables it. Journal replay preserves consumption. A new explicit user
  request starts a new scope, while merely recovering the existing state does not.
- contextMaxCapacityRetries=1 allows one smaller ordinary request after a narrowly
  classified provider context-length rejection. It uses the existing shared request
  budget, does not invoke another summarizer, and does not treat 429/auth/timeouts
  as capacity errors. This transport retry bound applies to the current run.

All operational defaults are in src/config/runtime-defaults.json and
docs/config.example.toml. No per-provider thinking transformation is used.

## Facts, summaries and storage

Runtime pins full retired user instructions (after secret redaction), active
constraints, Plan/DAG state, pending steering, command failures, progress incidents,
review proposals and experiments. Command handles and child identities/requirements
remain actionable after recovery: poll/wait for them, never restart them merely
because their original tool output left context. Review attempts and task budgets
are unchanged.

The model supplies currentWork, nextStep and optional decisions, conclusions,
hypotheses and failedApproaches. It does not supply coverage flags, user quote
indices or a made-up evidence registry. Unknown evidence references demote a claim
to an unverified hypothesis. Citation existence never proves arbitrary prose.

Journal remains authoritative:
- context.compaction.started/attempt/candidate/rejected/compacted retain atomic
  source/snapshot checks and the spent request count.
- context.compaction.abandoned closes an unusable optional summary attempt without
  claiming a semantic commit or resetting its budget.
- context.history.evicted records tool_references, history_evicted or minimal_rebase,
  the source/fact hashes, original summary, retired range and exact reference indices.
- context.maintenance.checked records the evaluated history, request identity,
  post-maintenance size and optional capacity pause. It prevents redundant work.

Checkpoints cannot advance a Journal-owned boundary or reset rebase/summary budgets.
Preview and replay use the same strict event reducer. Storage corruption, stale
commit events and cancellation are NOT swallowed as benign compaction failures.
An unanswered tool call is never split or replayed automatically.

manage_memory recall reads bounded pages by ev_..., journal_message_<index>, or
journal_summary_<sha256>. These are exact current-thread references, not RAG
guesses or command re-execution. Archived summary versions are historical claims,
not automatically promoted to long-term memory.

## Verification scope

The context suites cover both capacity modes, complete read/write/multi-tool
boundaries, one-shot malformed/failed summaries, safe acceptance above target,
growth hysteresis, minimal rebase, mandatory-input pauses, ordinary provider
capacity retry, shared request accounting, pending operations and experiments,
source integrity, and crash/checkpoint/Resume recovery.

These are local mock-provider and storage tests. Real long-task benchmark comparison,
false-positive capacity-pause rates and broad historical-version migration remain
separate evaluation work. No benchmark jobs or installed packages are changed by
this source refactor.
