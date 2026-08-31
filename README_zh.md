# EASY CODE

[English](./README.md) | 简体中文

[技术设计](./docs/TECHNICAL_DESIGN_ZH.md) | [English Technical Design](./docs/TECHNICAL_DESIGN.md) | [第三方开源声明](./THIRD_PARTY_NOTICES.md)

EASY CODE 是一个跨平台 CLI 编程 Agent，支持 Alibaba Qwen、DeepSeek 和智谱 GLM。你可以在项目目录中启动它，用自然语言描述目标，让 Agent 检查工作区、修改文件、执行命令、验证结果、管理复杂任务，并在之后恢复之前的工作。

整个界面运行在当前终端中。模型请求会发送给所选供应商；项目操作、会话状态、记忆和任务编排保存在本地。

## 功能概览

- **Plan、Auto 和 Code 三种模式。** Auto 由模型决定直接回答、提出可审核方案，还是开始实现。
- **受控编程工具。** 支持读取、创建、更新和删除文件，以及运行构建、测试、格式化和受支持的安装命令。
- **可审核变更。** 文件修改以带行号的 Diff 展示，新增为绿色，删除为红色。
- **常驻终端 UI。** 对话、实时进度、任务、子 Agent、模型信息和输入框位于同一个结构化 Shell 界面中。
- **Thinking 展示。** 供应商返回的思考内容以灰色显示，默认折叠，并可在 VS Code 终端原地展开。
- **执行中调整。** 模型工作期间仍可继续输入文字或图片，调整会在下一个安全边界发送给模型。
- **图片输入。** 支持给视觉模型粘贴截图或附加图片，并使用稳定的 `[Image #N]` 编号。
- **持久 Thread。** 对话、方案、任务进度、审批、子 Agent 和执行环境都可以 Resume。
- **长短期记忆。** 保留当前对话上下文，并跨会话检索精简的项目事实。
- **任务 DAG 与子 Agent。** 复杂任务可拆成带依赖的节点，并委派给上下文隔离的子 Agent。
- **Git Worktree 隔离与 Handoff。** 可让特定子任务在托管 Worktree 中执行，保存 Checkpoint，并把结果交付到本地或分支。
- **分层安全控制。** 结构化工具、工作区边界、命令策略、用户审批、操作系统沙箱和显式危险模式相互独立。
- **可信 Prompt Bundle。** 系统提示词和工具说明作为带版本与完整性校验的用户级资源安装，不与业务源码混写。

## 环境要求

- Node.js `>=20.11.0` 和 npm。
- Windows、macOS 或 Linux。
- 至少一个受支持供应商的 API Key。
- Worktree 隔离和分支 Handoff 需要 Git；普通使用和共享工作区子 Agent 不强制要求 Git。
- 可选：VS Code `>=1.93`，用于原生图片粘贴、可点击 Thinking 和不会扰动滚动位置的交互菜单。

受保护的命令执行还依赖平台沙箱：

| 平台 | 沙箱支持 |
| --- | --- |
| Windows | 使用随包提供的 Anthropic Sandbox Runtime 后端；目前为 alpha，可能需要一次管理员权限初始化。 |
| macOS | 使用系统内置 Seatbelt 沙箱。 |
| Linux | 使用 bubblewrap，需要 `bubblewrap`、`socat` 和 `ripgrep`，并要求主机允许 bubblewrap 所需的非特权用户命名空间。 |

## 安装

克隆并安装项目：

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm install
npm run build
npm install --global .
easy-code --version
```

安装过程会准备本地记忆资源，在 `~/.easy_code` 安装经过校验的 Prompt Bundle，检查沙箱前置条件，并尝试安装随包提供的 VS Code 终端扩展。正常安装不要使用 `--ignore-scripts`。

安装后检查沙箱：

```bash
easy-code sandbox doctor
```

如果提示需要初始化：

```bash
easy-code sandbox setup
easy-code sandbox doctor
```

Windows 初始化可能弹出 UAC。Linux 只会通过受识别的包管理器安装固定的前置依赖；如果当前没有可非交互使用的管理员权限，EASY CODE 会打印命令供你手动执行。macOS 通常不需要额外安装沙箱依赖。

不进行全局安装，直接从仓库运行：

```bash
npm install
npm run build
npm start -- --workspace /path/to/project
```

如果 VS Code 扩展未自动安装：

```bash
npm run vscode:install
```

在 CI 或受管环境中，可以在安装前设置 `EASY_CODE_SKIP_VSCODE_EXTENSION=1` 跳过扩展安装。

### 更新

```bash
cd EASY_CODE
git pull
npm install
npm run build
npm install --global .
```

## 配置 API Key

推荐把 Key 保存到操作系统凭据存储中：

```bash
easy-code config set qwen.api-key
easy-code config set deepseek.api-key
easy-code config set glm.api-key
```

命令会通过隐藏输入读取 Key。不要把密钥直接追加在命令行后面。

查看或删除已经保存的凭据：

```bash
easy-code config list
easy-code config get qwen.api-key
easy-code config unset qwen.api-key
```

也支持环境变量：

| 供应商 | 环境变量 |
| --- | --- |
| Alibaba Qwen | `QWEN_API_KEY` 或 `DASHSCOPE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| 智谱 GLM | `ZAI_API_KEY`、`GLM_API_KEY` 或 `ZHIPUAI_API_KEY` |

如果当前供应商没有配置 Key，交互式启动会在第一次请求前提示输入。

## 快速开始

进入需要处理的项目并启动 EASY CODE：

```bash
cd /path/to/project
easy-code
```

启动时依次：

1. 选择 DeepSeek、Alibaba Qwen 或智谱 GLM。
2. 选择模型。
3. 选择 `none`、`low`、`medium` 或 `high` 思考强度。
4. 使用上下方向键移动，按 Enter 确认。
5. 在底部输入框中输入请求并按 Enter。

示例请求：

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

非交互执行一次任务后退出：

```bash
easy-code --workspace ./my-project --mode code run "修复登录报错并运行测试"
```

如果非交互 Auto 运行生成了待审核 Plan，请交互式启动 EASY CODE 并 Resume 对应 Thread，再同意、调整或拒绝方案。

## 支持的模型

EASY CODE 会根据内置供应商目录校验模型选择。模型是否实际可用仍取决于供应商账号、地区和授权范围。

| 供应商 | 模型 | 图片输入 |
| --- | --- | --- |
| DeepSeek | `deepseek-v4-flash` | 否 |
| DeepSeek | `deepseek-v4-pro`（默认） | 否 |
| DeepSeek | `deepseek-v4-flash-vision-exp` | 是 |
| Alibaba Qwen | `qwen3.7-max`（默认） | 否 |
| Alibaba Qwen | `qwen3.7-plus` | 是 |
| Alibaba Qwen | `qwen3.6-max` | 否 |
| Alibaba Qwen | `qwen3.6-plus` | 是 |
| Alibaba Qwen | `qwen3.5-plus` | 是 |
| Alibaba Qwen | `qwen3.5-flash` | 是 |
| Alibaba Qwen | `qwen3-max` | 否 |
| Alibaba Qwen | `qwen3-vl-plus` | 是 |
| Alibaba Qwen | `qwen3-vl-flash` | 是 |
| 智谱 GLM | `glm-5.3-flash` | 是 |
| 智谱 GLM | `glm-5.3`（默认） | 否 |
| 智谱 GLM | `glm-5.2` | 否 |

运行过程中可切换供应商、模型和思考强度：

```text
/model
/model <model-id>
/model qwen <model-id>
/provider deepseek
```

`/model` 会打开“供应商 → 模型 → 思考强度”三级选择器。

## 工作模式

| 模式 | 行为 |
| --- | --- |
| `plan` | 调查项目并生成结构化方案，不修改项目文件。 |
| `auto` | 由模型决定直接回答、提出方案或进入 Code；这是默认模式。 |
| `code` | 在当前安全控制下直接实现并验证请求。 |

使用 `/mode plan`、`/mode auto` 或 `/mode code` 切换模式。

Auto 使用受限制的模型决策，而不是关键词匹配。如果 Auto 选择 Plan，EASY CODE 会展示方案并提供三个选项：

- 同意方案，返回 Auto 执行。
- 拒绝方案。
- 输入反馈，包括粘贴多行文本，让模型调整方案。

## 思考强度

每次模型选择都会保存思考强度。只有模型公开了兼容的推理控制时，EASY CODE 才会把它映射到供应商请求；不支持的模型会忽略供应商侧设置。

思考强度同时控制 EASY CODE 的本地任务预算和子 Agent 并发：

| 强度 | 相对任务预算 | 最大活跃子 Agent 数 |
| --- | ---: | ---: |
| `none` | 1× | 2 |
| `low` | 1× | 2 |
| `medium` | 2× | 4 |
| `high` | 4× | 8 |

在供应商允许关闭思考时，`none` 会请求关闭模型思考。不同供应商的实际推理行为可能不同。

## 终端界面

交互式终端由几个稳定区域组成：

| 区域 | 内容 |
| --- | --- |
| 顶部信息 | 模式、供应商/模型、思考强度、上下文估算、工作区和 Thread ID。 |
| 对话区 | 按真实顺序显示用户输入、模型回答、Thinking、工具活动、命令输出和 Diff。 |
| 实时活动 | 当前模型请求、命令或工具操作及其耗时。 |
| 输入与状态 | 可编辑输入框、任务和子 Agent 摘要，以及精简会话状态行。 |

已完成内容会保留为普通终端文本，可以滚动、选择和复制。临时进度原地更新，不会重复打印。

模型返回 Thinking 时，折叠行只显示灰色短预览。安装随包 VS Code 扩展后，Windows/Linux 使用 `Ctrl+click`，macOS 使用 `Cmd+click`，即可在同一对话位置用完整内容替换预览；再次点击会收起。展开时输入框仍然可以使用。

也可以用 `/thinking [id|last]` 输出保存的思考内容，或按 `Ctrl+T` 查看最新一条。

请求执行期间仍可在输入框提交文字和图片。EASY CODE 会记录每条调整，并在下一个安全边界按 FIFO 顺序发送。调整可以改变任务方向，但不能修改权限、命令策略、沙箱状态或任务所有权。

## 文件、命令与审批

在正常受保护模式下，文件工具只能操作所选工作区。更新和删除必须匹配之前读取到的版本；如果编辑器或其他进程已经修改文件，本次操作会报告冲突，而不是静默覆盖。

命令使用解析后的可执行程序、结构化参数、受限工作目录、超时和输出上限。使用 `/approval` 选择当前进程的命令状态：

| 状态 | 行为 |
| --- | --- |
| 手动审批 | 每个符合策略的高风险命令都询问用户。 |
| 自动审批 | 自动批准策略允许审批的命令；永久禁止规则仍生效。 |
| 危险的完全访问 | 二次确认后，在当前进程中移除命令策略、审批、操作系统沙箱和仅工作区文件边界。 |

手动审批和自动审批会让获准命令运行在操作系统工作区沙箱内。危险的完全访问以当前 OS 用户身份运行，可访问主机文件系统、网络、环境和已安装工具；开启后 EASY CODE 会持续显示红色警告，直到切回安全状态或退出。

每次命令审批有三个选择：仅允许一次、允许当前 Thread 后续使用同一个已解析可执行程序，或者拒绝。Thread 级授权可随 Resume 恢复，但不会泄漏到其他 Thread。

## 图片

图片输入需要选择支持视觉能力的模型。

| 平台 | VS Code 终端原生粘贴键 |
| --- | --- |
| Windows | `Ctrl+V` |
| macOS | `Command+V` |
| Linux | `Ctrl+Shift+V` |

随包扩展会区分剪贴板图片和普通文本。图片会显示为 `[Image #N]`；多行文本会显示为一个粘贴块，并且只有在你按 Enter 后才提交。

也可以显式添加图片：

```text
/image ./screenshot.png
/image clipboard
/image clear
```

或者在启动时添加：

```bash
easy-code --image ./one.png --image ./two.png
```

图片会复制到私有 Thread 存储并在发送给供应商前校验。单个 Thread 的编号最多到 `Image #99`；供应商和总负载限制可能更严格。

## 任务与子 Agent

复杂工作可以由模型创建持久任务 DAG。每个任务都包含依赖、预期产物、完成检查、状态和证据；前置任务未完成时，后继任务不能开始。

主 Agent 可以自己完成任务，也可以为 DAG 任务或独立工作创建子 Agent。子 Agent：

- 接收边界明确的任务和私有上下文，而不是父 Agent 的完整对话；
- 默认以 Code 模式和 Worker 能力启动；
- 不能继续创建子 Agent，也不能控制任务图；
- 向父 Agent 返回结构化结果和证据；
- 可以接收父 Agent 的追加指令，或被父 Agent 停止。

隔离方式可以是共享工作区或 Worktree。在 Git 项目中，`auto` 优先使用托管 Worktree；非 Git 项目会使用共享工作区。显式要求 Worktree 但无法创建时会直接失败，不会悄悄退回共享写入。

托管 Worktree 从明确的起始快照创建。子 Agent 完成后的修改会形成结果 Artifact，可作为后续 DAG 任务的输入。父 Agent 可以把选定结果 Handoff 到本地工作区或分支；冲突会报告给用户，而不是覆盖现有改动。

常用命令：

```text
/tasks
/agents
```

## Thread、上下文与记忆

每次对话都属于一个持久 Thread：

```text
/sessions
/resume
/resume <thread-id>
/new
```

Resume 会尽可能恢复对话、已接受方案、未完成任务、Thread 命令授权、子 Agent 分配和托管执行环境。中断中的操作会被修复为明确可恢复状态，不会直接静默重放。

短期记忆由当前活跃消息和模型维护的工作摘要组成。随着上下文压力增大，EASY CODE 会依次提示模型考虑压缩、要求压缩，并在接近限制时自动插入强制压缩请求。

长期记忆保存较短的项目事实，例如决策、约定、环境信息和用户偏好。检索同时考虑关键词和语义相似度。模型可以提出新增、修订和删除；只有回合成功后才提交，并会过滤密钥和跨工作区内容。

查看记忆与用量：

```text
/context
/memory short
/memory short 20
/memory long
/usage
```

## 项目规则与配置

可以在项目中放置 `EASYCODE.md`，说明架构、命令、代码规范和验证要求。规则会从用户级配置和工作区目录层级加载；它们可以指导 Agent，但不能扩大 Runtime 权限。

用户配置位于平台对应的 EASY CODE 配置目录。项目可通过 `.easycode/config.toml` 设置安全的工作区级选项。项目配置不能重定向凭据、安全敏感路径或供应商地址。

项目配置示例：

```toml
[limits]
max_steps = 40
max_context_chars = 400000

[subagents]
isolation = "auto" # auto、shared 或 worktree

[worktrees]
base_mode = "current-snapshot" # fresh、head 或 current-snapshot
max_managed = 15
```

`medium` 使用 `none/low` 基础值的两倍，`high` 使用四倍。配置优先级和存储边界见[技术设计](./docs/TECHNICAL_DESIGN_ZH.md)。

提示词和工具说明位于固定的用户级 Prompt Bundle 中。可以检查或修复：

```bash
easy-code prompts doctor
easy-code prompts list
easy-code prompts repair
```

## 命令参考

### CLI

```text
easy-code [options]
easy-code [options] run <prompt...>
easy-code config set|get|unset|list ...
easy-code sandbox doctor|setup|repair-workspace ...
easy-code prompts doctor|list|repair
easy-code uninstall [--data-only]
```

常用参数：

| 参数 | 用途 |
| --- | --- |
| `-w, --workspace <path>` | 选择工作区。 |
| `--provider <name>` | 选择 `qwen`、`deepseek` 或 `glm`。 |
| `--model <id>` | 选择该供应商下的模型。 |
| `--mode <mode>` | 选择 `plan`、`auto` 或 `code`。 |
| `--thinking-effort <effort>` | 选择 `none`、`low`、`medium` 或 `high`。 |
| `--approval <policy>` | 设置启动时命令审批策略。 |
| `-y, --yes` | 自动同意策略允许审批的命令。 |
| `--resume <thread-id>` | 恢复保存的 Thread。 |
| `-i, --image <path>` | 添加图片，可重复传入。 |

### 交互式斜杠命令

| 分类 | 命令 |
| --- | --- |
| 模式与模型 | `/mode`、`/provider`、`/model`、`/approval` |
| 工作区 | `/workspace`、`/workspace refresh`、`/changes`、`/tools`、`/permissions`、`/commands` |
| 图片与思考 | `/image`、`/thinking`、`/adjustment` |
| 任务 | `/tasks`、`/agents` |
| 上下文与记忆 | `/context`、`/usage`、`/memory short [limit]`、`/memory long [id]` |
| Thread | `/sessions`、`/resume [id]`、`/new` |
| 界面 | `/status`、`/clear`、`/help`、`/exit` |

在 EASY CODE 中运行 `/help` 可查看当前版本的精确语法。

## 常见问题

### API Key 缺失或被拒绝

运行 `easy-code config list`，检查当前供应商，并确认账号有权访问所选模型。环境变量优先级高于操作系统凭据存储。

### 命令沙箱不可用

运行：

```bash
easy-code sandbox doctor
easy-code sandbox setup
easy-code sandbox doctor
```

受保护模式在沙箱初始化失败时会关闭命令执行，不会退回无沙箱运行。Windows 工作区特定的所有权问题可先通过 `easy-code sandbox repair-workspace --target <path>` 只读检查，再决定是否应用修复。

### VS Code 中无法粘贴图片

运行 `npm run vscode:install` 重新安装扩展，重载 VS Code，并创建一个新终端。确认当前模型支持图片。剪贴板中的普通文字应继续按文字处理，不会转成图片附件。

### 命令被拒绝

使用 `/permissions` 查看当前状态。命令可能因为 Plan 模式、永久策略、工作区边界、缺少审批或沙箱不可用而被拒绝。只有用户明确二次确认的危险完全访问会移除这些保护。

### Resume 找不到 Thread

使用 `/sessions` 查看当前工作区和本地数据目录中可用的 Thread。Resume ID 必须完全匹配。

## 卸载

使用 EASY CODE 自带卸载命令，先清除提示词和记忆，再删除全局包：

```bash
easy-code uninstall
```

请先关闭其他 EASY CODE 进程。该命令会删除当前 OS 用户的 `~/.easy_code` Prompt Bundle，以及可识别的长期和短期记忆，然后卸载全局 npm 包。如果记忆数据库仍被占用，或自定义数据根目录无法证明属于 EASY CODE，清理会安全失败。

只清理提示词和记忆、保留 CLI：

```bash
easy-code uninstall --data-only
```

API Key、配置、模型缓存、工作区文件、Handoff 分支、VS Code 扩展，以及可能包含未合并代码的托管 Worktree 会保留。现代 npm 不会调用包的卸载生命周期，因此只运行 `npm uninstall --global easy-code-agent` 无法完成这些数据清理。

## 许可证

EASY CODE 原始源码采用 [MIT License](./LICENSE)。随包提供或安装的第三方软件保留各自许可证，详见[第三方开源声明](./THIRD_PARTY_NOTICES.md)，其中包含 Anthropic Sandbox Runtime 的 Apache-2.0 声明。
