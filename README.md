# EASY CODE

English | [简体中文](./README_zh.md)

EASY CODE is a local coding agent with terminal and browser interfaces. Its bundled model registry includes Qwen, DeepSeek, Kimi K3, Zhipu GLM and GLM Coding Plan, and you can add other OpenAI-compatible providers without changing the source code. Open a project and describe a task to inspect code, edit files, run commands and verify changes.

## Features

- Auto / Plan / Code modes, with terminal/browser sessions and one-shot tasks.
- File editing, command approval, test verification and diff display.
- Saved sessions, Resume, context management, and global user/project memory.
- Reusable user and project Skills that the agent can discover, read and maintain.
- Optional DAG / child-agent collaboration, vision-model image input and VS Code terminal integration.

## Install

Requires Node.js **>=20.11.0**, npm and an API key for a supported provider. Runs on Windows, macOS and Linux; Worktree isolation requires Git.

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm ci --ignore-scripts
npm run build
npm install --global --allow-scripts=easy-code-agent .
```

The final global install prepares local retrieval and integrations, and resolves the latest `@openai/codex` native sandbox runtime available at installation time. Windows performs a one-time elevated setup for a dedicated offline identity; macOS uses Seatbelt; Linux uses bubblewrap/seccomp. EASY CODE does not install a VM or container engine for normal CLI commands.

## Get started

Configure only the provider you intend to use. The command prompts for the key with hidden input:

```bash
easy-code config set qwen.api-key
# Alternatives: deepseek.api-key, kimi.api-key, glm.api-key, glm-coding-plan.api-key
easy-code --workspace /path/to/project
```

To use the local browser interface instead (bound only to `127.0.0.1`; stop it from its launching terminal):

```bash
easy-code --web --workspace /path/to/project
easy-code --web --workspace /path/to/project --resume <thread-id>
```

The browser interface supports session switching, images, in-flight adjustments, stopping tasks, plan review and tool approvals. Model, MCP and Skill menus are available from the sidebar. Installation, uninstall and Benchmark administration remain terminal commands.

The first installation creates `~/.easy_code/models.toml`. Edit that file to maintain provider endpoints, wire protocol (`chat_completions` or `responses`), endpoint streaming and `tool_stream` support, model IDs, context windows, vision/tool/reasoning capabilities and the benchmark profile. EASY CODE validates it at startup and never overwrites an existing copy. Provider API keys are stored only in the OS credential store, bound to their provider endpoint; environment variables and TOML are not key sources. Benchmark keys use a separate credential-store namespace and are set with `easy-code benchmark credential set <provider>`.

Select a model, then describe a task, such as “Fix the login error and run the relevant tests.”

The sandbox is checked during installation. Interactive startup also attempts the one-time Windows setup when needed; failures open a recovery menu without an installation loop. Check or resume it with:

```bash
easy-code sandbox doctor
easy-code sandbox setup
easy-code sandbox recover --workspace /path/to/project
```

Normal commands run against the current project under the platform sandbox: workspace writes are allowed, writes outside it are denied and direct external networking is blocked. Approved HTTP(S) downloads use the Runtime network gate. Full access explicitly bypasses the sandbox; Benchmark remains confined to its offline Harbor/Docker container. There is no silent host fallback.

Run one task or resume a session:

```bash
easy-code --workspace /path/to/project --mode code -y run "Fix and verify the login error"
easy-code --workspace /path/to/project --resume <thread-id>
```

`auto` selects how to handle the task; `plan` focuses on investigation and proposals but is **not enforced read-only**; `code` implements directly.

Use `/approval` to select Manual, Approve for me or Full access. `-y` enables an independent approval agent, not blanket approval. **Full access removes the sandbox and per-command approval for normal CLI commands; use it only in a trusted environment.**

## Common commands

| Command | Purpose |
| --- | --- |
| `/model`, `/mode` | Change model or working mode |
| `/approval`, `/permissions` | Change approval mode; inspect and revoke grants |
| `/orchestration`, `/tasks`, `/agents` | Enable and inspect DAG / child agents |
| `/sessions`, `/resume`, `/new` | List, resume or create sessions |
| `/image ./screenshot.png` | Attach an image for a vision-capable model |
| `/mcp` | View, authenticate, connect, disconnect or remove MCP servers |
| `/skills` | List user and project Skills |
| `/context`, `/usage`, `/help` | Inspect context, usage and full help |

Ask the agent to create, update or remove a Skill, or place one manually at `~/.easy_code_skills/<name>/SKILL.md` (user-wide) or `<project root>/.easy_code_skills/<name>/SKILL.md` (shared by sessions in that project). Each `SKILL.md` needs YAML `name` and `description` fields followed by instructions; optional `references/`, `assets/` and `scripts/` can hold supporting materials. `/skills` lists both locations. Skill changes made by the agent use tool approval; deleting a Skill archives it for recovery.

Ask the agent to add or update an MCP server, then use `/mcp` to approve and connect it. Server configuration is stored in `~/.easy_code/mcp.toml`. Local servers use stdio and run inside the workspace sandbox, with direct network access disabled. Remote servers support Streamable HTTP or legacy SSE; they require HTTPS (or loopback HTTP) and can use an environment-variable bearer token or interactive OAuth sign-in. OAuth opens the authorization link automatically; press Ctrl+C to cancel while waiting. Credentials are stored in the operating system's credential store, not in the config file. Each MCP tool call asks for approval.

Put project conventions and validation commands in `EASYCODE.md`. Adjust operational budgets in the `[limits]` table of `.easycode/config.toml`; run `easy-code config defaults` to inspect defaults.

Installation and startup do not change Docker, Podman or WSL configuration. Restart existing CLI sessions after updating installation code.

## Uninstall

~~~sh
easy-code uninstall --dry-run
easy-code uninstall
~~~

Uninstall asks once: enter `y` to remove current-user configuration, ordinary and Benchmark API-key entries, history/memory, caches, terminal integration, managed Worktrees and the global CLI. `--yes` confirms the same plan without prompts; `--dry-run` shows every target. User projects, linked source checkouts, Benchmark projects and shared system software are preserved. On Windows, the upstream native sandbox accounts are shared OS infrastructure and are not owned or removed by EASY CODE.

More: [Configuration example](./docs/config.example.toml) · [Architecture and module documentation](./docs/TECHNICAL_DESIGN.md) · [Benchmark guide](./benchmarks/swebench_verified/README.md)

[MIT License](./LICENSE) · [Third-party notices](./THIRD_PARTY_NOTICES.md)
