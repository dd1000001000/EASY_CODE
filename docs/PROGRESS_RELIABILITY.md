# Progress and context reliability

[简体中文](./PROGRESS_RELIABILITY_ZH.md)

## Validation is not process success

CommandRuntime retains the actual exit status separately from the bounded, streaming
framework verdict. unittest/Django, pytest, Jest-compatible summaries and Node TAP
can provide evidence. A failing test report overrides a successful outer filter.
Mixed targets, missing terminal evidence or incomplete parsing remain unknown.
The stream is captured before EASY CODE's display clipping, **not before an arbitrary
user shell pipeline**: a filter can remove evidence irreversibly. Unknown is not an
automatic rerun request; choose a minimal unfiltered verification when necessary.

The complete invocation remains auditable. Validation identities exclude only
recognized literal display pipelines after a known test runner. Selectors, cwd,
environment digest and non-literal/control-flow scripts stay distinct. Failure
signatures use bounded framework failure evidence, not unrelated setup logs or
test duration. Counts without specific failure evidence remain low confidence.
Exit-only custom/smoke/unit checks do not establish high-confidence test progress;
direct build/typecheck/lint/format contracts retain their exit-status semantics.

## Original testing standard

Before the first mutation, command or child-management capability, Runtime pins a Thread's first test/configuration inventory
in `progress.validation.baseline`. Pure read-only file investigation does not pay this scan cost. It preserves the current workspace bytes' hashes,
including existing uncommitted changes; it never substitutes Git HEAD. Verification
commands compare before/after inventories with that original inventory. Changed or
deleted original tests, changed collection configuration and newly introduced
collection configuration make results non-comparable. Adding ordinary new test
files alone is allowed. Partial inventories cannot certify an unchanged standard.
The full manifest stays in Journal/Runtime, not the model prompt; tool observations
carry only its digest, status and a bounded list of changed paths.

This is a bounded detector for conventional test paths and configurations, **not a
semantic proof that assertions were weakened, an immutable test runner, or a complete
dependency graph**. Changes restored entirely inside one command, unusual test layouts
or fabricated framework output need additional independent verification. It does not
declare cheating, forbid legitimate test changes, automatically restore files, or run
an original-test checkout on the user's behalf. Review can request a controlled
comparison, subject to the normal command policy and available original evidence.

Existing failure records are cleared only by matching high-confidence results with
the same baseline and target. Missing/new baseline identity cannot resolve an old
bound failure. Baselines and incidents are retained on Resume; a new Thread obtains
a new original inventory. There is no implicit baseline reset after test edits.

## Investigation and reviewer contracts

Three repeated high-confidence failures in distinct command cycles retain the
existing reviewer entry point. A changed testing standard adds a separate review
reason, not a fabricated code failure.

Investigation monitoring uses versioned read coverage, search-result identities and
successful `inspect` command results whose output is complete and small enough to
hash in full. Running polls are neutral; a completed inspection command is counted
only once by commandId. Truncated inspection output cannot prove exact repetition.
Overlapping reads of identical bytes do not become novel evidence merely by changing
line ranges. After one 12-response window with at least five successful samples and
more than 70% repetition, Runtime asks for a distinguishing experiment. A second
non-overlapping qualifying window can request the existing read-only reviewer.
New coverage interrupts exact repetition but does not erase an incident or create
verified improvement. Pure thinking, elapsed time, missing edits, waiting polls,
compaction and unrelated tool failures cannot alone trigger this detector. Unsupported
investigation surfaces have no automatic semantic-stagnation inference.

`progressInvestigationReviewEnabled=false` retains observation/reminders without
automatic investigation review. All thresholds and inventory bounds are in the
runtime limits configuration. Automatic early task termination is not enabled.

The reviewer uses the existing immutable packet and shared request/token budget,
with one review attempt per scope. It cannot execute tools or edit files. A fresh
`run_experiment` report must include `experimentProgram`, `experimentArgsJson` (JSON
string array) and `experimentCwd`, plus evidence, hypotheses and opposite signals.
This proposes an invocation, never an approval. Runtime binds the actual request,
propagates the binding through background command polling, and folds the terminal
result once. Unrelated commands cannot satisfy it. A new error is new evidence, not
verified recovery; a pass on altered tests cannot resolve the original failure.
Historical reports without a contract can only associate with their original target.

## Compaction length repair

`compactionAttempts=2` permits one length-only correction per transaction. A parent
submission counts as attempt one without being charged twice. Preserve the first
candidate and let a correction patch only overlong fields. After a second overflow,
or without correction capacity/budget, retain the first 1200 characters of each
overlong field/item (without splitting a UTF-16 surrogate). Do not convert types,
invent missing required fields, or certify unsupported evidence. Legacy V2 Runtime
declarations are discarded; only validated semantic fields may survive.

Journal stores original candidates, field-specific rejection diagnostics, prepared
material and deterministic acceptance before the final atomic commit. The summary
marks clipped fields as lossy. Resume preserves attempts and performs the same local
repair without buying a third submission. Capacity/benefit checks still apply;
unusable candidates use the existing local history-retirement/rebase recovery chain.
RAG, working summaries and checkpoint prose never reconstruct progress counts or
reset review/compaction budgets.

Regression coverage: `command-verification`, `command`, `progress-reliability`,
`progress-runtime`, `progress-lifecycle`, `compaction-transaction`, and
`smoke-command-usability.mjs` (real OS command/cleanup smoke; no model API).
