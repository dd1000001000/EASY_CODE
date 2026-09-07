# Context continuity and compaction

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

Overflow selects complete assistant/tool exchanges and explicitly labels its
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
