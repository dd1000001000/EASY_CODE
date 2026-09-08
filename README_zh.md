# EASY CODE

[English](./README.md) | 简体中文

[技术设计](./docs/TECHNICAL_DESIGN_ZH.md) | [English Technical Design](./docs/TECHNICAL_DESIGN.md) | [SWE-bench Verified Mini 指南](./benchmarks/swebench_verified/README.md) | [第三方开源声明](./THIRD_PARTY_NOTICES.md)

EASY CODE 是一个跨平台 CLI 编程 Agent。进入项目目录后，用自然语言描述目标，它可以检查代码、修改文件、执行命令、运行测试，并在之后继续未完成的工作。

本文只介绍功能和使用方法。架构、安全边界、上下文压缩、检索与记忆、子 Agent 隔离等实现细节，请参阅[技术设计](./docs/TECHNICAL_DESIGN_ZH.md)。

## 功能

- 支持 Alibaba Qwen、DeepSeek、智谱 GLM 和 GLM Coding Plan。
- 提供 `plan`、`auto`、`code` 三种工作模式。
- 可读取和修改文件、执行命令、运行构建与测试，并显示 Diff。
- 支持在任务执行中继续发送文字或图片来调整方向。
- 支持图片输入、Thinking 展示，以及 VS Code 终端增强。
- 自动保存 Thread，可恢复对话、Plan、任务和子 Agent 工作。
- 可把复杂目标拆成任务，并交给共享工作区或 Git Worktree 中的子 Agent。
- 提供命令审批与强制工作区沙箱：手动模式审批所有联网；自动模式放行明确只读联网，下载/上传/未知联网仍审批；危险模式免所有命令与联网审批。支持 Thread 联网前缀授权，`/permissions` 查看、`/permissions revoke <序号>` 撤销。Plan 始终只读，Benchmark 命令仍禁网。详见[命令安全说明](docs/COMMAND_SECURITY_ZH.md)。
- 保存项目上下文与记忆，并提供用量查看命令。

## 环境要求

- Node.js `>=20.11.0` 和 npm。
- Windows、macOS 或 Linux。
- 至少一个受支持供应商的 API Key。
- 使用 Worktree 子 Agent 或分支 Handoff 时需要 Git。
- 可选：VS Code `>=1.93`，用于原生图片粘贴和可点击的 Thinking 内容。

受保护的命令执行需要平台沙箱。Windows 可能需要一次管理员权限初始化；Linux 需要 `bubblewrap`、`socat` 和 `ripgrep`。安装后可用 `easy-code sandbox doctor` 检查。

## 安装

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm install
npm run build
npm install --global .
easy-code --version
```

正常安装请不要使用 `--ignore-scripts`。安装完成后检查沙箱：

```bash
easy-code sandbox doctor
```

如果检查结果提示需要初始化：

```bash
easy-code sandbox setup
easy-code sandbox doctor
```

Windows 初始化可能弹出 UAC。Linux 如果无法自动安装依赖，会输出需要手动执行的命令。

不进行全局安装时，可直接从仓库运行：

```bash
npm install
npm run build
npm start -- --workspace /path/to/project
```

如果 VS Code 扩展没有自动安装：

```bash
npm run vscode:install
```

更新现有安装：

```bash
cd EASY_CODE
git pull
npm install
npm run build
npm install --global .
```

## 首次配置

推荐把 API Key 保存到操作系统凭据存储：

```bash
easy-code config set qwen.api-key
easy-code config set deepseek.api-key
easy-code config set glm.api-key
easy-code config set glm-coding-plan.api-key
```

命令会隐藏输入内容，不要把 Key 直接写在命令后面。只需配置准备使用的供应商。

查看或删除已保存的凭据：

```bash
easy-code config list
easy-code config get qwen.api-key
easy-code config unset qwen.api-key
```

也可以使用环境变量：

| 供应商 | 环境变量 |
| --- | --- |
| Alibaba Qwen | `QWEN_API_KEY` 或 `DASHSCOPE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| 智谱 GLM | `ZAI_API_KEY`、`GLM_API_KEY` 或 `ZHIPUAI_API_KEY` |
| GLM Coding Plan | `GLM_CODING_PLAN_API_KEY` |

智谱 GLM 与 GLM Coding Plan 使用不同的 Key，二者不会互相复用。没有提前配置 Key 时，交互式启动会在第一次请求前提示输入。

## 快速开始

进入需要处理的项目并启动：

```bash
cd /path/to/project
easy-code
```

首次启动时：

1. 选择供应商和模型。
2. 选择 `none`、`low`、`medium` 或 `high` 思考强度。
3. 输入任务并按 Enter。

例如：

```text
解释这个项目，并找出主要入口。
修复登录报错并运行相关测试。
按照现有风格新增一个设置页面。
审查当前改动中的安全性和可维护性问题。
```

使用明确参数启动：

```bash
easy-code --workspace ./my-project --provider qwen --model qwen3.7-plus --thinking-effort high --mode code
```

运行一次非交互任务后退出：

```bash
easy-code --workspace ./my-project --mode code run "修复登录报错并运行测试"
```

如果非交互 `auto` 运行生成了待审核 Plan，请交互式启动并恢复对应 Thread 后处理。

可用模型以启动选择器和 `/model` 为准；模型实际可用性取决于供应商账号。切换供应商或模型：

```text
/model
/model <model-id>
/model qwen <model-id>
/provider deepseek
```

## 模式与审批

### 工作模式

| 模式 | 用途 |
| --- | --- |
| `plan` | 调查项目并给出可审核方案，不修改项目文件。 |
| `auto` | 由 Agent 决定直接回答、提出方案或开始实现；这是默认模式。 |
| `code` | 直接实现并验证请求。 |

在运行中切换：

```text
/mode plan
/mode auto
/mode code
```

也可以在启动时使用 `--mode plan|auto|code`。如果 `auto` 生成 Plan，可以同意、拒绝或输入反馈要求修改。

思考强度使用 `--thinking-effort none|low|medium|high` 设置，也可通过 `/model` 选择器调整。不同模型对思考强度的支持可能不同。

### 命令审批

运行 `/approval` 可选择：

- 手动审批：只在需要时询问。
- 自动审批：自动允许策略许可的命令，永久禁止规则仍然有效。
- 隔离下免逐条审批：取消逐条提示，仍保留强制沙箱、断网和 Plan 只读。

旧 `unrestricted` ID 不再提供宿主机完全访问。下载授权和清理失败恢复见[命令安全说明](docs/COMMAND_SECURITY_ZH.md)。

启动参数：

| 参数 | 行为 |
| --- | --- |
| `--approval safe` | 按内置策略审批，这是默认值。 |
| `--approval ask` | 对所有策略允许的命令请求审批。 |
| `--approval never` | 不显示审批提示；需要审批的命令会被拒绝。 |
| `-y, --yes` | 自动同意策略允许的命令。 |

## Thread 与 Resume

每次对话都保存在一个 Thread 中。常用命令：

```text
/sessions
/resume
/resume <thread-id>
/new
```

也可以从命令行恢复：

```bash
easy-code --workspace ./my-project --resume <thread-id>
```

恢复时应使用该 Thread 原来的工作区。Resume 会恢复可继续使用的对话、Plan、任务、授权和子 Agent 状态。

## 任务与子 Agent

对于复杂目标，可以直接要求 EASY CODE 拆分任务并并行处理，例如：

```text
把这次重构拆成独立任务，能并行的交给子 Agent，完成后运行完整测试。
```

查看状态：

```text
/tasks
/agents
```

子 Agent 可以共享当前工作区，也可以在 Git Worktree 中隔离执行。Worktree 和分支 Handoff 需要 Git；可以在请求中说明希望使用的隔离方式和交付目标。更详细的任务、隔离和 Handoff 行为见[技术设计](./docs/TECHNICAL_DESIGN_ZH.md)。

## 图片输入

图片需要使用支持视觉输入的模型。可以在 VS Code 终端直接粘贴，也可以使用：

```text
/image ./screenshot.png
/image clipboard
/image clear
```

启动时附加图片：

```bash
easy-code --image ./one.png --image ./two.png
```

VS Code 终端粘贴快捷键：Windows 使用 `Ctrl+V`，macOS 使用 `Command+V`，Linux 使用 `Ctrl+Shift+V`。GLM Coding Plan 通道不支持直接发送图片。

## 沙箱

检查或初始化操作系统沙箱：

```bash
easy-code sandbox doctor
easy-code sandbox setup
easy-code sandbox doctor
```

受保护模式在沙箱不可用时会拒绝命令执行。Windows 如果出现工作区所有权问题，先做只读检查：

```powershell
easy-code sandbox repair-workspace --target "C:\path\to\project"
```

确认输出无误后，再使用输出中的规范路径应用修复：

```powershell
easy-code sandbox repair-workspace --target "C:\path\to\project" --apply --confirm "C:\path\to\project"
```

## 项目规则

在项目中添加 `EASYCODE.md`，可以告诉 Agent 项目架构、常用命令、代码规范和验证要求。运行预算统一写入 `.easycode/config.toml` 的 `[limits]` 表；运行 `easy-code config defaults` 查看完整默认值，或参考[配置示例](./docs/config.example.toml)。旧版限制字段不再兼容。使用 `/orchestration` 上下选择是否允许新建 DAG/子 Agent，reviewer 始终独立开启。

## 常用命令

### CLI

```text
easy-code [options]
easy-code [options] run <prompt...>
easy-code config set|get|unset|list ...
easy-code sandbox doctor|setup|repair-workspace ...
easy-code benchmark swe-bench info|setup|doctor|prepare|run ...
easy-code uninstall [--data-only]
```

常用参数：

| 参数 | 用途 |
| --- | --- |
| `-w, --workspace <path>` | 选择工作区。 |
| `--provider <name>` | 选择 `qwen`、`deepseek`、`glm` 或 `glm-coding-plan`。 |
| `--model <id>` | 选择模型。 |
| `--mode <mode>` | 选择 `plan`、`auto` 或 `code`。 |
| `--thinking-effort <effort>` | 选择 `none`、`low`、`medium` 或 `high`。 |
| `--approval <policy>` | 选择 `safe`、`ask` 或 `never`。 |
| `-y, --yes` | 自动同意策略允许的命令。 |
| `--resume <thread-id>` | 恢复 Thread。 |
| `-i, --image <path>` | 添加图片，可重复使用。 |

### 交互式命令

| 分类 | 命令 |
| --- | --- |
| 模式与模型 | `/mode`、`/provider`、`/model`、`/approval` |
| 工作区 | `/workspace`、`/workspace refresh`、`/changes`、`/tools`、`/permissions`、`/commands` |
| 图片与 Thinking | `/image`、`/thinking`、`/adjustment` |
| 任务 | `/tasks`、`/agents` |
| 上下文与记忆 | `/context`、`/usage`、`/memory short [limit]`、`/memory long [id]` |
| Thread | `/sessions`、`/resume [id]`、`/new` |
| 界面 | `/status`、`/clear`、`/help`、`/exit` |

运行 `easy-code --help` 或在 EASY CODE 中运行 `/help`，可查看当前版本的精确语法。

## SWE-bench Verified Mini

仓库包含公开 50 题 SWE-bench Verified Mini（HAL）子集的评测入口。它不是官方完整 500 题排行榜成绩。评测会消耗 API 额度，开始前请先阅读[完整评测指南](./benchmarks/swebench_verified/README.md)。

评测需要 Windows x86-64、Docker Desktop 的 WSL 2 Linux 容器、Python `>=3.12` 和 Node.js `>=20.11`。建议至少 16 GB 内存、8 核 CPU 和 120 GB 可用空间。默认数据目录是 `F:\easy-code-bench\swe-bench-verified-50`。

准备环境：

```powershell
npm run build
easy-code config set glm-coding-plan.api-key
easy-code benchmark swe-bench setup
easy-code benchmark swe-bench doctor
```

先检查参数，再运行单题 Smoke Test：

```powershell
easy-code benchmark swe-bench run --dry-run --limit 1 --run-id smoke
easy-code benchmark swe-bench run --limit 1 --run-id glm-coding-plan-5.3-flash-smoke
```

单题成功生成补丁并获得有效评分后，才启动完整 50 题：

```powershell
easy-code benchmark swe-bench run --limit 50 --concurrency 1 `
  --run-id glm-coding-plan-5.3-flash-verified-mini-50 --confirm-full-run
```

需要分批运行、指定 `--offset`、调整并发或更改 F 盘目录时，请按[评测指南](./benchmarks/swebench_verified/README.md)操作。每次运行都应使用不同的 `run-id`。

## 常见问题

- API Key 缺失或被拒绝：运行 `easy-code config list`，确认供应商、模型和账号权限。
- 命令被拒绝：运行 `/permissions`，检查当前模式、审批状态和沙箱。
- VS Code 无法粘贴图片：运行 `npm run vscode:install`，重载 VS Code 并新建终端，同时确认模型支持图片。
- 找不到 Thread：运行 `/sessions`，并确认使用了原工作区和完整 Thread ID。

## 卸载

关闭其他 EASY CODE 进程后运行：

```bash
easy-code uninstall
```

只清理 EASY CODE 的提示词和记忆、保留 CLI：

```bash
easy-code uninstall --data-only
```

卸载命令会保留 API Key、配置、缓存、工作区文件、Handoff 分支、VS Code 扩展和可能包含未合并代码的托管 Worktree。

## 许可证

EASY CODE 原始源码采用 [MIT License](./LICENSE)。第三方软件许可证见[第三方开源声明](./THIRD_PARTY_NOTICES.md)。
