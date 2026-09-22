# EASY CODE

![EASY CODE — local coding agent for terminal and browser](./docs/assets/easy-code-banner.png)

English | [简体中文](./README_zh.md)

EASY CODE is a local coding agent for your projects, available in the terminal and browser. Describe a task to explore code, edit files, run commands and check results. Use your own provider account; the bundled model registry includes Qwen, DeepSeek, Kimi, Zhipu GLM and GLM Coding Plan.

## Features

- **Terminal and Web interfaces:** saved conversations, multi-folder projects, image input, stopping tasks and in-flight adjustments.
- **Flexible models:** switch providers, models and thinking effort within a conversation; new conversations reuse your last selection unless explicitly overridden.
- **Auto, Plan and Code modes:** answer questions, investigate an approach or implement changes.
- **Controlled execution:** command approvals, native OS sandboxing, file-change checks and supervised long-running commands.
- **Optional collaboration:** dependency-based tasks (DAGs), parallel child agents and independent review when repeated verification failures need investigation.
- **Persistent context:** conversation recovery, context compaction, historical recall and global/project memory.
- **Extensible capabilities:** global/project Skills, local or remote MCP servers and VS Code terminal integration.
- **English and Simplified Chinese:** a shared, saved interface-language preference.

“Local” describes where the application, tools and stored history run. Selected model providers still receive the request context needed to perform tasks.

## Install

Requires Node.js **20.11.0 or newer**, npm and a supported provider API key. Windows, macOS and Linux are supported targets; Git is required for Git worktree isolation. Sandbox availability also depends on the OS and architecture.

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm ci --ignore-scripts
npm run build
npm install --global --allow-scripts=easy-code-agent .
```

The global installation prepares retrieval and integration resources; allow the package's installation scripts to run. The native sandbox uses the runtime version pinned by the project, not an automatically selected latest release. Windows sandbox setup may require administrator confirmation. Normal CLI/Web use does not require a VM or container engine.

## Quick start

### Configure a provider

This command asks for the API key using hidden input:

```bash
easy-code config set qwen.api-key
```

Other bundled credential names are `deepseek.api-key`, `kimi.api-key`, `glm.api-key` and `glm-coding-plan.api-key`. Configure the provider you intend to use. Model-provider keys are stored in the OS credential store, not in TOML or environment variables.

### Open Web or CLI

```bash
# Browser interface
easy-code --web

# Interactive terminal; this creates a project with the folder attached
easy-code --workspace "/path/to/project"
```

Replace the example path with your local folder, and quote paths containing spaces. The Web service listens on local loopback only; keep its launching terminal open and stop the service there when finished.

A fresh Web installation has no default project. Create an empty project from the **Projects** heading, expand it, and attach one or more local folders. The project becomes usable after its first folder is attached; then use the **＋** beside it to create a conversation. A folder cannot be attached twice or overlap an ancestor/descendant folder already in the same project. CLI startup creates a new project and attaches the selected working directory as its first folder.

### Select a model and start a task

In Web, use the model control below the input. In CLI, enter `/model` to open the selector. Then describe a task, for example:

> Find the cause of the login failure, fix it, and run the relevant tests.

For a single terminal task or an existing conversation:

```bash
easy-code --workspace "/path/to/project" --mode code -y run "Fix the login failure and run the relevant tests"
easy-code --workspace "/path/to/project" --resume <thread-id>
```

Interactive CLI and Web tasks do not have a fixed model-request count limit. For an unattended one-shot run, add `--max-model-requests N` after `run` to cap the aggregate requests made by the main agent, child agents, reviewer, approvals, and context compaction.

`-y` selects the independent command-approval agent. It does **not** grant unrestricted host access or guarantee that no user decision will be needed.

## Using the Web interface

| Area | How to use it |
| --- | --- |
| Projects | Create an empty project, then use its edit action to rename it, add or remove folders, or choose the primary folder. The sidebar shows only projects and their conversations. Folder membership cannot change while that project's work is active. Hover over or select a ready project to reveal its new-conversation action. Collapse the sidebar with its top button; click the logo to expand it. |
| Input | **Enter** sends; **Shift+Enter** inserts a newline. Sending requires an open conversation. The shortcuts apply on Windows, macOS and Linux; IME composition is not submitted as a message. |
| Attachments | Paste or upload images for removable previews. Long pasted text appears as a preview card while retaining the full submitted text. Images require a vision-capable model. |
| Running tasks | An empty draft shows the stop action. Entering text changes it to send an adjustment for a later safe execution boundary. Other projects and conversations remain accessible and can run in parallel. |
| Model and permissions | Below the input, choose model/thinking effort, approval mode and DAG/agent orchestration. Changes that are unsafe during active work are disabled or rejected. |
| Commands | Type `/` or a prefix for matching entries with descriptions. Click an entry to open its UI above the input, or type and send a supported command. Click outside a panel to dismiss it. |
| Reading progress | Thinking and tool entries show a one-line preview and character count. Expand for details such as command text, file names or task/agent names. The compact navigation rail jumps between user messages. |
| Status | The header shows conversation and runtime information. An upper-right card shows active DAG, child-agent and reviewer activity. Notices close after 15 seconds or can be dismissed manually. |
| Language | Use the upper-right language selector. It shares the CLI preference; existing messages and model responses are not translated. |

Each conversation belongs to exactly one project and can receive a custom title **once**, from either the user or the main agent. After that, it cannot be renamed again. Project display names can be changed without renaming any attached directory. Every turn captures the active folder-membership revision, and folders cannot be changed during a running turn.

Deleting a conversation removes its saved history, associated child conversations and memory contributions; shared memories may be restored to an earlier revision. Removing a project also removes its conversations, project memory, project Skills and project-owned runtime metadata. **Neither deleting a project nor detaching a folder deletes source files.** Stop active work before deletion and read the confirmation carefully.

Parallel conversations in one project share all of its attached folders and sandbox boundary. Avoid assigning conflicting edits to the same files; parallel execution does not imply a separate checkout for every conversation. In multi-folder projects, file paths begin with a stable folder key such as `api/src/main.ts`; `.` in a command means the primary folder.

## Modes, approvals and models

| Setting | Meaning |
| --- | --- |
| Auto | Chooses how to handle the request: answer, plan or implement. |
| Plan | Focuses on investigation and proposals. **It is not enforced read-only.** |
| Code | Works directly on implementation and verification. |
| Manual approval | Asks you to approve commands unless a relevant saved grant applies. |
| Approval agent | Independently evaluates commands; rejected or undecidable requests may still require your approval. |
| Full access | Removes normal host command sandboxing and individual command approvals. Commands run with your account privileges. |

Use Full access only for trusted tasks and environments. Normal sandboxed commands can write within every folder attached to the project; outside writes and direct external networking are restricted. A thread-level service session keeps later commands in the same supervised Linux sandbox so local frontend/backend probes can share localhost. Approved HTTP(S) activity uses a separate network approval path. Sandbox failure never silently enables Full access.

DAG/child-agent orchestration is off by default and requires an approval mode other than Manual. Enabling it from Manual asks before changing approval mode. Disabling orchestration does not disable the independent reviewer. Children can receive a thinking effort no higher than the main agent's.

The model registry is `~/.easy_code/models.toml`. First startup creates it from the [bundled registry](./resources/models.default.toml); later starts do not overwrite it. Use it to maintain compatible providers, model IDs and capabilities. Restart EASY CODE after editing the registry.

Thinking effort affects EASY CODE's local execution budgets and, where supported, the provider's reasoning setting. **“Saved, not applied” means the selected effort is not being sent as a provider reasoning parameter**, not that the selection was discarded. Provider support depends on the model and protocol; image support likewise depends on the selected model's capabilities.

## Commands

These typed commands are available in both CLI and Web. Web also offers panels for these actions.

| Command | Purpose |
| --- | --- |
| `/mode plan\|auto\|code` | Change working mode. |
| `/status` | Inspect conversation and runtime state. |
| `/workspace list\|refresh\|add <path>\|remove <folder-id>\|primary <folder-id>` | Inspect, refresh or change the current project's folders. Folder changes require the thread to be idle. |
| `/tools` | Browse currently available tools. |
| `/skills` | List global and project Skills. |
| `/mcp [server-id action]` | Manage MCP connections and authorization; the menu lists available actions. |
| `/permissions [revoke <index>]` | Inspect permissions/sandbox status or revoke a saved grant. |
| `/context`, `/usage` | Inspect context capacity or provider-reported token usage. |
| `/memory short [limit]` | Inspect recent conversation previews. |
| `/memory long [global\|project] [id]` | Inspect long-term memory by scope or ID. |
| `/help` | Show command help. |

`/language [en_us|zh_cn]` shows or changes the shared language preference in either interface. In Web, the upper-right selector is the usual entry point.

The following typed commands are **CLI-only**; Web uses the UI alternatives listed here:

| CLI command | Purpose / Web alternative |
| --- | --- |
| `/model` | Model and thinking-effort selector below the Web input. CLI also accepts `/model <model-id>` or `/model <provider> <model-id> [none\|low\|medium\|high]`. |
| `/provider <provider-id>` | Switch provider; use the Web model selector. |
| `/approval [manual\|auto_approve\|unrestricted]` | Approval control below the Web input. |
| `/orchestration [on\|off]` | DAG/agent control beside the Web approval control. |
| `/image <path\|clipboard\|clear>` | Web upload/paste and removable attachment previews. |
| `/sessions`, `/resume [id]`, `/new` | Web project/conversation sidebar and the project's **＋** action. |
| `/workspace list\|refresh\|add <path>\|remove <folder-id>\|primary <folder-id>` | CLI-only project-folder management; use the Web project's edit dialog instead. |
| `/clear` | Clears terminal display only; no Web equivalent. Does not delete history. |
| `/exit` | Saves and exits CLI; stop the Web server from its launching terminal. |

There are no command aliases. Unknown slash-prefixed text is ordinary input, not a supported command; recognized CLI-only commands are rejected when typed in Web.

## Skills, MCP and memory

**Skills** hold reusable instructions and resources. EASY CODE stores global Skills under its application data and project Skills under the logical project's owned data, rather than inside an attached source folder. Each `SKILL.md` needs YAML `name` and `description` fields followed by instructions; supporting references, assets and scripts can live alongside it. Use `/skills` to inspect them, or ask the agent to create or update a Skill. Agent-managed changes require approval; deletion archives the Skill. Deleting a project deletes its project Skills, while global Skills remain available to other projects.

**MCP** connects additional tools. Ask the agent to add or edit a server in `~/.easy_code/mcp.toml`, then use `/mcp` to authorize and connect it. Editing configuration alone does not connect a server. Local stdio servers run in the workspace sandbox; remote servers support HTTP/SSE connections and configured bearer authentication or OAuth. Remote URLs require HTTPS except for loopback HTTP. MCP calls require approval; server descriptions do not grant permissions.

**Memory** is separate from Skills and conversation history. Global memory carries preferences across projects; project memory retains relevant project knowledge. The agent can save useful information; `/memory` lets you inspect it, but manual changes to long-term memory are not supported in CLI or Web. Context compaction makes room for longer work, but summaries and recalled memories do not replace checking current files. Background memory consolidation may make additional model requests and consume tokens.

## Configuration and troubleshooting

Put project conventions and validation instructions in `EASYCODE.md` in the primary folder. Project configuration uses the primary folder's `.easycode/config.toml`; see the [configuration example](./docs/config.example.toml). `easy-code config defaults` displays defaults. Keep API keys out of project files.

```bash
easy-code install doctor
easy-code sandbox doctor
easy-code sandbox setup
easy-code sandbox recover --workspace "/path/to/project"
```

The install check helps locate conflicting global launchers; sandbox commands inspect, prepare or reconcile execution state. Installation and startup do not reconfigure Docker, Podman or WSL. Restart existing processes after updating EASY CODE. This development version does not promise compatibility with older internal data formats or changed prompt bundles; back up important data before upgrading.

## Development and evaluation

```bash
npm run build
npm run typecheck
npm test
```

See the [technical design](./docs/TECHNICAL_DESIGN.md) for architecture and design boundaries. SWE-bench setup and execution are covered in the [benchmark guide](./benchmarks/swebench_verified/README.md). Benchmark credentials are separate from interactive credentials: configure them with `easy-code benchmark credential set <provider>`.

## Uninstall

```bash
easy-code uninstall --dry-run
easy-code uninstall
```

Review the dry run first. After confirmation, uninstall removes installation-owned configuration, credentials, history, memory, caches, integration resources, managed worktrees and the global CLI. `--yes` confirms the same operation without a prompt. **There is no undo without a backup.**

User project folders, linked source checkouts and shared system software are preserved. Shared Windows sandbox accounts are not removed. Unknown or unsafe resources block removal or are preserved rather than deleted speculatively; inspect the reported notices.

[MIT License](./LICENSE) · [Third-party notices](./THIRD_PARTY_NOTICES.md)
