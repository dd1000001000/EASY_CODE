# Command permissions and execution environments

Work mode, approval authority and execution environment are separate decisions.
This contract supersedes the earlier “mandatory isolation in every mode” design.

## Work mode

Code performs implementation. Plan focuses on investigation and a structured proposal:
it instructs the model to avoid direct file-editing tools, but does not enforce a read-only filesystem.
Plan commands follow the same approval path as Code and may write when authorized.
File tools retain workspace-relative paths, prior-read/version checks and Runtime resource protection in every mode.

## Approval authority

| Mode | New commands | Matching saved grant | Execution default |
| --- | --- | --- | --- |
| Manual (`manual`) | User: allow once / allow prefix / reject | Reuse | Workspace OS sandbox |
| Approve for me (`auto_approve`) | Independent approval agent; rejection/error/timeout escalates to user | Reuse | Workspace OS sandbox |
| Full access (`unrestricted`) | No approval | Not needed | Host, no EASY CODE sandbox |
| Trusted Benchmark | No approval | Not needed | Offline task container only |

Manual includes inspection commands. Static risk classification is descriptive, not an auto-allow or deny authority.
The independent approval agent is a separate, tool-free provider request, not a normal work subagent or progress reviewer.
It returns a strict flat decision/reason object; it cannot execute commands, edit files, manage DAGs or invent permission scope.
It receives the task, exact structured command and proposed grant; untrusted descriptions are evidence, not instructions.
One request, no schema/transport retry: failure requires a user decision. All its requests/tokens use the shared task budget.
Defaults in `limits`: `approvalInputChars=24000`, `approvalOutputTokens=1024`, `approvalTimeoutMs=60000`.
Optional user-only `approvalModel` selects another model on the current provider; otherwise the active model is used.

Parent and child requests share a serialized parent-owned approval queue. A child never owns a second terminal.
A denied automated review can be overridden by the user with any of the three choices.
Cancellation, a changed thread or a changed mode invalidates the outstanding decision.
When interactive approval is unavailable, a missing grant is `approval_unavailable`, not an implicit yes.
A process restart never revives an allow-once decision or a paid approval request automatically.

## Prefix grants

Runtime produces structured `command:v2` grants bound to canonical executable identity/hash,
a subcommand prefix or exact argv identity, cwd, filesystem scope and network permission.
Workspace cwd is relative so the root thread's grant can apply to a corresponding child checkout.
Host/container cwd is absolute. Grants never cross unrelated threads.

Common ordinary executables may receive a subcommand prefix (for example `git status`);
shells, interpreters, package managers and non-subcommand forms use exact argv hashes.
Inline script text and secrets are not persisted in the grant.
Script contents and repository hooks can change: a saved grant is permission to repeat the invocation,
not proof that its effects remain identical. The approval agent is instructed to prefer one-shot permission in those cases.
Executable bytes and resolved material are rechecked after approval; changed material requires a new invocation.
`/permissions` lists the actual scope, `/permissions revoke <index>` durably revokes it.
The Journal is authoritative; compaction or Resume cannot create a grant.

## DAG / subagents

- Enabling orchestration while Manual requires explicit confirmation to enable both orchestration and the approval agent.
- Switching to Manual is prohibited while any unfinished DAG, active child, outstanding child result or command handle remains.
  Nothing is stopped, canceled or silently changed; wait for completion and retry the switch.
- When idle, selecting Manual atomically disables orchestration and persists that toggle.
- A restored child stays unstarted in Manual until the user selects a sufficient approval level.
- Switching back to automatic approval does not silently turn a disabled orchestration toggle on.
- The independent progress reviewer stays enabled and read-only. Child concurrency remains none/low=2, medium=4, high=8.

## Execution boundaries

Ordinary commands default to the existing Windows/Linux OS sandbox. Plan uses workspace-write, like Code.
Sensitive Runtime resources and protected Git metadata remain outside that default writable boundary.
Sandbox setup failure does not silently fall back to host execution; macOS strict sandbox limitations still apply.
An explicit `executionScope="host"` asks for host filesystem and network permission together with the command.
Full access selects that host backend directly: it is **not** a security boundary against model commands,
which can use the user's ordinary OS permissions. It does not elevate the OS account.
EASY CODE does not inject provider credentials into child environments; full-access processes can nevertheless read
host files allowed to that account. Only select it for trusted work.

Shell syntax is not used as a security proof. Multiline argv, scripts, pipes, redirections, login/encoded shell forms
and ordinary installer arguments are not categorically rejected by Runtime.
Missing executable, malformed argv/NUL, unsupported remote executable paths and invalid cwd remain input/path errors.
Workspace cwd is canonicalized within its boundary; approved host cwd may be outside it.
`intent` and verification metadata never grant permission. Missing test/verify metadata becomes `custom`.

Workspace-network commands use a per-command HTTP/SOCKS gate. Identified networking is part of initial approval;
an otherwise unknown script asks for additional network permission on its first connection.
The gate still rejects private/LAN/metadata destinations and unsupported raw UDP/IPv6; approval is not unlimited networking.
Use explicit host scope when the task genuinely requires host networking.
Full access has ordinary host networking without that gate. Benchmark commands have no network gate or download exception.
Development catalogue downloads remain exact, integrity-checked trusted catalogue operations; Benchmark does not expose this tool.

## Benchmark controller / worker / verifier

The trusted adapter creates three distinct roles before staging model credentials:

1. Harbor's original task container becomes the clean verifier.
2. A trusted controller runs EASY CODE, retains credentials/logs/bridge files, and uses Harbor's provider-host allowlist.
3. An offline worker runs every model command with container-wide filesystem access and Docker network `none`.

Controller and worker share the task volume, not credentials, logs, a Docker socket or host directories.
The controller's Git database/config/hooks occupy a private nested volume; worker changes to its own `.git` cannot
cause controller-side Git helper execution. Children use the same shared task volume.
Only a host-side Python broker controls Docker. The worker has private IPC and normal 64 MiB `/dev/shm`,
so local sockets, asyncio and multiprocessing are supported without the old nested Landlock/seccomp restrictions.
No privileged mode, host PID/IPC/network or extra capabilities are added.

Worker commands are serialized. After each command Docker restarts the worker to terminate all descendants,
including detached processes, while preserving its filesystem and task volume.
Background services do not survive between commands; keep server/client work in one supervised command when needed.
Queue waiting is outside the command execution timeout and remains cancelable.
The bridge output has a 32 MiB per-command ceiling; archive transfer/export inventories are bounded.

Before verification, the worker is stopped. Regular project files and unchanged baseline symlinks are exported
into the original checkout; worker `.git`, Runtime directories, new symlinks/devices/hardlinks are not exported.
The clean verifier retains pristine Git and external test material. Network restoration still requires closed leases
and no cleanup quarantine. Unexpected cleanup is never disguised as a test failure.
Worker root-filesystem installs are temporary and not checkpointed; only task changes and controller state are retained.
See [Benchmark details](../benchmarks/swebench_verified/README.md#harbor-command-isolation).

## Evidence and failures

Approval review/decision, grant, revocation and mode changes are Journal events.
Model usage has purpose `command_approval` and actor `approval_agent`, separate from progress review.
Command failures distinguish invalid parameters, policy boundary, approval unavailable/rejected,
sandbox/infrastructure, timeout/cancellation, and process exit.
An unstarted denial is not a test failure; an unknown dispatch must not be rerun automatically.

A private control pipe records dispatch, exit and cleanup independently of clipped output.
Windows sandbox Job Objects and Linux isolation supervise descendants. Full host mode is unsandboxed and its process
supervision is best-effort; it cannot provide the same isolation guarantee.
Uncertain cleanup retains leases and quarantines the environment; compaction does not clear these records.

Validation is separate from outer exit code. Recognized unittest/Django, pytest, Jest and Node failures
override a pipeline's zero exit. Incomplete/conflicting evidence is unknown, not a passing test.
ProgressGuard consumes original structured evidence, not the display summary.

## Verification

`npm run build:test` and the test runner cover approvals, scopes, prefix replay, mode transitions,
tool schemas, Plan exposure, network gating and existing lifecycle/validation behavior.
`scripts/smoke-split-benchmark.py` uses disposable local Docker images without model calls:
it checks container/credential/host-mount separation, external-network denial, local IPC and a 12-process pool,
worker-only programs, private controller Git, detached cleanup, timeout, clean export and Django's 46 writer tests.
This is a compatibility/isolation smoke test, not an official SWE-bench score.
