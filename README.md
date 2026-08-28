# EASY CODE

English | [简体中文](./README_zh.md)

EASY CODE is a local CLI coding agent for Alibaba Qwen, DeepSeek, and Zhipu GLM. Start it inside a project directory, describe the result you want, and let it inspect files, edit code, run commands, verify changes, manage context, and resume previous work.

EASY CODE runs entirely in the current terminal. It does not open a separate desktop window.

## Features

- Three working modes: Plan, Auto, and Code.
- Read, create, update, and delete files inside the selected workspace.
- Run commands, tests, build tools, and supported npm installation commands.
- Show line-numbered code diffs with green additions and red removals.
- Switch providers, models, and thinking effort while the session is running.
- Attach screenshots and image files to supported vision models.
- Automatically manage short-term context and long-term project memory.
- Save and resume conversations, plans, task progress, and child-agent results.
- Optionally organize complex work as a task DAG.
- Optionally delegate independent work to isolated child agents.
- Load project instructions from `EASYCODE.md` files.
- Work on Windows, macOS, and Linux.

## Requirements

- Node.js `>=16.20.0` and npm.
- Windows, macOS, or Linux.
- An API key for at least one supported provider.
- Optional: VS Code `>=1.93` for native image paste in the integrated terminal.

A maintained Node.js LTS release is recommended.

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
5. Enter your request at the `EASY CODE [...] >` prompt.

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
| `auto` | You want the model to decide whether the request needs a reviewed plan or can be implemented directly. This is the default. |
| `code` | You want EASY CODE to implement and verify the request immediately without presenting a plan first. |

Switch modes at any time:

```text
/mode plan
/mode auto
/mode code
```

When Auto chooses Plan, EASY CODE shows the proposal and offers three choices:

```text
1. Yes, use Auto mode
2. No, reject plan
3. Type feedback and press Enter to adjust the plan
```

Approving returns to Auto and executes the accepted plan. Rejecting stops it. Entering feedback asks the model to revise the proposal.

## Thinking effort

Thinking effort affects model reasoning when the selected model supports it. It also controls the default task budget and maximum number of concurrently active child agents.

| Effort | Default maximum steps | Default context size | Child-agent limit |
| --- | ---: | ---: | ---: |
| `none` | 40 | 400,000 characters | 2 |
| `low` | 40 | 400,000 characters | 2 |
| `medium` | 80 | 800,000 characters | 4 |
| `high` | 160 | 1,600,000 characters | 8 |

`none` requests no model thinking where the provider supports disabling it. If a model does not support configurable thinking, the selected effort is still saved, but the thinking setting itself may not affect that model.

When a model returns thinking content, EASY CODE shows a gray `Thinking #N` marker and a short gray preview. Use one of the following to view the expanded content:

```text
/thinking
/thinking <id>
/thinking last
```

You can also press `Ctrl+T` in the interactive terminal.

Optional base limits can be configured in user configuration or `.easycode/config.toml`:

```toml
[limits]
max_steps = 40
max_context_chars = 400000
```

`medium` uses twice these base values and `high` uses four times these base values.

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
```

EASY CODE stays inside the selected workspace for file operations. Commands still run with the permissions of the operating-system user who started the process.

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

Use these commands to inspect them:

```text
/agents
/subagents
/status
```

The active child-agent limit is 2 for `none`/`low`, 4 for `medium`, and 8 for `high`. While child work is still running or waiting to be collected, Auto stays in Code mode so the parent can finish collecting the results.

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
- The prompt displays an approximate context Token count such as `context:12.4k`.

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
/resume <thread-id>
```

Resume restores as much saved state as possible, including the selected model and mode, conversation, accepted plan, task progress, file/command history, context summary, and completed child-agent results. Interrupted commands or model calls are not automatically repeated.

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
/commands                  Show recent commands
/context                   Show context usage
/memory short [limit]      Show recent short-term memory previews (default 8, max 500)
/memory long [id]          Show long-term memory
/thinking [id|last]        Show model thinking
/sessions                  List saved threads
/resume <id>               Resume a thread
/new                       Start a new thread
/clear                     Clear the terminal
/help                      Show help
/exit                      Save and exit
```

## Safety notes

- Review or commit important work before letting an agent make broad changes.
- Use `/permissions` to inspect the active command policy.
- `--yes` should be used only in trusted workspaces or isolated environments.
- `--yes` does not bypass Plan mode restrictions or commands that are always denied.
- A permitted command runs with your current operating-system account and may access resources outside the workspace.
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

### Node.js is too old

Check the version:

```bash
node --version
```

EASY CODE requires Node.js `>=16.20.0`.
