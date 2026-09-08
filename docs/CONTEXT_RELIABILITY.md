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

## Runtime context maintenance

See [the context-maintenance contract](semantic-compaction-v3.md) for the current
pipeline, configuration defaults, event/replay protocol and verification scope.

The message builder is non-destructive. It exposes the full active projection;
it does not silently trim thinking or throw an overflow exception before Runtime
can try recovery. Retirement uses complete tool exchanges, not verified phases.

One capacity assessment covers ordinary system/tools/history/Runtime facts.
When maxContextTokens is nonzero it is the primary operational capacity, with
output/tool-growth/safety reserves and provider-neutral calibrated estimates.
Otherwise the character working budget and explicit headroom are used. A configured
window must not exceed what the selected model actually supports.

Runtime first removes optional memory and oversized tool bodies, then attempts one
short semantic handoff. It can move old exchanges and summaries into Journal-backed
references without a complete semantic summary. The 55% default target is soft:
sufficient execution space, source integrity and preserved control state are the
acceptance criteria. Growth-based cooldown prevents repeated paid summarization.

In the last recovery stage, the most recent complete exchange may also leave the
active context whole. Its original thinking is archived, not clipped or rewritten.
One such minimal rebase is allowed per durable user request. It preserves files,
command/child identities, task requirements, unresolved evidence and review budgets.
A new explicit request creates a new scope; replaying the old one does not.

If mandatory input still cannot fit, the run returns a recoverable capacity pause:
reason=limit_reached, failure.code=context_capacity_exhausted. The DAG is neither
completed nor externally blocked by this result. User cancellation, broken storage
and invalid Journal state are not hidden as successful recovery.

## Runtime evidence and tool errors

Built-in tools keep the common versioned error protocol. Invalid Plan and child
submissions still have their own bounded correction handling; ordinary mutations
are never auto-replayed. Compaction no longer uses that protocol as a mandatory
multi-attempt gate. A bad summary cannot manufacture missing coverage booleans or
erase constraints; Runtime supplies the facts independently.

Summary calls are isolated from the active work transcript. A transaction allows
two submissions at most, including an explicit parent submission; only text-length
overflow qualifies for one correction. A second overflow is clipped field-by-field
to 1200 characters, with a lossy marker and detailed Journal diagnostics. Insufficient
correction budget uses local clipping immediately. Types and evidence remain checked;
there are no auxiliary transport retries. Raw candidates and atomic commit
events remain durable. A response generated against changed Runtime facts is
discarded without another paid correction. Historical V2/repair events remain
readable, but do not authorize new repair loops.

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
