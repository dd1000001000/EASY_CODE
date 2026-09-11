# EASY CODE

English | [简体中文](./README_zh.md)

EASY CODE is a local CLI coding agent. Its bundled model registry includes Qwen, DeepSeek, Kimi K3, Zhipu GLM and GLM Coding Plan, and you can add other OpenAI-compatible providers without changing the source code. Open a project and describe a task to inspect code, edit files, run commands and verify changes.

## Features

- Auto / Plan / Code modes, with interactive sessions and one-shot tasks.
- File editing, command approval, test verification and diff display.
- Saved sessions, Resume, context management and project memory.
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

The final global install prepares the local retrieval model and integration resources and may download assets. If npm reports an existing `easy-code` launcher, run `npm run install:doctor`, uninstall the copies reported for the old npm prefixes, and reinstall without `--force`.

## Get started

Configure only the provider you intend to use. The command prompts for the key with hidden input:

```bash
easy-code config set qwen.api-key
# Alternatives: deepseek.api-key, kimi.api-key, glm.api-key, glm-coding-plan.api-key
easy-code --workspace /path/to/project
```

The first installation creates `~/.easy_code/models.toml`. Edit that file to maintain provider endpoints, credential environment-variable names, wire protocol (`chat_completions` or `responses`), model IDs, context windows, vision/tool/reasoning capabilities and the benchmark profile. EASY CODE validates it at startup and never overwrites an existing copy. API keys remain in the OS credential store or the configured environment variable; do not put them in `models.toml`.

Select a model, then describe a task, such as “Fix the login error and run the relevant tests.”

Protected commands need a working sandbox. Inspect it and initialize it if requested:

```bash
easy-code sandbox doctor
easy-code sandbox setup
```

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
| `/context`, `/usage`, `/help` | Inspect context, usage and full help |

Put project conventions and validation commands in `EASYCODE.md`. Adjust operational budgets in the `[limits]` table of `.easycode/config.toml`; run `easy-code config defaults` to inspect defaults.

More: [Configuration example](./docs/config.example.toml) · [Architecture and module documentation](./docs/TECHNICAL_DESIGN.md) · [Benchmark guide](./benchmarks/swebench_verified/README.md)

[MIT License](./LICENSE) · [Third-party notices](./THIRD_PARTY_NOTICES.md)
