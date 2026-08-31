# EASY CODE

English | [简体中文](./README_zh.md)

[Technical design](./docs/TECHNICAL_DESIGN.md) | [中文技术设计](./docs/TECHNICAL_DESIGN_ZH.md) | [Third-party notices](./THIRD_PARTY_NOTICES.md)

EASY CODE is a cross-platform CLI coding agent for Alibaba Qwen, DeepSeek, and Zhipu GLM. Run it inside a project, describe the result you want, and let the agent inspect the workspace, edit files, run commands, verify changes, manage longer tasks, and resume previous work.

The interface stays inside the terminal. Model requests go to the selected provider; project operations, session state, memory, and orchestration remain local.

## Highlights

- **Plan, Auto, and Code modes.** Auto lets the model choose whether to answer directly, propose a reviewable plan, or start implementation.
- **Controlled coding tools.** Read, create, update, and delete files; run builds, tests, formatters, and supported installation commands.
- **Reviewable changes.** File edits are shown as line-numbered diffs with green additions and red removals.
- **Retained terminal UI.** Conversation, live activity, tasks, child Agents, model information, and the composer stay in one structured shell interface.
- **Thinking display.** Provider reasoning is shown in gray, collapsed by default, and can be expanded in place in the VS Code terminal.
- **Mid-turn adjustments.** Send more text or images while a request is running; pending adjustments are delivered at the next safe model boundary.
- **Image input.** Paste screenshots or attach files to supported vision models using stable `[Image #N]` labels.
- **Durable Threads.** Resume conversations together with plans, task progress, approvals, child sessions, and execution environments.
- **Short- and long-term memory.** Keep active conversational context while retrieving compact project facts across sessions.
- **Task DAGs and child Agents.** Complex work can be divided into dependency-aware tasks and delegated to isolated child sessions.
- **Git Worktree isolation and Handoff.** Run selected child tasks in managed Worktrees, preserve checkpoints, and deliver results locally or to a branch.
- **Layered safety.** Structured tools, workspace confinement, command policy, approvals, an operating-system sandbox, and explicit Dangerous full access are separate controls.
- **Trusted Prompt Bundle.** System guidance and tool descriptions are installed as a versioned, integrity-checked per-user resource rather than mixed into source code.

## Requirements

- Node.js `>=20.11.0` and npm.
- Windows, macOS, or Linux.
- An API key for at least one supported provider.
- Git for Worktree isolation and branch Handoff. Git is optional for ordinary use and shared child sessions.
- Optional: VS Code `>=1.93` for native image paste, clickable Thinking entries, and scroll-safe interactive menus.

The protected command runner also depends on the platform sandbox:

| Platform | Sandbox support |
| --- | --- |
| Windows | Bundled Anthropic Sandbox Runtime backend; currently alpha and may require one elevated setup. |
| macOS | Uses the operating system Seatbelt sandbox. |
| Linux | Uses bubblewrap and requires `bubblewrap`, `socat`, and `ripgrep`, plus host support for unprivileged user namespaces. |

## Installation

Clone and install the project:

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm install
npm run build
npm install --global .
easy-code --version
```

Installation prepares the local memory resources, installs the verified Prompt Bundle under `~/.easy_code`, checks sandbox prerequisites, and attempts to install the bundled VS Code terminal extension. For a normal installation, do not use `--ignore-scripts`.

Check the sandbox after installation:

```bash
easy-code sandbox doctor
```

If setup is required:

```bash
easy-code sandbox setup
easy-code sandbox doctor
```

On Windows, setup may open a UAC confirmation. On Linux, EASY CODE only uses recognized package managers and fixed prerequisite packages; if administrator credentials are not already available non-interactively, it prints the command for you to run. macOS normally needs no additional package setup.

To run without a global installation:

```bash
npm install
npm run build
npm start -- --workspace /path/to/project
```

If the VS Code extension was not installed automatically:

```bash
npm run vscode:install
```

Set `EASY_CODE_SKIP_VSCODE_EXTENSION=1` before installation to skip the extension in CI or managed environments.

### Update

```bash
cd EASY_CODE
git pull
npm install
npm run build
npm install --global .
```

## Configure API keys

The recommended method stores keys in the operating-system credential store:

```bash
easy-code config set qwen.api-key
easy-code config set deepseek.api-key
easy-code config set glm.api-key
```

The command reads the key through hidden input. Do not append the secret to the command line.

Inspect or remove saved credentials:

```bash
easy-code config list
easy-code config get qwen.api-key
easy-code config unset qwen.api-key
```

Environment variables are also supported:

| Provider | Environment variables |
| --- | --- |
| Alibaba Qwen | `QWEN_API_KEY` or `DASHSCOPE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Zhipu GLM | `ZAI_API_KEY`, `GLM_API_KEY`, or `ZHIPUAI_API_KEY` |

If the selected provider has no key, interactive startup asks for one before the first request.

## Quick start

Open the project you want to work on and start EASY CODE:

```bash
cd /path/to/project
easy-code
```

At startup:

1. Select DeepSeek, Alibaba Qwen, or Zhipu GLM.
2. Select a model.
3. Select `none`, `low`, `medium`, or `high` thinking effort.
4. Use `Up`/`Down` and Enter to confirm.
5. Type a request in the composer and press Enter.

Example requests:

```text
Explain this project and identify its main entry points.
Fix the login error and run the relevant tests.
Add a settings page that follows the existing style.
Review the current changes for security and maintainability issues.
```

Start with explicit settings:

```bash
easy-code --workspace ./my-project --provider qwen --model qwen3.7-plus --thinking-effort high --mode code
```

Run one non-interactive task and exit:

```bash
easy-code --workspace ./my-project --mode code run "Fix the login error and run the tests"
```

If a non-interactive Auto run produces a reviewable Plan, start EASY CODE interactively and Resume that Thread to approve, revise, or reject it.

## Supported models

EASY CODE validates selections against its built-in provider catalog. Actual availability still depends on the provider account, region, and entitlement.

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

Switch the provider, model, and effort while a session is running:

```text
/model
/model <model-id>
/model qwen <model-id>
/provider deepseek
```

`/model` opens the Provider → Model → Thinking effort selector.

## Working modes

| Mode | Behavior |
| --- | --- |
| `plan` | Investigates the project and produces a structured proposal without changing project files. |
| `auto` | Lets the model answer directly, propose a plan, or enter Code mode. This is the default. |
| `code` | Implements and verifies the request immediately within the active safety controls. |

Switch modes with `/mode plan`, `/mode auto`, or `/mode code`.

Auto routing uses a restricted model decision rather than keyword matching. If Auto selects Plan, EASY CODE presents the proposal with three choices:

- Approve it and return to Auto for execution.
- Reject it.
- Enter feedback, including multiline pasted text, and ask the model to revise it.

## Thinking effort

Thinking effort is saved for every model selection. It is translated only when the selected model exposes a compatible reasoning control; unsupported models simply ignore the provider-side setting.

It also scales EASY CODE's local work budget and child-Agent concurrency:

| Effort | Relative work budget | Maximum active child Agents |
| --- | ---: | ---: |
| `none` | 1× | 2 |
| `low` | 1× | 2 |
| `medium` | 2× | 4 |
| `high` | 4× | 8 |

`none` requests disabled model thinking where the provider supports it. Provider-specific reasoning behavior may differ.

## Terminal interface

The interactive terminal is divided into stable regions:

| Region | Contents |
| --- | --- |
| Header | Mode, provider/model, effort, context estimate, workspace, and Thread ID. |
| Conversation | User input, model output, Thinking, tool activity, command output, and diffs in their real order. |
| Live activity | The current model request, command, or tool operation with elapsed time. |
| Composer and status | Editable request box, task and child-Agent summaries, and the compact session status line. |

Completed output remains normal terminal content, so it can be scrolled, selected, and copied. Temporary progress is updated in place instead of being printed repeatedly.

When a model returns Thinking content, the folded row shows a short gray preview. With the bundled VS Code extension, use `Ctrl+click` on Windows/Linux or `Cmd+click` on macOS to replace the preview with the complete body at the same conversation position. Click again to fold it. The composer remains usable while the disclosure is open.

You can also print retained reasoning with `/thinking [id|last]` or the latest block with `Ctrl+T`.

While a request is running, the composer accepts additional text and images. EASY CODE records each adjustment and delivers the pending FIFO batch at the next safe boundary. Adjustments can redirect the task, but they cannot change permissions, command policy, sandbox state, or task ownership.

## Files, commands, and approvals

In normal protected operation, file tools remain inside the selected workspace. Updates and deletions require a matching prior read, so an editor or another process changing the file causes a conflict instead of a silent overwrite.

Commands use a resolved executable, structured arguments, a bounded working directory, timeouts, and output limits. Use `/approval` to select the process-local command posture:

| Posture | Behavior |
| --- | --- |
| Manual approval | Ask before every policy-eligible higher-risk command. |
| Auto approval | Automatically approve eligible commands; permanent denials still apply. |
| Dangerous full access | After a second confirmation, remove command policy, approvals, the OS sandbox, and workspace-only filesystem restrictions for this process. |

Manual and Auto approval run accepted commands inside the operating-system workspace sandbox. Dangerous full access runs as the current OS user and can access the host filesystem, network, environment, and installed tools. EASY CODE displays a persistent red warning until you switch back or exit.

Per-command approval offers three choices: allow once, allow the same resolved executable for the current Thread, or reject. A Thread grant is restored by Resume but does not leak to other Threads.

## Images

Image input requires a model marked as vision-capable in the supported catalog.

| Platform | Native paste in the VS Code terminal |
| --- | --- |
| Windows | `Ctrl+V` |
| macOS | `Command+V` |
| Linux | `Ctrl+Shift+V` |

The bundled extension distinguishes image data from ordinary clipboard text. An accepted image appears as `[Image #N]`; multiline text appears as one paste block and is submitted only when you press Enter.

You can also attach images explicitly:

```text
/image ./screenshot.png
/image clipboard
/image clear
```

Or at startup:

```bash
easy-code --image ./one.png --image ./two.png
```

Images are copied into private Thread storage and validated before they reach the provider. Labels are unique within a Thread up to `Image #99`; provider and total-payload limits may be stricter.

## Tasks and child Agents

For complex work, the model can create a persistent task DAG. Each task contains dependencies, expected artifacts, completion checks, status, and evidence. A dependent task cannot start until its prerequisites complete.

The main Agent can complete tasks itself or create child Agents for DAG tasks or independent standalone work. Child Agents:

- receive a bounded assignment and private context rather than the parent's full conversation;
- start in Code mode with worker capabilities;
- cannot create additional child Agents or control the task graph;
- return a structured result and evidence to the parent;
- can receive follow-up instructions or be stopped by the parent.

Isolation can be shared or Worktree-based. In a Git project, `auto` prefers a managed Worktree; outside Git it uses the shared workspace. Explicit Worktree isolation fails rather than silently falling back when it cannot be created.

Managed Worktrees capture a defined starting snapshot. Completed child changes become result artifacts that can feed later DAG tasks. The parent can hand a selected result to the local checkout or to a branch. Conflicts are reported rather than overwritten.

Useful commands:

```text
/tasks
/agents
```

## Threads, context, and memory

Every conversation belongs to a durable Thread. Use:

```text
/sessions
/resume
/resume <thread-id>
/new
```

Resume restores the last recoverable state, including conversation history, accepted plans, unfinished tasks, Thread command grants, child assignments, and managed execution environments. Interrupted work is repaired into an explicit recoverable state instead of being silently replayed.

Short-term memory consists of the active messages plus a model-maintained working summary. As context pressure grows, EASY CODE first advises compression, then requires it, and finally inserts a forced compression request before the provider limit is reached.

Long-term memory stores short project facts such as decisions, conventions, environment notes, and user preferences. Retrieval combines lexical and semantic relevance. The model proposes additions, revisions, and removals; writes are committed only after a successful turn and are filtered for secrets and workspace scope.

Inspect memory and usage:

```text
/context
/memory short
/memory short 20
/memory long
/usage
```

## Project instructions and configuration

Place `EASYCODE.md` files in the project to describe architecture, commands, coding conventions, and validation expectations. Guidance is loaded from the configured user level and from the workspace hierarchy. It can guide the agent but cannot grant more authority than the Runtime allows.

User configuration is stored in the platform-specific EASY CODE config directory. A project may add `.easycode/config.toml` for safe workspace-level settings. Security-sensitive paths, credentials, and provider endpoints cannot be redirected by project configuration.

Example project configuration:

```toml
[limits]
max_steps = 40
max_context_chars = 400000

[subagents]
isolation = "auto" # auto, shared, or worktree

[worktrees]
base_mode = "current-snapshot" # fresh, head, or current-snapshot
max_managed = 15
```

`medium` doubles the configured none/low base limits and `high` multiplies them by four. See the [technical design](./docs/TECHNICAL_DESIGN.md) for configuration precedence and storage boundaries.

Prompt text and tool descriptions live in the fixed per-user Prompt Bundle. Inspect or repair it with:

```bash
easy-code prompts doctor
easy-code prompts list
easy-code prompts repair
```

## Command reference

### CLI

```text
easy-code [options]
easy-code [options] run <prompt...>
easy-code config set|get|unset|list ...
easy-code sandbox doctor|setup|repair-workspace ...
easy-code prompts doctor|list|repair
easy-code uninstall [--data-only]
```

Common options:

| Option | Purpose |
| --- | --- |
| `-w, --workspace <path>` | Select the workspace. |
| `--provider <name>` | Select `qwen`, `deepseek`, or `glm`. |
| `--model <id>` | Select a model from that provider. |
| `--mode <mode>` | Select `plan`, `auto`, or `code`. |
| `--thinking-effort <effort>` | Select `none`, `low`, `medium`, or `high`. |
| `--approval <policy>` | Set the startup command approval policy. |
| `-y, --yes` | Automatically accept policy-eligible command prompts. |
| `--resume <thread-id>` | Resume a saved Thread. |
| `-i, --image <path>` | Attach an image; repeat for more than one. |

### Interactive slash commands

| Area | Commands |
| --- | --- |
| Mode and model | `/mode`, `/provider`, `/model`, `/approval` |
| Workspace | `/workspace`, `/workspace refresh`, `/changes`, `/tools`, `/permissions`, `/commands` |
| Images and reasoning | `/image`, `/thinking`, `/adjustment` |
| Tasks | `/tasks`, `/agents` |
| Context and memory | `/context`, `/usage`, `/memory short [limit]`, `/memory long [id]` |
| Threads | `/sessions`, `/resume [id]`, `/new` |
| Interface | `/status`, `/clear`, `/help`, `/exit` |

Run `/help` inside EASY CODE for the exact current syntax.

## Troubleshooting

### API key missing or rejected

Run `easy-code config list`, verify the selected provider, and confirm that the account can access the selected model. Environment variables override the operating-system credential store.

### Command sandbox is unavailable

Run:

```bash
easy-code sandbox doctor
easy-code sandbox setup
easy-code sandbox doctor
```

The protected modes fail closed when sandbox initialization fails. They never fall back to unsandboxed execution. On Windows, workspace-specific ownership problems can be reviewed with `easy-code sandbox repair-workspace --target <path>` before applying any repair.

### Image paste does not work in VS Code

Reinstall the extension with `npm run vscode:install`, reload VS Code, and create a new terminal. Confirm that the active model supports images. Ordinary text on the clipboard remains text and should never become an image attachment.

### A command was refused

Use `/permissions` to inspect the current posture. A command may be blocked by Plan mode, permanent policy, workspace confinement, missing approval, or an unavailable sandbox. Only an explicit Dangerous full access confirmation removes those protections.

### Resume cannot find a Thread

Use `/sessions` to list the Threads available for the current workspace and local data directory. Resume IDs are exact.

## Uninstall

Use EASY CODE's uninstaller so prompts and memory are erased before the global package is removed:

```bash
easy-code uninstall
```

Close other EASY CODE processes first. The command removes the current OS user's `~/.easy_code` Prompt Bundle and discoverable short- and long-term memory, then uninstalls the global npm package. It fails closed if the memory database is active or a custom data root cannot be proven to belong to EASY CODE.

To erase prompts and memory while keeping the CLI installed:

```bash
easy-code uninstall --data-only
```

API keys, configuration, model caches, workspace files, Handoff branches, the VS Code extension, and managed Worktrees that may contain unmerged code are preserved. Modern npm does not invoke package uninstall hooks, so `npm uninstall --global easy-code-agent` alone cannot perform this data cleanup.

## License

EASY CODE's original source is released under the [MIT License](./LICENSE). Bundled and installed third-party software keeps its own license; see [Third-Party Notices](./THIRD_PARTY_NOTICES.md), including the Apache-2.0 notice for Anthropic Sandbox Runtime.
