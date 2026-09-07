# EASY CODE

English | [简体中文](./README_zh.md)

[Technical Design](./docs/TECHNICAL_DESIGN.md) | [SWE-bench Verified Mini Guide](./benchmarks/swebench_verified/README.md) | [Third-Party Notices](./THIRD_PARTY_NOTICES.md)

EASY CODE is a cross-platform CLI coding agent for Alibaba Qwen, DeepSeek, Zhipu GLM, and GLM Coding Plan. Run it in a project, describe the result you want, and let it inspect files, edit code, run commands, and verify the result.

## Features

- Interactive terminal UI and one-shot non-interactive runs.
- Plan, Auto, and Code working modes.
- File editing, command execution, tests, and reviewable diffs.
- Mid-turn text or image adjustments.
- Image input with supported vision models.
- Resumable Threads with context and project memory.
- Task planning and child Agents for larger jobs.
- Manual approval, auto approval, and sandboxed command execution.
- Optional Git Worktree isolation for child Agents.

For architecture, context compression and retrieval, persistence, security boundaries, and other implementation details, see the [Technical Design](./docs/TECHNICAL_DESIGN.md).

## Requirements

- Windows, macOS, or Linux.
- Node.js `>=20.11.0` and npm.
- An API key for at least one supported provider.
- Git if you want Worktree-isolated child Agents.
- Optional: VS Code `>=1.93` for native image paste and enhanced terminal interactions.

## Install

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm install
npm run build
npm install --global .
easy-code --version
```

Do not use `--ignore-scripts` for a normal installation.

To run from the source checkout without installing globally:

```bash
npm install
npm run build
npm start -- --workspace /path/to/project
```

## First-time setup

Save the API key for the provider you want to use:

```bash
easy-code config set qwen.api-key
easy-code config set deepseek.api-key
easy-code config set glm.api-key
easy-code config set glm-coding-plan.api-key
```

The command asks for the key using hidden input. Inspect or remove saved credentials with:

```bash
easy-code config list
easy-code config get qwen.api-key
easy-code config unset qwen.api-key
```

You can also use environment variables:

| Provider | Environment variable |
| --- | --- |
| Alibaba Qwen | `QWEN_API_KEY` or `DASHSCOPE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Zhipu GLM | `ZAI_API_KEY`, `GLM_API_KEY`, or `ZHIPUAI_API_KEY` |
| GLM Coding Plan | `GLM_CODING_PLAN_API_KEY` |

Zhipu GLM and GLM Coding Plan use separate credentials.

Check the command sandbox:

```bash
easy-code sandbox doctor
```

If setup is needed:

```bash
easy-code sandbox setup
easy-code sandbox doctor
```

On Windows, setup may request UAC approval. On Linux, follow any prerequisite command printed by `sandbox setup`.

## Start using EASY CODE

Open a project and start the interactive UI:

```bash
cd /path/to/project
easy-code
```

Choose a provider, model, and thinking effort, then enter a request. For example:

```text
Explain this project and identify its main entry points.
Fix the login error and run the relevant tests.
Add a settings page that follows the existing style.
Review the current changes for security issues.
```

Start with explicit settings:

```bash
easy-code --workspace ./my-project --provider qwen --model qwen3.7-plus --thinking-effort high --mode code
```

Run one task and exit:

```bash
easy-code --workspace ./my-project --mode code run "Fix the login error and run the tests"
```

Attach one or more startup images with `--image`:

```bash
easy-code --workspace ./my-project --image ./error.png
```

Run `easy-code --help` for all CLI options.

## Modes

| Mode | Use it when you want EASY CODE to... |
| --- | --- |
| `plan` | Inspect the project and propose a plan without changing project files. |
| `auto` | Decide whether to answer, propose a plan, or implement. This is the default. |
| `code` | Implement and verify the request immediately. |

Switch modes during a session:

```text
/mode plan
/mode auto
/mode code
```

When Auto produces a plan, approve it, reject it, or enter feedback to revise it. If this happens during a non-interactive run, resume that Thread interactively to review the plan.

## Command approval and sandbox

Protected command execution uses the workspace sandbox. The startup `--approval` option controls prompts:

| Value | Behavior |
| --- | --- |
| `safe` | Use the normal policy and ask for eligible higher-risk commands. This is the default. |
| `ask` | Ask before every policy-allowed command. |
| `never` | Refuse commands that require approval. |

Use `-y` to auto-approve policy-allowed prompts while keeping permanent denials and the sandbox active:

```bash
easy-code --workspace ./my-project --mode code -y
```

During an interactive session, run `/approval` to choose Manual approval, Auto approve, or Dangerous full access. Dangerous full access requires a second confirmation and removes the workspace sandbox and approval prompts for the current process.

Useful checks:

```text
/permissions
/commands
/changes
```

## Models and images

Use `/model` to choose a provider, model, and thinking effort. You can also switch directly:

```text
/model
/model <model-id>
/model qwen <model-id>
/provider deepseek
```

To attach images for the next request, select a vision-capable model and use:

```text
/image ./screenshot.png
/image clipboard
/image clear
```

In the VS Code terminal, native image paste uses `Ctrl+V` on Windows, `Command+V` on macOS, and `Ctrl+Shift+V` on Linux.

## Threads, tasks, and child Agents

Threads are saved automatically. List, resume, or start one with:

```text
/sessions
/resume
/resume <thread-id>
/new
```

You can also resume directly from the CLI:

```bash
easy-code --workspace ./my-project --resume <thread-id>
```

For larger work, ask EASY CODE to split the job into tasks and delegate independent parts to child Agents. Inspect progress with:

```text
/tasks
/agents
```

Example request:

```text
Split this migration into dependency-aware tasks, delegate independent work, and run the full test suite when everything is complete.
```

Add an `EASYCODE.md` file to your project when you want to provide project-specific commands, conventions, or validation instructions.

## Useful interactive commands

| Purpose | Commands |
| --- | --- |
| Mode and model | `/mode`, `/provider`, `/model`, `/approval` |
| Workspace and activity | `/workspace`, `/changes`, `/tools`, `/permissions`, `/commands` |
| Tasks | `/tasks`, `/agents` |
| Context and usage | `/context`, `/usage`, `/memory short [limit]`, `/memory long [id]` |
| Threads | `/sessions`, `/resume [id]`, `/new` |
| Interface | `/status`, `/thinking [id\|last]`, `/help`, `/exit` |

Run `/help` inside EASY CODE for the complete current command list.

## SWE-bench Verified Mini

The included 50-task benchmark requires Windows with Docker Desktop using Linux containers, Python 3.12+, and enough local Docker storage. Configure the GLM Coding Plan key, then run setup and diagnostics:

```powershell
easy-code config set glm-coding-plan.api-key
easy-code benchmark swe-bench setup
easy-code benchmark swe-bench doctor
```

Preview the command without spending API credits, then run one smoke task:

```powershell
easy-code benchmark swe-bench run --dry-run --limit 1 --run-id smoke
easy-code benchmark swe-bench run --limit 1 --run-id glm-coding-plan-5.3-flash-smoke
```

After the smoke task is graded successfully, run all 50 tasks explicitly:

```powershell
easy-code benchmark swe-bench run --limit 50 --concurrency 1 `
  --run-id glm-coding-plan-5.3-flash-verified-mini-50 --confirm-full-run
```

Read the [SWE-bench Verified Mini Guide](./benchmarks/swebench_verified/README.md) before running the benchmark or reporting results.

## Update and uninstall

Update a source installation:

```bash
git pull
npm install
npm run build
npm install --global .
```

Remove EASY CODE and its local prompts and memories:

```bash
easy-code uninstall
```

Keep the CLI but remove its prompts and memories:

```bash
easy-code uninstall --data-only
```

EASY CODE is released under the [MIT License](./LICENSE).
