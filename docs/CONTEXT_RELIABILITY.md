# Context continuity and compaction

## Unified memory control

Runtime now selects project memories and Thread evidence under one optional-data
allowance. It refreshes bounded task/failure/path queries when their signature
changes, removes exact duplicate evidence and superseded file-version hits, and
removes optional recall before forcing conversation compaction. Current control
state remains in `RUNTIME_CONTINUITY_STATE`; the workspace supplement no longer
duplicates its goal, constraints, plan, DAG and command state. Auto routing keeps
its independent complete current-state view.

The local embedding pipeline is version 2: source text is divided into windows
measured by its own tokenizer, each within 128 tokens including special tokens.
Long direct embedding inputs aggregate all windows rather than silently ignoring
their tails. Thread indexing stores original offsets and file-version metadata.
Embedding and chat token units are distinct. SQLite FTS remains available during
background vector backfill; shutdown prevents late backfills from writing to a
closed database. Existing derived Thread indices are rebuilt once for this format.

Tool data is captured before model-output clipping in a scoped immutable evidence
store (up to 1,000,000 characters after redaction). This is captured tool data, not
unlimited process output. `manage_memory(action="recall", evidenceId, offset,
limit)` reads pages without rerunning a command. Capture/storage truncation and
pagination are explicit; legacy messages may have no full evidence record.

New Runtime memory proposals require `sourceRefs`: `user` for an explicit durable
user preference/convention, or captured versioned `read_file` evidence for project
facts. Invalid sources fail before staging. Reference validity does not prove
arbitrary natural-language entailment. File dependencies are rechecked during
automatic retrieval; changed, missing or unsafe paths mark the memory
`needs_verification`. Unproven legacy architecture/environment/decision memories
are also withheld from automatic retrieval until revalidated. Explicit audit
queries remain available. Independent append-only revision rows preserve future
changes beyond the existing bounded per-memory audit rendering. Historical audit
details already compacted by older versions cannot be recreated.

Accepted cumulative summary versions are archived independently and indexed as
historical claims, not automatically promoted to long-term facts. Token-managed
sessions now retire completed prefixes through independent Runtime transactions;
the character-only legacy protocol remains available for compatibility.

### Optional token capacity

Set `[limits].maxContextTokens` in TOML, or provide it in `EASY_CODE_LIMITS_JSON`,
to enable a provider-neutral operational token cap (`0` disables this additional cap).
It is not inferred from `maxContextChars`, and is not a claim about the provider's
native model window. Choose a cap no larger than the model actually supports.
Legacy character limits remain as an additional guard.

The estimator counts the full request (including thinking, tools and image
estimates), adds a 20% text-estimation margin, and reserves output, tool growth and
safety capacity. All Runtime provider requests use the same output cap, preserving
any smaller per-request limit. A versioned, conservative calibration learns from
adapter-normalized `usage.promptTokens`, including cache hits exactly once.
Endpoint/model identities and text/image inputs have separate sample windows.
Only numeric ratios are stored (migration 8), never API keys, prompts or thinking.
The last 32 samples can raise the estimate above its conservative baseline; missing
usage leaves it unchanged. This is empirical calibration, not a native tokenizer
or automatic discovery of a model's context-window limit.
With token capacity enabled, compaction acceptance checks the next normal request,
including restored optional memory, against the 55% target. Without it, the legacy
character policy remains compatible.

### Completed-phase transactions (enabled with token capacity)

Runtime closes a phase only after an observed terminal verification and a complete
assistant/tool exchange with no open command handles, or a successfully completed
turn. Poll waits, ordinary assistant replies and summaries do not close a phase.
A final reply after a verification does not create a tiny extra cycle. The most
recent completed cycle and all newer work remain raw, including their thinking.
Pending reviews/experiments and open commands prevent retirement. Older journals
can supply successful turn boundaries; missing verification-phase events are not
guessed from their clipped tool output. A single oversized unfinished phase may
therefore pause for more capacity instead of being destructively compacted.

At pressure, optional recall is removed first. Runtime measures a zero-summary
lower bound against the next ordinary tool/system envelope and retained raw tail.
If even that cannot reach 55%, it defers under soft pressure and pauses under
mandatory pressure without spending model requests. Candidates must reach 55%
with the actual summary, intent ledger and ordinary envelope included. The final
provider guard also reserves future tool output as well as answer/thinking and
safety space. A capacity pause uses `failure.code: context_capacity_insufficient`,
distinct from invalid-compaction exhaustion and code verification. Token-managed requests do not use the legacy overflow selector to
hide active history; image-count/byte limits remain explicit.

`context.phase.closed`, `context.compaction.started`, `.attempt`, `.candidate`
and `.rejected` are control-plane journal events, not ordinary chat/tool messages.
The source boundary and hash are frozen. The model may summarize the retired prefix
while keeping current user intent global; it does not move the prefix boundary.
Schema corrections include the previous candidate and exact validation feedback,
not an ever-growing transcript. Each request is reserved before dispatch and
charged to the shared model-request budget. At most three attempts belong to one
transaction, including requests whose response was lost.

One `context.compacted` event atomically commits transaction identity, summary,
intent and provenance before live state advances. A recovered candidate can be
revalidated without a second model request. New steering is checked against the
current intent ledger; a stale candidate must be corrected under the same budget.
Checkpoint snapshots cannot erase a transaction or reset its attempts. Exhausted
transactions remain exhausted on Resume; they do not silently get three more
calls. Raw source history and rejected candidates remain in the journal. There is
not yet a user-facing command for replacing an exhausted transaction's candidate
or granting it a fresh budget.

Validate rollout with isolated long-task runs: pass rate, total tokens per success
(including compaction/repair), repeated investigations, recall relevance, input
estimation error and retrieval latency. No benchmark improvement is assumed.

All providers share one history policy. Provider adapters translate API fields;
they do not decide which reasoning blocks to discard.

## Normal requests

- Keep all `reasoning_content` blocks in the active conversation segment,
  unchanged and in order. An assistant reply or new user message is not a
  reasoning-eviction boundary.
- Do not rewrite old tool results on every request. Preserve command output and
  task/reviewer results; reusable source/search material can be cleared only in
  the explicit pressure fallback.
- Keep the stable system prompt before history. Put changing workspace,
  checkpoint, retrieval, and Runtime continuity data after history.

## Pressure and fallback

The accepted working summary, latest request, user-intent ledger, constraints,
task state, unresolved command witnesses, and active ProgressGuard incidents
have protected space. Summaries and reasoning are never head/tail sliced.
Artificial reserved headroom may shrink to accommodate those fields.

In character-only compatibility mode, overflow selects complete assistant/tool exchanges and explicitly labels its
view as incomplete. It does not fabricate a summary from message snippets.
Pressure still includes the pre-selection active history, so this fallback
cannot silently permit normal work while dropping history. Runtime requires
structured compaction. If the protected state or newest exchange cannot fit
intact, Runtime returns a capacity error; increase the context budget or reduce
tool output. No durable history is deleted.

Only an accepted, provenance-checked cumulative compaction advances the durable
history boundary. It replaces old reasoning/messages with task conclusions and
evidence, not a rewritten chain of thought. It does not promise lossless recall.

## Runtime evidence

### Tool errors and compaction recovery

Runtime prevalidates built-in tool arguments before execution. Failures carry a
versioned `failure` envelope with a code, execution status, recovery advice, and
bounded field-level issues. A validation failure inside an already-entered tool
is conservatively treated as an unknown execution outcome. No error envelope
authorizes replaying a mutation, bypassing a denial, or inventing missing facts.

In character-only compatibility mode, complete sanitized compaction candidates, including `coverageCheck` and
`intentLedger`, remain in assistant/tool-call audit events and recoverable
history. They are not removed before validation. Accepted compaction retires
the old calls from active context; its persisted summary still excludes these
temporary fields. Failed candidates never advance the compaction boundary.

Mandatory compaction (including pre-Auto routing) has at most three attempts.
Corrections include the actual field paths or integrity/benefit rejection.
Main-loop corrective step extensions are capped at two per run, shared with
other tools; existing continuation/finalization allowances remain separate.
Plan and child-result submissions share the protocol budget. Ordinary tools
receive correction guidance but are never automatically executed again.

Exhaustion retains the existing `reason: failed` for caller compatibility, with
`failure.code: context_compaction_failed` (or `tool_protocol_failed`) and
`recoverable: true` in the run result and durable `turn.completed` event. It does
not complete/block a DAG node or claim that the coding task failed verification.
History and pending work remain intact. In character-only compatibility mode, an
explicit new turn/resume receives a fresh bounded correction budget; the stopped
turn never retries itself. Token-managed transactions preserve their consumed
attempts across Resume as described above.

Malformed JSON and invalid values are rejected, not filled with defaults.
In particular, missing constraints are not replaced with empty arrays and
missing coverage flags are not changed to `true`.

Command audits retain bounded stdout/stderr tails, a captured-output digest,
truncation information, and process-start/failure metadata. These witnesses are
captured before model-facing tool-output clipping. They are not a complete test
report and do not establish that the current checkout passed.

Unresolved commands are tracked by exact invocation and owner/task scope. A
successful unrelated command cannot resolve an earlier test failure. Legacy
redacted arguments cannot safely establish target equality and fail closed.
An exact successful rerun supersedes the previous failed observation for that
target; the journal still preserves both executions.

Progress observations and reviewer/experiment lifecycle events remain the
authority for ProgressGuard recovery. Checkpoint prose and RAG do not reconstruct
them. Active incidents, budgets, failure signatures, and unverified review
proposals are re-injected from the replayed Runtime state independently of the
model summary. The context layer does not launch reviewers or change incidents.

Verified summary entries require resolvable `command:<id>` or `message:<index>`
tool-evidence locators. This checks provenance, not arbitrary natural-language
entailment. Runtime command outcomes and experiment state remain authoritative.

## Cost diagnostics

Provider-context telemetry reports `hasPrefixBaseline`, `unchangedPrefixChars`,
and `previousSerializedChars`. These compare hashed request blocks without
retaining another copy of private content. They are local character diagnostics,
not token counts or server cache hits. Evaluate them alongside existing cached
input tokens, total tokens, latency, repeated validations, and benchmark success
rate. Preserving thinking can increase input size while reducing repeated work;
only a controlled benchmark can establish the net effect.
