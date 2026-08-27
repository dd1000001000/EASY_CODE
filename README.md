# EASY CODE

English | [简体中文](./README_zh.md)

EASY CODE is a local CLI coding agent for Alibaba Qwen and DeepSeek. It can read, create, update, and delete code inside a guarded workspace, run commands, manage context and memory, and send images to vision-capable models.

The current release is an MVP with a terminal-only interface. It does not open a separate desktop window.

## Requirements

- Windows, macOS, or Linux.
- Node.js `>=16.20.0` and npm. A currently maintained Node.js LTS release is recommended.
- An Alibaba Qwen or DeepSeek API key.
- Optional: VS Code `>=1.93` for native image-paste shortcuts in the integrated terminal.

EASY CODE uses SQLite WASM as the durable source of truth for threads and long-term memory, plus an embedded Orama vector index for semantic Top-K retrieval. A local multilingual embedding model runs through ONNX Runtime; no Python environment, external vector database, Redis, or model server is required.

## Installation

### Install globally from source

The package is not currently published to the npm registry. Install it from GitHub:

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm install
npm run build
npm install --global .
easy-code --version
```

You may use `git@github.com:dd1000001000/EASY_CODE.git` instead if your GitHub SSH key is configured.

After global installation, run `easy-code` from any project directory. The current directory becomes the default workspace.

To update or reinstall an existing clone:

```bash
git pull
npm install
npm run build
npm install --global .
```

To run without a global installation:

```bash
npm install
npm run build
npm start -- --workspace /path/to/project
```

A normal npm installation verifies SQLite, downloads the pinned quantized embedding assets (about 135 MB) into EASY CODE's per-user operating-system cache, checks their exact size and SHA-256, runs a real local ONNX/vector-search self-test, and then tries to install the bundled VS Code image-paste extension. Inference is offline after installation; memory text is not sent to Hugging Face.

Do not use `--ignore-scripts` for a normal installation, because it skips required model preparation. To repair or verify the local memory model from an EASY CODE source checkout, run:

```bash
npm run memory:install
npm run memory:verify
```

If a portable/custom VS Code installation was not detected, run:

```bash
npm run vscode:install
```

Set `EASY_CODE_SKIP_VSCODE_EXTENSION=1` to skip extension installation in CI or managed environments. To select a custom VS Code CLI, set `EASY_CODE_VSCODE_CLI` to its absolute path.

## Configure API keys

The recommended setup stores keys in the operating system credential store:

```bash
easy-code config set qwen.api-key
easy-code config set deepseek.api-key
easy-code config list
```

`config set` hides terminal input and does not accept a key as a command argument, keeping it out of shell history and process listings. You can inspect or remove configuration status without printing the secret:

```bash
easy-code config get qwen.api-key
easy-code config unset qwen.api-key
```

Environment variables are also supported:

| Provider | Environment variable |
| --- | --- |
| Alibaba Qwen | `QWEN_API_KEY` or `DASHSCOPE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

PowerShell:

```powershell
$env:QWEN_API_KEY = "your-api-key"
$env:DEEPSEEK_API_KEY = "your-api-key"
```

macOS/Linux:

```bash
export QWEN_API_KEY="your-api-key"
export DEEPSEEK_API_KEY="your-api-key"
```

During the first interactive launch, EASY CODE prompts for a missing key after you select a provider. It validates the input and credential-store round trip locally; provider access, region availability, and model entitlement are confirmed by the first API request.

Never put an API key in workspace configuration, `EASYCODE.md`, source code, chat messages, or Git history.

## Terminal usage

Enter the project you want EASY CODE to work on and start the agent:

```bash
cd /path/to/project
easy-code
```

EASY CODE stays in the current terminal instead of opening another agent window. A normal startup works as follows:

1. Select `DeepSeek` or `Alibaba Qwen`.
2. Select a model from that provider.
3. Move with the Up/Down arrow keys, press Enter to confirm, or Esc to cancel.
4. Enter a task at a prompt such as `EASY CODE [auto qwen/qwen3.7-max] >`.

`/help` is an in-agent command and only works after the EASY CODE prompt appears. To inspect CLI arguments from your shell, use:

```bash
easy-code --help
```

Start with an explicit workspace, provider, model, and mode:

```bash
easy-code --workspace ./my-project --provider qwen --model qwen3.7-plus --mode code
```

Run one non-interactive task and exit, which is useful for scripts and CI:

```bash
easy-code --workspace ./my-project --mode code run "Fix the login error and run the relevant tests"
```

Resume a saved thread:

```bash
easy-code --resume <thread-id>
```

Common top-level options:

| Option | Purpose |
| --- | --- |
| `-w, --workspace <path>` | Workspace root; defaults to the current directory |
| `--provider qwen\|deepseek` | Model provider |
| `--model <id>` | Model for the active provider |
| `--mode plan\|auto\|code` | Working mode; defaults to `auto` |
| `--approval safe\|ask\|never` | Command approval policy |
| `-y, --yes` | Automatically approve policy-allowed prompts |
| `--resume <thread-id>` | Resume a saved thread |
| `-i, --image <path>` | Attach an image to the first task; repeatable |

## Supported providers and models

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

This is EASY CODE's built-in model catalog, not live provider model discovery. Actual availability still depends on the provider service, account, region, and model entitlement. EASY CODE reports the provider's API error if a listed model is unavailable to the current account.

Switch providers or models while the agent is running:

```text
/model
/model <model-id>
/model qwen <model-id>
/model deepseek <model-id>
/provider qwen
/provider deepseek
```

`/model` opens the two-level Provider → Model selector again. EASY CODE asks for configuration if the selected provider has no API key.

## Working modes

| Mode | Behavior |
| --- | --- |
| `plan` | Read and investigate the workspace, then return a plan. File writes, builds, tests, and dependency installation are blocked. |
| `auto` | The agent decides whether the request needs a plan only or can be implemented and verified directly. |
| `code` | Implement and verify directly without first presenting a plan. Safety policies still apply. |

Switch modes during a session:

```text
/mode plan
/mode auto
/mode code
```

## Current features

### Agent tools

The model can use up to eight tools. `read_image` is exposed only to models explicitly marked as vision-capable.

| Tool | Capability |
| --- | --- |
| `read_file` | Read UTF-8 workspace files in bounded chunks |
| `read_image` | Validate and attach a workspace image to a vision model |
| `create_file` | Create a file without overwriting an existing target |
| `update_file` | Replace or remove exact text in a previously read file, with hash checks |
| `delete_file` | Delete the exact previously read file version, with path and hash checks |
| `run_command` | Run policy-controlled commands using structured `program + args[]` input |
| `compact_context` | Submit a cumulative summary and advance the context-compaction boundary |
| `manage_memory` | Search and stage automatic long-term-memory additions, revisions, or retirement |

`delete_file` requires the SHA-256 returned by `read_file`. It refuses unread files, stale hashes, directories, links, workspace escapes, and all deletions in Plan mode.

### Workspace and code changes

- File tools stay inside the workspace. Absolute paths, `..` traversal, and symlink or Windows junction escapes are rejected.
- `update_file` and `delete_file` check the SHA-256 recorded by the last read, preventing silent changes after an editor or another process modifies the file.
- Successful creates, updates, and deletions print a line-numbered diff: additions in green and removals in red.
- `/changes` shows the current thread's file changes.

### Commands and npm

- `run_command` uses structured arguments with `shell: false`. Shell syntax requires an explicit one-shot `cmd /c`, PowerShell `-Command`, or `sh -c` call.
- Commands are classified as `allow`, `ask`, or `deny`, with the invocation, working directory, result, and detected file changes recorded.
- Auto and Code modes permit restricted workspace-local npm installation. Agent-initiated installs disable dependency lifecycle scripts, audit, and fund.
- `--yes` automatically approves policy-allowed prompts, but cannot bypass Plan mode or hard-deny rules.

### Image input

In a VS Code integrated terminal with the bundled extension installed, use each platform's native paste shortcut:

- Windows: `Ctrl+V`
- Linux: `Ctrl+Shift+V`
- macOS: `Command+V`

Images appear in the input as `[Image #1]`, `[Image #2]`, and so on, with IDs increasing within the thread. Text clipboard data continues to use VS Code's normal paste behavior.

Other terminals may intercept paste shortcuts before they reach the CLI. Use these portable fallbacks:

```text
/image clipboard
/image ./path/to/screenshot.png
/image clear
```

You can also attach files with `--image <path>`. EASY CODE accepts complete, non-animated PNG, JPEG, WebP, and static GIF files, with at most five images per task. Only models marked “Yes” in the model table receive images. Qwen applies additional size and format limits and does not accept GIF.

Clipboard screenshots are copied to EASY CODE's private data directory outside the workspace. Thread journals and SQLite store controlled references and metadata, not image Base64.

### Context, memory, and threads

- Character, output, and image budgets bound each model request. The model can call `compact_context` to produce a cumulative working summary; a request-only hard-limit fallback remains available.
- Short-term memory belongs to the current thread and includes conversation, tool results, file versions, change sets, and the working summary.
- Long-term memory is isolated by workspace. The model uses `manage_memory` to search, remember, revise, or retire durable preferences, conventions, decisions, verified architecture, and stable environment facts.
- Long-term retrieval is hybrid: 384-dimensional semantic similarity and FTS5 lexical matches are reranked together. SQLite persists both memory rows and Float32 embeddings; Orama is a disposable, generation-versioned in-process Top-K index.
- Embeddings are produced locally by the pinned [`Xenova/paraphrase-multilingual-MiniLM-L12-v2`](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2) quantized model. Existing memories from older database versions are backfilled automatically on first retrieval.
- Memory mutations are staged during a turn and committed atomically only after `success` or `planned`; failed, interrupted, and step-limited turns discard them. Revisions preserve superseded rows, while forgetting marks a row expired instead of physically deleting its audit history.
- Memory remains automatic. Users can inspect it with `/memory short` and `/memory long`, but there is no user command for adding, editing, or deleting it.
- Append-only JSONL stores original thread events; SQLite WASM/FTS5 stores searchable projections, long-term memory, and persistent vectors. Threads can be listed and resumed.
- Cross-process locks and thread leases prevent two EASY CODE processes from resuming the same thread concurrently.

### System prompt and project instructions

Every model call rebuilds the system prompt with current local and UTC time, IANA time zone, system language and locale, OS, CPU architecture, shell, current directory, workspace, mode, provider, and model.

EASY CODE reads `EASYCODE.md` from the user configuration directory and from the workspace-root-to-current-directory hierarchy. These files can describe build commands, code style, and project conventions, but cannot grant additional permissions.

## Interactive commands

```text
/mode plan|auto|code       Switch working mode
/provider qwen|deepseek    Switch provider
/model                     Open provider and model selectors
/model <model>             Switch model for the current provider
/model <provider> <model>  Switch provider and model
/status                    Show current status
/workspace                 Show workspace summary
/workspace refresh         Refresh the workspace inventory
/image <path>              Attach an image to the next task
/image clipboard           Read an image from the clipboard
/image clear               Clear pending images
/changes                   Show file changes in the current thread
/tools                     Show currently available tools
/permissions               Show command permissions and sandbox status
/commands                  Show recent commands
/context                   Show context-budget usage
/memory short              Show automatic short-term memory
/memory long               List automatic long-term memories
/memory long <id>          Show one long-term memory
/sessions                  List saved threads
/resume <id>               Resume a thread
/new                       Start a new thread
/clear                     Clear the screen
/help                      Show help
/exit                      Save and exit
```

## Security boundaries

EASY CODE provides workspace path guards, command classification, approvals, environment filtering, and audit records, but it does not currently provide an operating-system-level process sandbox.

- File tools are constrained to the workspace.
- An approved command still runs with the permissions of the operating-system user who started EASY CODE, and may access the network or resources outside the workspace.
- Explicit shells can execute complex commands. Use `--yes` only in trusted workspaces, containers, virtual machines, or low-privilege environments.
- `--yes` does not bypass Plan mode or hard-deny rules.
- For untrusted repositories, commit or back up existing work and keep interactive approvals enabled.

## Troubleshooting

- `easy-code` is not found: ensure npm's global binary directory is on `PATH`, or use `npx easy-code` for a local dependency.
- Missing API key, 401, or 403: run `easy-code config list` and verify that the provider, key, account, and region match.
- Image shortcut does nothing: confirm that `dd1000001000.easy-code-image-paste` is installed. If needed, run `npm run vscode:install`, then VS Code's `Developer: Reload Window`. `/image clipboard` is the fallback.
- Semantic memory falls back to lexical search: reinstall without `--ignore-scripts`, or run `npm run memory:install` followed by `npm run memory:verify` from the EASY CODE source checkout.
- A command is denied: run `/permissions` to inspect the mode and approval policy. Plan mode blocks writes and builds. Use `--yes` only when unattended approval is intended; hard-deny rules still apply.
- Node.js is too old: run `node --version`. The minimum is `16.20.0`; rerun `npm install` after changing Node.js versions.

## Development checks

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```
