# EASY CODE

English | [简体中文](./README_zh.md)

Technical design (architecture, terminal UI, permissions, memory, DAG, child sessions, Worktrees, and Handoff): [English](./docs/TECHNICAL_DESIGN.md) | [简体中文](./docs/TECHNICAL_DESIGN_ZH.md)

License: EASY CODE's original source is [MIT licensed](./LICENSE). Third-party components retain their own licenses; see [Third-Party Notices](./THIRD_PARTY_NOTICES.md).

EASY CODE is a local CLI coding agent for Alibaba Qwen, DeepSeek, and Zhipu GLM. Start it inside a project directory, describe the result you want, and let it inspect files, edit code, run commands, verify changes, manage context, and resume previous work.

EASY CODE runs entirely in the current terminal. It does not open a separate desktop window.

## Features

- Three working modes: Plan, Auto, and Code, with model-controlled routing in Auto.
- Read, create, update, and delete files inside the selected workspace; explicitly confirmed Dangerous full access also accepts absolute host paths.
- Run commands, tests, build tools, and supported npm installation commands.
- Run Manual and Auto-approved command process trees inside an OS-enforced `workspace-write` sandbox powered by `@anthropic-ai/sandbox-runtime` `0.0.74`.
- Optionally enable process-local Dangerous full access, with a second confirmation and persistent red warning, to run without sandboxing or approval as the current OS user.
- Show line-numbered code diffs with green additions and red removals.
- Keep completed output in terminal scrollback while updating current work in a compact inline status area.
- Switch providers, models, and thinking effort while the session is running.
- Attach screenshots and image files to supported vision models.
- Automatically manage short-term context and long-term project memory.
- Reduce model-request size with direct Auto answers and tool-relevant instructions.
- Inspect cumulative provider-reported Token usage with `/usage`.
- Save and resume conversations, plans, task progress, child sessions, and managed execution environments.
- Optionally organize complex work as a task DAG with dependency result lineage.
- Delegate work to children in shared roots or per-child Git Worktrees, then explicitly hand off an isolated result locally or to a branch.
- Load project instructions from `EASYCODE.md` files.
- Work on Windows, macOS, and Linux.

## Requirements

- Node.js `>=20.11.0` and npm.
- Windows, macOS, or Linux.
- An API key for at least one supported provider.
- Git is optional for shared child agents, but required for explicit Worktree isolation and branch Handoff.
- Optional: VS Code `>=1.93` for native image paste in the integrated terminal.

A maintained Node.js LTS release is recommended.

The command sandbox has platform prerequisites:

- Windows uses the bundled Anthropic SRT Windows backend, which is currently alpha and requires a one-time elevated setup.
- macOS uses the operating system's built-in Seatbelt sandbox and has no additional hard package prerequisite in the pinned runtime.
- Linux uses bubblewrap and requires `bubblewrap`, `socat`, and `ripgrep`; the host must also permit the user namespaces required by bubblewrap.

## Installation

The package is currently installed from the GitHub repository:

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm install
npm run build
npm install --global .
easy-code --version
```

The npm postinstall hook performs a read-only prerequisite check. It never opens UAC, runs `sudo`, or changes machine policy. On the first interactive `easy-code` launch, an unready sandbox is shown in the retained terminal UI and you can choose guided setup, recheck, continue with sandboxed commands blocked, or exit. Dangerous full access is never enabled by installation or a failed probe; it always requires its own in-session confirmation.

You can also check or repair the command sandbox explicitly:

```bash
easy-code sandbox doctor
```

On Windows, setup opens the one-time SRT UAC flow. On Linux, setup can install only the fixed packages reported as missing through a recognized system package manager; it uses structured arguments and non-interactive existing administrator credentials. It never changes User Namespace, AppArmor, kernel, repository, or other machine security policy. macOS normally needs no package setup.

```bash
easy-code sandbox setup
easy-code sandbox doctor
```

If Linux administrator credentials are not already available non-interactively, EASY CODE prints the exact package-manager command instead of collecting a password inside the terminal UI. Run it yourself, then choose recheck or run `easy-code sandbox doctor`.

If your GitHub SSH key is configured, you can clone with:

```bash
git clone git@github.com:dd1000001000/EASY_CODE.git
```

The npm installation prepares the resources required by automatic memory and tries to install the bundled VS Code terminal extension. Do not use `--ignore-scripts` for a normal installation.

To update an existing installation:

```bash
cd EASY_CODE
git pull
npm install
npm run build
npm install --global .
```

To run directly from the repository without installing globally:

```bash
npm install
npm run build
npm start -- --workspace /path/to/project
```

If VS Code was not detected during installation, run this from the EASY CODE repository:

```bash
npm run vscode:install
```

Set `EASY_CODE_SKIP_VSCODE_EXTENSION=1` before installation to skip the extension in CI or managed environments.

## Configure API keys

The recommended method stores API keys in the operating system credential store:

```bash
easy-code config set qwen.api-key
easy-code config set deepseek.api-key
easy-code config set glm.api-key
```

The command asks for the key through hidden input. Do not add the key after the command.

Check configuration status:

```bash
easy-code config list
easy-code config get qwen.api-key
```

Remove a saved key:

```bash
easy-code config unset qwen.api-key
```

Environment variables are also supported:

| Provider | Environment variables |
| --- | --- |
| Alibaba Qwen | `QWEN_API_KEY` or `DASHSCOPE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Zhipu GLM | `ZAI_API_KEY`, `GLM_API_KEY`, or `ZHIPUAI_API_KEY` |

If the selected provider has no configured API key, EASY CODE prompts for one before starting.

## Quick start

Open the project you want to work on and start EASY CODE:

```bash
cd /path/to/project
easy-code
```

On interactive startup:

1. Select DeepSeek, Alibaba Qwen, or Zhipu GLM.
2. Select a model.
3. Select `none`, `low`, `medium`, or `high` thinking effort.
4. Use the Up/Down arrow keys and press Enter to confirm.
5. Enter your request in the boxed composer at the bottom of the terminal and press Enter.

Example requests:

```text
Explain this project and identify its main entry points.
Fix the login error and run the relevant tests.
Add a settings page that follows the existing code style.
Review the current changes for security and maintainability issues.
```

Start with explicit settings:

```bash
easy-code --workspace ./my-project --provider qwen --model qwen3.7-plus --thinking-effort high --mode code
```

Run one task non-interactively and exit:

```bash
easy-code --workspace ./my-project --mode code run "Fix the login error and run the tests"
```

## Terminal interface

In an interactive terminal, EASY CODE keeps one inline interface in four regions:

| Region | What it shows |
| --- | --- |
| Session header | Current mode, provider/model, thinking effort, context estimate, workspace, and Thread ID. |
| Scrollback | Completed user/assistant messages, tool results, command output, diffs, and final results. This history is appended normally, so terminal scrolling and copy/select continue to work. |
| Live status | Above the composer, only currently running progress and command/model activity are shown. Completed tool results move to scrollback instead of remaining as duplicate progress rows. This is the only output region EASY CODE redraws. |
| Composer and footer | A boxed input area that wraps across terminal rows, followed by compact Tasks and Agents sections; the mode, model, effort, context, task, and active-Agent summary is always the final line. Attached images appear as `[Image #N]`. |

Completed tool activity moves out of the live status and into ordinary scrollback exactly once. Superseded Step/status rows are discarded rather than accumulated. A redraw clears only the live rows at the bottom; it does not repaint or erase earlier conversation, command output, or diffs. The layout measures terminal display cells, so narrow windows and wide Chinese, Japanese, Korean, and emoji characters remain aligned.

`/model`, command approval, Plan review, and `/resume` use boxed overlay pickers instead of appending temporary menu text. While a picker is open, it replaces the normal live status and composer, but an active Dangerous full access warning remains visible. Use `↑`/`↓` to move, Enter to confirm, or Esc to cancel. Canceling an approval is always treated as rejection.

With the bundled VS Code extension installed, hold `Ctrl` and click the gray `Thinking #N` text on Windows/Linux, or hold `Cmd` and click it on macOS, to open that block in a gray panel inside the redrawable live region. Repeat the same gesture on that marker—or on the `Thinking #N` text in the panel's bottom `↕` control line—to close it. Activating a different marker switches the panel to that block. The control remains responsive while a model request is running. Thinking panels do not support or consume Esc; Esc remains available to overlays and normal terminal input.

The temporary panel is bounded so it can always be erased safely without damaging terminal scrollback. If retained Thinking exceeds the visible panel, the panel reports the omitted row count and shows the exact `/thinking N` command that writes all retained content to stable scrollback.

In the composer, type or paste normally and press Enter to submit. A multiline text paste appears as a compact `[Pasted text #N · M lines]` block; its complete line breaks and indentation are restored only when you explicitly submit, so a newline inside the clipboard never acts as Enter. `/thinking N` and `Ctrl+T` still write the complete retained Thinking content to stable scrollback without discarding the current draft; they do not toggle the temporary panel. `Ctrl+C` cancels the active input or operation. With the bundled VS Code extension, the native image-paste shortcut inserts a visible `[Image #N]` attachment at the cursor; see [Images](#images) for platform shortcuts and command-based alternatives.

When stdout/stdin is not an interactive TTY, or the terminal cannot safely support cursor-addressed redraws, EASY CODE falls back to plain append-only status snapshots and line-oriented input without ANSI color. Interactive overlay selection may be unavailable in that mode; use explicit CLI options or command arguments such as `/model <model-id>` and `/resume <thread-id>`.

## Supported models

| Provider | Model | Image input |
| --- | --- | --- |
| DeepSeek | `deepseek-v4-flash` | No |
| DeepSeek | `deepseek-v4-pro` (default) | No |
| DeepSeek | `deepseek-v4-flash-vision-exp` | Yes |
| Alibaba Qwen | `qwen3.7-max` (default) | No |
| Alibaba Qwen | `qwen3.7-plus` | Yes |
| Alibaba Qwen | `qwen3.6-max` | No |
| Alibaba Qwen | `qwen3.6-plus` | Yes |
| Alibaba Qwen | `qwen3.5-plus` | Yes |
| Alibaba Qwen | `qwen3.5-flash` | Yes |
| Alibaba Qwen | `qwen3-max` | No |
| Alibaba Qwen | `qwen3-vl-plus` | Yes |
| Alibaba Qwen | `qwen3-vl-flash` | Yes |
| Zhipu GLM | `glm-5.3-flash` | Yes |
| Zhipu GLM | `glm-5.3` (default) | No |
| Zhipu GLM | `glm-5.2` | No |

The table is EASY CODE's supported catalog. Actual access depends on the provider, account, region, and model entitlement.

Switch models during a session:

```text
/model
/model <model-id>
/model qwen <model-id>
/model deepseek <model-id>
/model glm <model-id>
```

`/model` opens the Provider → Model → Thinking effort selector. Use `/provider qwen|deepseek|glm` to switch providers directly.

## Working modes

| Mode | Use it when |
| --- | --- |
| `plan` | You want EASY CODE to inspect the project and propose a plan without changing files or running build/install commands. |
| `auto` | You want the model to decide whether to answer directly, propose a reviewed plan, or implement the request. This is the default. |
| `code` | You want EASY CODE to implement and verify the request immediately without presenting a plan first. |

Switch modes at any time:

```text
/mode plan
/mode auto
/mode code
```

Auto routing is controlled by the selected model rather than keyword matching. If a request can be answered completely from the current conversation without workspace access, tools, side effects, or a reviewed plan, the routing request may return the final answer directly. Direct answers still follow the normal security and `EASYCODE.md` rules; when context has reached the mandatory compaction threshold, EASY CODE compacts it before routing or answering. Otherwise, the model routes the request to Plan or Code.

When Auto chooses Plan, EASY CODE shows the proposal and opens a boxed review overlay with three choices:

```text
Yes, use Auto mode
No, reject plan
Adjust plan with feedback
```

Approving returns to Auto and executes the accepted plan. Rejecting stops it. Choosing the feedback row opens a line prompt, then asks the model to revise the proposal.

## Thinking effort

Thinking effort affects model reasoning when the selected model supports it. It also controls the default task budget and maximum number of concurrently active child agents.

| Effort | Default maximum steps | Default context size | Child-agent limit |
| --- | ---: | ---: | ---: |
| `none` | 40 | 400,000 characters | 2 |
| `low` | 40 | 400,000 characters | 2 |
| `medium` | 80 | 800,000 characters | 4 |
| `high` | 160 | 1,600,000 characters | 8 |

`none` requests no model thinking where the provider supports disabling it. If a model does not support configurable thinking, the selected effort is still saved, but the thinking setting itself may not affect that model.

When a model returns Thinking content, EASY CODE writes a gray `Thinking #N` marker and short gray preview to stable scrollback. With the bundled VS Code extension installed, use `Ctrl+click` on Windows/Linux or `Cmd+click` on macOS to toggle a bounded gray panel in the live region. Activating another marker switches blocks; activating the current marker or the panel's bottom control closes it. Esc is not a Thinking-panel shortcut.

To write the complete retained content to stable scrollback instead of opening the temporary panel, use:

```text
/thinking
/thinking <id>
/thinking last
```

You can also press `Ctrl+T` in the interactive terminal to show the latest block. Both the command and shortcut preserve the current composer draft.

Optional base limits can be configured in user configuration or `.easycode/config.toml`:

```toml
[limits]
max_steps = 40
max_context_chars = 400000

[subagents]
isolation = "auto" # auto, shared, or worktree

[worktrees]
base_mode = "current-snapshot" # fresh, head, or current-snapshot
max_managed = 15
# root = "/absolute/path/outside-the-repository" # trusted user config only
```

`medium` uses twice these base values and `high` uses four times these base values.
`auto` uses a managed Git Worktree when the workspace is inside a Git repository
and falls back to the shared workspace only when no repository is available. If
Worktree provisioning is selected but fails validation, reaches its configured
limit, or cannot create a checkout, the child fails closed instead of silently
downgrading to shared writes.

The canonical custom storage setting is `root` under `[worktrees]`. It is accepted
only from trusted user configuration, must be outside the entire Git repository,
and defaults to the `worktrees` subdirectory of EASY CODE's application data
directory. A project
`.easycode/config.toml` cannot redirect it. Equivalent environment variables are
`EASY_CODE_SUBAGENT_ISOLATION`, `EASY_CODE_WORKTREE_BASE_MODE`,
`EASY_CODE_WORKTREE_ROOT`, and `EASY_CODE_MAX_MANAGED_WORKTREES`.

The Worktree baseline is a point-in-time input selected when a child starts:

| `base_mode` | Child starting point |
| --- | --- |
| `fresh` | The already configured `origin/HEAD`, falling back to local `HEAD`; EASY CODE does not fetch. |
| `head` | The current local `HEAD`, without uncommitted changes from the containing repository. |
| `current-snapshot` | Local `HEAD` plus staged, unstaged, and non-ignored untracked state across the containing repository, captured when the child is created. |

`current-snapshot` is the default, so a clean containing repository is not
required. In a monorepo, the snapshot covers the repository, while the child's
file tools normally remain confined to the selected logical workspace mapping.
Dangerous full access removes that security boundary for the main Agent and
children while it is active. It is not
live synchronization: later edits in the parent checkout do not appear in an
existing child and may cause a conflict when its result is handed off.

## Coding and workspace features

EASY CODE can:

- Read text files in the selected workspace.
- Create new files without silently replacing existing files.
- Update previously inspected files.
- Delete files after inspecting them.
- Run project commands, tests, formatters, builds, and supported installers.
- Display successful file changes as line-numbered diffs.
- Track file changes and recent commands for the current thread.

Useful commands:

```text
/workspace
/workspace refresh
/changes
/commands
/tools
/permissions
/approval
```

In Manual and Auto-approved modes, EASY CODE applies two independent command boundaries. Command policy and approval decide whether a resolved command may start; the Anthropic Sandbox Runtime then confines the approved command process tree at the operating-system level. Built-in file tools use EASY CODE's canonical workspace path guard.

For those protected modes, the sandbox is `workspace-write`: commands may write the active physical workspace and a Runtime-owned temporary directory, while EASY CODE's private state, common credential locations, and protected control files are denied. If SRT is unsupported, uninitialized, missing a dependency, or cannot prepare the command, execution fails closed with `sandbox_unavailable`; EASY CODE never silently falls back to the host.

When a command needs approval, use `↑`/`↓` and Enter to choose:

1. `Yes, allow execute one time` — approve only this command request.
2. `Yes, don't ask me again with prefix [executable]` — remember the exact Runtime-resolved executable path for the current thread.
3. `Reject` — do not run it.

The second choice applies to later argument vectors for that executable, survives `/resume`, and can be used by child Agents bound to the same parent thread. It does not carry into `/new` or another thread, and child Agents cannot create new grants. Treat grants for interpreters and shells such as Python, Node.js, `cmd`, or PowerShell as broad authority: later scripts or shell text can perform very different operations. The grant identifies a path, not immutable executable bytes, so replacing the file at that path does not revoke it. `/permissions` shows the active executable grants. Outside Dangerous full access, permanent policy denials, Plan mode boundaries, and `--approval never` always take precedence.

Use `/approval` to change the command posture for the current EASY CODE process with an arrow-key selector:

1. `Manual approval` asks before policy-eligible high-risk commands.
2. `Auto approve` executes approval-eligible commands without prompting, while permanent denials and structural boundaries remain active.
3. `Dangerous full access` disables command classification, permanent command denials, Plan command restrictions, approval prompts, and the OS sandbox. Before it is enabled, a separate danger confirmation explicitly warns that commands and file tools will receive current-user access to the full host filesystem, inherited environment, and internet. After it is enabled, a persistent red `! EASY CODE DANGER: FULL ACCESS` marker remains visible. The mode ends when EASY CODE exits or when another posture is selected; switching away immediately revokes the authority from the main Agent and every child, including waiting operations. The scrollback session title is not duplicated when the posture changes.

Dangerous full access uses a separate host backend. Commands run directly as the current OS user, may use absolute executables and working directories, inherit the host environment, access the internet, and read or modify anything that account can access. The checked file tools also accept explicit absolute host paths; relative paths keep their normal workspace interpretation. Main and child Agents inherit this process-level authority while it is active. EASY CODE does not bypass OS ACLs, UAC, `sudo`, or another account's permissions.

Structured program/argv execution, non-interactive shell shape, cancellation, timeouts, bounded/redacted output, process cleanup, and command audit remain active in Dangerous full access. These controls are not a sandbox or rollback mechanism. Host processes inherit environment variables and can expose credentials. Workspace snapshots and `/changes` cover the selected workspace, not arbitrary external modifications.

In protected modes, network access is capability based through SRT: ordinary commands receive no network access, constrained exact-version npm installation receives the Registry allowlist, and an explicitly approved shell receives its classified network capability. `@anthropic-ai/sandbox-runtime` is pinned because its API is still a Beta Research Preview and its Windows backend is alpha. A Git Worktree isolates Git state rather than security; Dangerous full access can reach outside every Worktree.

## Images

With the bundled VS Code extension installed, paste screenshots into the integrated terminal with the platform's native shortcut:

- Windows: `Ctrl+V`
- Linux: `Ctrl+Shift+V`
- macOS: `Command+V`

Attached images appear as `[Image #1]`, `[Image #2]`, and so on. Ordinary clipboard text continues to paste as text.

You can also attach images with commands:

```text
/image clipboard
/image ./path/to/screenshot.png
/image clear
```

Or attach one or more images at startup:

```bash
easy-code --image ./screenshot.png --image ./diagram.jpg
```

EASY CODE accepts PNG, JPEG, WebP, and static GIF images, with up to 99 images in a thread or model request. The active model must be marked as image-capable in the supported-model table.

## Tasks and child agents

For complex work, EASY CODE may create a task DAG containing named tasks and dependencies. This is optional: simple requests continue without a DAG.

Use `/tasks` to view the current task list:

- `✓` completed
- `▶` in progress
- `□` not started
- `⊠` blocked

The main agent may also delegate independent work to child agents. Child agents are optional and can be used with or without a task DAG. They inherit the selected provider, model, and thinking effort, work in Code mode, and cannot create more child agents.

Isolation is selected for each child as `auto`, `shared`, or `worktree`. The original project remains the logical workspace for rules and memory, while a Worktree child executes in its own physical checkout. Each assignment binds the parent Thread, child Thread, task, and execution environment so Resume cannot silently attach the child to another checkout.

Per-child isolation and Handoff are main-agent capabilities rather than slash commands. You can request them in ordinary language:

```text
Use Worktree-isolated child agents for the independent tasks.
Hand off the completed result to my local workspace.
Preserve the result on branch easy-code/login-feature.
```

Worktree results stay outside the current checkout until the parent explicitly hands them off:

| Result path | Behavior |
| --- | --- |
| Local Handoff | Preflight the complete child/DAG delta, then apply it to the current working tree without staging or committing. Unrelated user edits remain; overlapping edits produce a conflict instead of being overwritten. |
| Branch Handoff | Create or reuse a local branch at the immutable result commit without checking it out or pushing it. An existing branch at another commit is a conflict. |
| Shared child | Changes already occur in the current workspace; there is no isolated commit for Branch Handoff. |

With `current-snapshot`, the parent's original dirty state is part of the child's
baseline. Local Handoff applies only the child/DAG delta from that baseline, so it
does not reapply the user's original changes.

DAG children pass immutable result references only to their direct successors.
A join combines dependency commits in a newly provisioned managed Worktree;
conflicts stop node completion for review. A completed DAG can hand off its final
result only when it has one terminal leaf owned by the selected child. Multiple
terminal branches must first converge through an explicit join task.

Use these commands to inspect them:

```text
/agents
/subagents
/status
```

`/agents` is read-only. It shows each child's task and agent ID, resumable child
Thread ID, requested and effective isolation, environment state, and
result/Handoff state.

The active child-agent limit is 2 for `none`/`low`, 4 for `medium`, and 8 for `high`. A separate `max_managed` Worktree limit prevents unbounded retained checkouts and is not multiplied by thinking effort. Cleanup targets only manager-owned paths. A successfully delivered clean checkout is eligible for automatic removal; dirty, busy, retained, or conflicted environments remain and continue counting toward the limit. While child work is still running or waiting to be collected, Auto stays in Code mode so the parent can finish collecting the results.

If an ignored runtime file is required inside a new managed checkout, the root of
the containing Git repository may provide `.worktreeinclude` with safe patterns
relative to that repository root. Matching ignored files are copied into newly
provisioned Worktrees for every base policy. They are not guaranteed to be
present after checkpoint reconstruction, so the project must be able to provide
them again. Never include credentials, private keys, or other secrets.

## Context and memory

Context and memory are managed automatically. Users can inspect them but cannot manually add, edit, or delete memory entries.

```text
/context
/memory short [limit]
/memory long
/memory long <id>
```

- Short-term memory belongs to the current thread and includes the active conversation, summaries, task state, and recent tool results. `/memory short [limit]` shows previews of the latest active messages rather than the entire memory; the limit defaults to 8 and may be set from 1 to 500.
- Long-term memory stores useful project facts, decisions, conventions, and preferences for later sessions in the same workspace.
- EASY CODE compresses older context when the conversation becomes large.
- The session header and footer display an approximate context Token count such as `context:12.4k`.

## Token efficiency and usage

EASY CODE keeps model requests focused in two ways:

- Auto can answer a bounded, tool-free request in its single routing request instead of making a second agent request.
- Model requests include instructions only for the tools that are actually available in the current mode and step.

Use the read-only `/usage` command to inspect cumulative provider-reported Token usage for the current thread:

```text
/usage
```

The report separates usage by provider/model, request purpose (`auto_route`, `agent_step`, and `context_compaction`), and actor (the main agent and subagents). When the provider supplies the details, it also reports cached and reasoning Tokens. Requests for which the provider does not return usage data are counted as unreported requests. Failed requests and provider responses without usage details cannot be assigned an exact Token count, so `/usage` may be lower than billing-console totals.

`/context` remains an estimate of the active context size; `/usage` is the cumulative usage reported by providers for saved model requests in the current thread.

## Threads and Resume

Find the current thread ID with `/status`, or list saved threads with:

```text
/sessions
```

Resume from your shell:

```bash
easy-code --resume <thread-id>
```

Resume while EASY CODE is already running:

```text
/resume [thread-id]
```

Omit the ID to open the boxed Resume picker; provide it to resume that Thread directly.

Resume restores as much saved state as possible, including the selected model and mode, conversation, accepted plan, task progress, file/command history, context summary, completed child results, and valid active child Thread/environment bindings. A missing managed checkout directory can be reconstructed only after key identity, repository, and path metadata validates and the saved snapshot commit remains resolvable. A missing environment record, or one whose identity, repository, or path metadata does not validate for the existing child, fails closed rather than provisioning a different checkout. Durably completed child work is not rerun; interrupted commands or model calls are not automatically repeated.

Use `/new` to start a separate thread.

## Project instructions

Create an `EASYCODE.md` file to tell EASY CODE how to work in a project. Typical content includes:

- Build, test, lint, and formatting commands.
- Coding style and naming conventions.
- Important directories and architectural rules.
- Files or operations that should be avoided.

EASY CODE can load user-level instructions and project instructions from the workspace path.

## CLI options

```text
-w, --workspace <path>                         Select the workspace
--provider qwen|deepseek|glm                   Select the provider
--model <id>                                   Select the model
--mode plan|auto|code                          Select the working mode
--thinking-effort none|low|medium|high         Select thinking effort
--approval safe|ask|never                      Select command approval policy
-y, --yes                                      Approve policy-allowed prompts
--resume <thread-id>                           Resume a saved thread
-i, --image <path>                             Attach an image; repeatable
```

Run `easy-code --help` for shell-level help. Run `/help` after entering EASY CODE for interactive commands.

Sandbox maintenance commands run before entering the interactive Agent:

```text
easy-code sandbox doctor    Diagnose dependencies and run an enforcement probe
easy-code sandbox setup     Run Windows UAC setup or install fixed missing Linux prerequisites
```

## Interactive commands

```text
/mode plan|auto|code       Switch working mode
/provider <provider>       Switch provider
/model                     Open model selection
/model <model-id>          Switch model
/status                    Show thread and agent status
/workspace [refresh]       Show or refresh workspace information
/image <path|clipboard>    Attach an image
/image clear               Clear unsent images
/changes                   Show file changes
/tasks                     Show task DAG
/agents                    Show child agents
/tools                     Show available tools
/permissions               Show command permissions
/approval                  Select manual, auto-approved, or Dangerous full access
/commands                  Show recent commands
/context                   Show context usage
/usage                     Show cumulative provider-reported Token usage
/memory short [limit]      Show recent short-term memory previews (default 8, max 500)
/memory long [id]          Show long-term memory
/thinking [id|last]        Show model thinking
/sessions                  List saved threads
/resume [id]               Pick or resume a thread
/new                       Start a new thread
/clear                     Clear the terminal
/help                      Show help
/exit                      Save and exit
```

## Safety notes

- Review or commit important work before letting an agent make broad changes.
- Use `/permissions` to inspect the active command policy.
- Use `easy-code sandbox doctor` to verify the OS filesystem and network boundary retained by Manual and automatic approval.
- Prefer one-time approval unless you trust every later argument passed to the displayed executable in this thread.
- `--yes` should be used only in trusted workspaces or isolated environments.
- `--yes` does not bypass Plan mode restrictions or commands that are always denied.
- Manual and automatic approval retain the OS-enforced `workspace-write` sandbox; a sandbox setup failure blocks those commands instead of silently falling back to a host process.
- Dangerous full access intentionally has no EASY CODE sandbox or approval boundary. It can transmit host data, expose inherited credentials, install software, and modify or delete any data available to the current OS user.
- A Git Worktree isolates Git working state rather than providing the security boundary. Manual and automatic approval apply the command sandbox separately to that physical checkout; Dangerous full access does not.
- Never place API keys in source files, chat prompts, `EASYCODE.md`, or Git history.

## Troubleshooting

### `easy-code` is not found

Make sure npm's global binary directory is on `PATH`, then reinstall:

```bash
npm install --global .
```

### API key missing, 401, or 403

Check the active provider and key status:

```bash
easy-code config list
```

Then confirm that the account and region can access the selected model.

### Image paste does not work in VS Code

From the EASY CODE repository, run:

```bash
npm run vscode:install
```

Then run `Developer: Reload Window` in VS Code. `/image clipboard` remains available as a fallback.

### Memory resources are missing

Reinstall without `--ignore-scripts`, or repair them from the repository:

```bash
npm run memory:install
npm run memory:verify
```

### A command was refused

Use `/permissions` to inspect the current mode and approval policy. Plan mode does not allow code changes, builds, tests, or dependency installation.

If the result reports `sandbox_unavailable`, diagnose the platform boundary:

```bash
easy-code sandbox doctor
```

On Windows, run `easy-code sandbox setup` and approve the one-time UAC prompt. On Linux, the same command can install missing `bubblewrap`, `socat`, and `ripgrep` packages, but User Namespace/AppArmor policy remains an administrator decision. macOS uses its built-in Seatbelt sandbox. Manual and Auto-approved execution fail closed and do not retry outside the sandbox. Dangerous full access is a separate, explicit user choice under `/approval`, not an error fallback.

### Node.js is too old

Check the version:

```bash
node --version
```

EASY CODE requires Node.js `>=20.11.0` because the pinned Anthropic Sandbox Runtime has the same minimum.
