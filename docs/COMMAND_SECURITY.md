# Mandatory command isolation

This security floor is independent of provider, thinking effort, DAG, and approval posture. It protects against model-controlled processes, not a compromised host administrator or kernel.

## Four implementation batches

1. All command paths use the OS sandbox. Plan is read-only; `unrestricted` is a legacy ID for **isolated no-prompt execution**, not host access. Workspace executables never receive trusted Git/Node/npm inspection exemptions. Executable bytes and npm policy material are checked again after approval.
2. A private worker pipe carries bounded lifecycle records independently from clipped stdout/stderr. Dispatch, launcher exit, and cleanup are distinct. Windows contains the worker and descendants in a kill-on-close Job Object, removes descendants before ACL reset, and confirms the Job is empty before releasing resources. Linux uses the sandbox's PID namespace. Only proven pre-dispatch failures with completed cleanup can be retryable.
3. A catalog download broker accepts approved artifact IDs. Development commands additionally use a separate per-command network gate under the mode rules below; Benchmark commands remain offline even during catalog downloads.
4. Harbor keeps its outer provider-endpoint allowlist and uses a dedicated Landlock/seccomp command backend instead of nested namespaces. Setup compiles the root-owned supervisor and selects the same Harbor backend for `sandbox doctor` and execution. Anonymous local AF_UNIX socketpairs and destination-free sends are allowed for IPC/asyncio; network sockets and named Unix services remain denied, including in dangerous mode. Ancillary message/descriptor passing is not enabled. Network restoration for the trusted verifier requires a returned agent process and no unfinished command leases or cleanup quarantine. See [Harbor isolation and compatibility limits](../benchmarks/swebench_verified/README.md#harbor-command-isolation).

## Approval and filesystem rules

Local Auto approval is shared by foreground and child agents: routine workspace reads/builds/tests/project code are eligible; explicit high-risk/system effects and unclassified local tools need approval. Named local file removal/moves are not categorically prohibited; recursive/uncertain effects ask. This is a risk signal, not a claim that arbitrary repository code cannot delete workspace files. Children cannot open an approval prompt and report missing authority to the parent. Dangerous mode still bypasses command approval, not isolation.

Manual asks for eligible local invocations and all network operations. Auto permits eligible local commands and proven network reads; downloads, uploads, remote mutations and unknown networking still require approval. Dangerous/no-prompt removes every command approval and Code-mode command-policy denial; it does not remove the OS boundary, read-only Plan, resource limits or Benchmark network isolation. Existing legacy shell/interpreter/package-manager grants remain inert. An explicitly approved new network prefix can cover these programs, with the broad authority explained before approval.

File tools stay workspace-relative in every posture. Traversal, network/device workspace roots, redirected workspace roots, and file-tool symlink/junction traversal are rejected. Runtime configuration, credentials, cache, journals, and executing resources remain outside the writable command boundary or explicitly protected. Where Plan commands are supported (Linux), only inspection recipes are allowed and the workspace is read-only even if a recipe is misclassified. Scratch storage is not project write authority.

Windows and Linux are the strict command backends. macOS command execution currently fails closed because process-group termination alone does not establish the required descendant-cleanup guarantee; file tools remain usable. Do not enable a weaker sandbox, privileged Docker, host networking, or host execution to bypass a failed preflight.

Windows Plan is currently **file-tools-only**: a real smoke test showed inherited directory deny-write ACLs do not reliably override explicit permissions on previously sandbox-created files. Command tools are hidden in Plan, and the backend refuses Plan spawns even if classification is bypassed. Linux retains read-only command recipes with the kernel filesystem fence. This restriction is intentional, not a claimed ACL guarantee.

## Development network authorization

| Operation | Manual | Auto | Dangerous |
| --- | --- | --- | --- |
| Proven read-only request | Ask | Allow | Allow |
| Download files/dependencies | Ask | Ask | Allow |
| Upload / remote mutation | Ask | Ask | Allow |
| Unknown command/script networking | Ask | Ask | Allow |

A matching explicit network prefix allows execution without another prompt in Manual/Auto. The Thread journal stores canonical executable path, executable content hash and structured argv prefix; `git fetch` does not match `git push`. A broad executable-only network prefix deliberately includes uploads and remote changes. Legacy ordinary executable grants never become network grants. `/permissions` lists grants and `/permissions revoke <index>` revokes one durably; running commands must finish/cancel first. Revoking a saved grant does not turn off dangerous mode.

Classification comes from resolved commands, not model `intent`. The initial auto-read recipe is a trusted `curl` with default config disabled (`-q`) and a narrowly parsed GET/HEAD argument set. Output-to-file is a download. Custom headers, bodies, config files, unknown flags, Git helpers and arbitrary programs require approval. This is operation classification, not proof that a remote server treats GET as side-effect-free or that a query contains no sensitive data. Approving an installer authorizes its child processes too; ordinary npm install/ci disables lifecycle scripts by default, while dangerous mode preserves the requested arguments.

The sandbox's HTTP/SOCKS proxies chain to a capability-authenticated Runtime gate. Before outbound DNS/connect, the gate obtains a command-scoped decision, checks public IPv4 destinations and pins the resolved address. Private/LAN/loopback/metadata addresses and IPv6 remain unsupported, even in dangerous mode. Raw socket/UDP clients that do not use the sandbox proxies are still blocked; approval is not a switch to unrestricted host networking. HTTPS uses CONNECT without decryption, so arbitrary scripts cannot claim read-only authority. Known network commands ask before launch; unknown scripts ask at their first proxy request. Approval/denial is cached only for that invocation to avoid repeated prompts. Timeout/cancel closes the gate and its connections. Runtime does not retry failed uploads.

Each gate is capped at 2,048 connections/requests and 512 MiB, with 16 KiB headers, a 10-second DNS deadline and bounded socket inactivity. `network.authorization` and `network.connection` events record effect, host/port and outcome, never request bodies, URL queries or proxy credentials. Commands remain supervised through their original cleanup/lease protocol. A background subagent cannot open stdin; it consumes an existing parent grant or an automatic read permission, otherwise reports the missing approval. Dangerous children never ask either.

Benchmark selects the trusted `benchmark` profile, not a model flag: commands receive no gate in **any** approval posture. Catalog downloads are not an answer-search exception and remain subject to both approval and the outer firewall. Noninteractive/disabled prompts fail closed unless an existing network prefix or the selected mode already grants authority.

## Catalog downloads

Trusted user configuration can contain `artifact-catalog.json` in the EASY CODE config directory, outside the workspace:

```json
{
  "version": 1,
  "artifacts": [{
    "id": "approved_asset",
    "kind": "file",
    "workspaceRoot": "F:\\my-project",
    "url": "https://assets.example.org/asset.bin",
    "integrity": "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "filename": "asset.bin",
    "maxBytes": 1048576,
    "redirects": []
  }]
}
```

Replace the example URL and placeholder integrity with the exact authorized object and digest. `kind` is `file`, `npm` (a `.tgz`), or `wheel` (a `.whl`). The model cannot edit this catalogue through tools. Necessary files still need explicit authorization; “download a file” is not blanket permission to search, retrieve a solution, or export data.

The initial `package-lock.json` v2/v3 can additionally authorize exact `registry.npmjs.org` tarballs with SHA-256/SHA-512 integrity. The initial manifest hashes and IDs are persisted per Thread. Editing the lock, compacting context, or resuming cannot authorize new packages. A malformed/unsupported lock contributes no implicit authority. Python wheels and other files need explicit catalogue entries; this version is not a general dependency resolver.

`fetch_artifact` is a main-agent Code capability with `list` and `fetch` actions. It returns verified files under `vendor/downloads/<id>/<filename>`. Existing changed files are never overwritten. The broker performs HTTPS GET only, public IPv4 DNS validation with connection pinning, certificate validation, exact authorized redirects (at most 3), no cookies/proxy credentials, bounded bytes/time, integrity validation before installation, and an independent immutable cache. IPv6 downloads are currently rejected conservatively. A per-Thread byte ledger survives Resume; interrupted/incomplete ledgers fail closed.

Each object is capped at 256 MiB (implicit npm tarballs: 64 MiB); the Thread transfer budget is 512 MiB and each transfer has a 60-second deadline. Failed transfers retain their reservation. These are security ceilings, not model-adjustable options.

Catalog installation can happen separately and offline. For npm, fill a workspace-local cache using verified tarballs, then use `npm ci --offline --ignore-scripts --cache <workspace-cache>`. For wheels use `python -m pip install --no-index --find-links vendor/downloads/... <package>`. No installation or extraction executes inside the catalog broker. In development, ordinary install commands may instead use the network gate after authorization; in Benchmark missing transitive artifacts never open a network exception.

The benchmark prefers dependencies preinstalled in its trusted setup/image. Its outer endpoint allowlist can also reject broker downloads; it is never temporarily opened for arbitrary agent traffic.

## Failure evidence and recovery

`command.preparing`, worker lifecycle events, and `command.finished` are appended to the owning Thread journal. Leases under `<dataDir>/command-leases/<workspaceId>/` survive process crashes; quarantine markers live under `<dataDir>/command-quarantine/`. They are not model-editable and are not cleared by context compaction or Resume.

Windows additionally quarantines the shared sandbox identity at `<OS temp>/easy-code-srt-runtime/windows-acl-quarantine.json`; an abandoned shared ACL lock is not automatically stolen. This prevents a second workspace from reusing uncertain ACL state. Raw per-path revoke/restore outcomes are validated because the underlying SDK's `reset()` can resolve after merely logging an ACL failure.

An exit code is the sandbox launcher's terminal result, not proof that every target-side effect succeeded. After dispatch, missing terminal evidence is **unknown**, never “unstarted, retry freely.” Cleanup failure retains the observed exit code and output, does not repeat the command, and blocks further command/file mutations in that environment. Read-only diagnostics remain available. Failure to persist/audit completion is also conservative.

Do not delete leases just to make a job continue. An operator must establish that the relevant processes are gone, inspect/repair sandbox ACL state with `easy-code sandbox doctor` and the existing dry-run-first Windows repair workflow, and only then archive the exact stale control records. There is intentionally no model-facing “clear quarantine” bypass. For disposable benchmarks, retain logs and recreate the affected environment; do not resume uncertain cleanup state into public networking.

## Verification

### Command usability and validation evidence

After Windows dispatch, cancel/timeout first quiesces the target descendants while keeping the trusted worker alive for ACL reset. Only then is the empty Job closed. Concurrent quiesce requests share the in-flight operation, never a stale `QUIET` record. A bounded cleanup deadline still force-terminates and quarantines unconfirmed cleanup. `smoke-command-usability.mjs` exercises scripts, multiline/literal argv, masked test exits, child cancellation and timeout on the real OS backend.

For Code-mode PowerShell `-File`, default normalization uses `-NoProfile -NonInteractive -ExecutionPolicy Bypass` on that child process only, matching the already allowed inline-code capability. An explicitly supplied execution policy is retained. Runtime never calls `Set-ExecutionPolicy` or changes user/machine policy; OS sandbox and organization policy still apply.

`normalizeCommandRequest` is shared by run/start and Runtime. Missing verify/test categories become `custom`, build becomes `build`, and inapplicable/invalid verification metadata produces a bounded warning instead of a correction call. Missing program, invalid execution argument types and NUL remain errors. Runtime-issued request metadata is retained in journal/model projections and across polls; declared intent never grants permissions.

Direct argv is literal, including multiline Python/Node code and punctuation. Relative executable paths resolve from `cwd`. Command cwd accepts absolute/relative forms and normalized parent segments within the workspace. Local link destinations are checked before traversal; remote/device links are refused. Local executable aliases to checked system tools do not expand filesystem authority. Git `-C` is canonicalized within the workspace; configuration overrides and `.git` writes remain restricted.

One-shot scripts (`bash script.sh`, `pwsh -File`), heredocs/here-strings, pipelines, redirection, synchronous nested calls, PowerShell `&`, short sleeps and timeout wrappers are supported. Explicit detached protocols still direct the model to Runtime background handles. Interactive/login/encoded hosts remain unsupported outside dangerous mode. Script content is opaque project code; enforcement depends on the OS sandbox and descendant cleanup, not a complete shell parser. Runtime does not join malformed cmd argv, add `set -e`, or silently change pipeline semantics.

`validation` is separate from execution exit/status. A bounded streaming collector recognizes matching unittest/Django, pytest, Jest and Node test terminal reports **before display clipping**. Framework failure overrides a zero outer exit. Bare shell/filter exit status, mixed targets/reports, conflicting success/nonzero status, and incomplete evidence become `unknown`. Failure counts without specific error evidence are low-confidence and cannot trigger a reviewer by themselves. Full failure-line hashes distinguish assertions beyond the displayed excerpt. Direct declared custom/build commands can use process exit evidence; this is not proof of requirements or protection against fabricated test output.

ProgressGuard consumes the Runtime verdict and failure signature, not the display summary: three distinct matching high-confidence failure cycles can trigger review; polling is deduplicated; unknown/low-confidence results do not clear stagnation. Resume uses journal observations; clipped historical output is not reconstructed into framework evidence. No automatic rerun is implied by `unknown`.

`node scripts/replay-command-requests.mjs <absolute-job-directory>` replays only request shape and advisory policy. It never spawns historical commands, resolves container executables on the host, calls providers or changes jobs. Tests include `command-usability` and `command-verification`; real OS smoke is still required for isolation guarantees.

Focused tests: `network-authorization`, `command-security`, `download-broker`, `command`, `sandbox`, `swebench`, approval and lifecycle suites. After `npm run build`, `node scripts/smoke-command-isolation.mjs` checks OS confinement and cleanup. `node scripts/smoke-command-network.mjs` checks a real curl command through SRT and the authorization gate, using a trusted fixture-only DNS mapping to a local server. Neither smoke calls a model API or the public Internet. A failed smoke retains its exact directory for diagnosis.

Unit tests do not establish host kernel/firewall readiness. Linux/Docker namespace policy and Windows WFP/ACL provisioning must also pass the actual OS preflight on the deployment machine.
