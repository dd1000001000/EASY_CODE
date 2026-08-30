# EASY CODE

[English](./README.md) | 简体中文

技术设计（架构、终端 UI、权限、记忆、DAG、子 Agent 会话、Worktree 与 Handoff）：[简体中文](./docs/TECHNICAL_DESIGN_ZH.md) | [English](./docs/TECHNICAL_DESIGN.md)

EASY CODE 是一个支持 Alibaba Qwen、DeepSeek 和智谱 GLM 的本地 CLI 编程 Agent。在项目目录中启动它，描述你想要的结果，它就可以查看文件、修改代码、运行命令、验证变更、管理上下文，并在之后恢复未完成的工作。

EASY CODE 直接运行在当前终端中，不会另外打开桌面窗口。

## 功能概览

- 提供 Plan、Auto、Code 三种工作模式，其中 Auto 由模型控制路由。
- 读取、新建、更新和删除工作区内的文件。
- 运行命令、测试、构建工具以及受支持的 npm 安装命令。
- 显示带行号的代码 Diff：新增内容为绿色，删除内容为红色。
- 已完成内容保留在终端 scrollback 中，当前工作则在紧凑的行内状态区持续更新。
- 在会话中切换 Provider、模型和思考强度。
- 向支持视觉的模型发送截图和图片文件。
- 自动管理短期上下文和长期项目记忆。
- 通过 Auto 直接回答和按工具精简指令，减少模型请求内容。
- 使用 `/usage` 查看 Provider 累计报告的 Token 用量。
- 保存并恢复对话、计划、任务进度、子 Agent 会话和托管执行环境。
- 根据任务复杂度选择是否建立带依赖结果链的任务 DAG。
- 把工作交给共享根目录或独立 Git Worktree 中的子 Agent，再显式 Handoff 到本地或分支。
- 从 `EASYCODE.md` 读取项目规则。
- 支持 Windows、macOS 和 Linux。

## 环境要求

- Node.js `>=16.20.0` 和 npm。
- Windows、macOS 或 Linux。
- 至少一个受支持 Provider 的 API Key。
- 共享子 Agent 不强制依赖 Git；显式 Worktree 隔离和 Branch Handoff 需要 Git。
- 可选：VS Code `>=1.93`，用于在集成终端中原生粘贴图片。

推荐使用仍在维护期内的 Node.js LTS 版本。

## 安装

目前从 GitHub 仓库安装：

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm install
npm run build
npm install --global .
easy-code --version
```

如果已经配置 GitHub SSH Key，也可以使用：

```bash
git clone git@github.com:dd1000001000/EASY_CODE.git
```

npm 安装过程会准备自动记忆所需的资源，并尝试安装随项目提供的 VS Code 终端扩展。正常安装时不要使用 `--ignore-scripts`。

更新已有安装：

```bash
cd EASY_CODE
git pull
npm install
npm run build
npm install --global .
```

不安装到全局，直接从源码目录运行：

```bash
npm install
npm run build
npm start -- --workspace /path/to/project
```

如果安装时没有检测到 VS Code，可以在 EASY CODE 源码目录执行：

```bash
npm run vscode:install
```

在 CI 或受管环境中，可以在安装前设置 `EASY_CODE_SKIP_VSCODE_EXTENSION=1` 跳过扩展安装。

## 配置 API Key

推荐把 API Key 保存到操作系统凭据存储中：

```bash
easy-code config set qwen.api-key
easy-code config set deepseek.api-key
easy-code config set glm.api-key
```

命令会通过隐藏输入读取 Key，不要把 API Key 直接写在命令后面。

查看配置状态：

```bash
easy-code config list
easy-code config get qwen.api-key
```

删除已经保存的 Key：

```bash
easy-code config unset qwen.api-key
```

也可以使用环境变量：

| Provider | 环境变量 |
| --- | --- |
| Alibaba Qwen | `QWEN_API_KEY` 或 `DASHSCOPE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| 智谱 GLM | `ZAI_API_KEY`、`GLM_API_KEY` 或 `ZHIPUAI_API_KEY` |

如果所选 Provider 没有配置 API Key，EASY CODE 会在启动前提示输入。

## 快速开始

进入需要处理的项目目录并启动：

```bash
cd /path/to/project
easy-code
```

交互式启动流程：

1. 选择 DeepSeek、Alibaba Qwen 或智谱 GLM。
2. 选择模型。
3. 选择 `none`、`low`、`medium` 或 `high` 思考强度。
4. 使用上下方向键移动，按 Enter 确认。
5. 在终端底部的盒式输入区中输入任务，然后按 Enter 提交。

示例：

```text
解释一下这个项目，并找出主要入口。
修复登录时报错的问题，然后运行相关测试。
按照现有代码风格新增一个设置页面。
检查当前改动中是否存在安全性和可维护性问题。
```

使用明确的启动参数：

```bash
easy-code --workspace ./my-project --provider qwen --model qwen3.7-plus --thinking-effort high --mode code
```

非交互式运行一个任务并退出：

```bash
easy-code --workspace ./my-project --mode code run "修复登录错误并运行测试"
```

## 终端界面

在交互式终端中，EASY CODE 把同一个行内界面分成四个区域：

| 区域 | 显示内容 |
| --- | --- |
| 会话头部 | 当前模式、Provider/模型、思考强度、上下文估算、工作区和 Thread ID。 |
| Scrollback | 已完成的用户/助手消息、工具结果、命令输出、Diff 和最终结果。内容按普通终端输出追加，因此仍然可以滚动、选择和复制。 |
| 动态状态区 | 输入框上方只显示仍在运行的进度以及命令/模型活动。工具完成后会进入 scrollback，不会继续作为重复的 progress 行保留。EASY CODE 只会重绘这个输出区域。 |
| 输入框与状态栏 | 可跨终端行自动换行的盒式输入区；其下依次显示紧凑的 Tasks、Agents，模式、模型、思考强度、上下文、任务和活动 Agent 摘要始终位于最后一行。附加图片显示为 `[Image #N]`。 |

工具活动完成后只会进入普通 scrollback 一次；已被后续状态替代的 Step/status 行会直接移除，不会累计。重绘只清除终端底部的动态行，不会重新绘制或擦除更早的对话、命令输出和 Diff。布局按终端显示单元格计算，因此窄窗口、中文等全角字符以及 Emoji 都能保持对齐。

`/model`、命令审批、Plan 审核和 `/resume` 使用盒式覆盖选择器，不再向 scrollback 追加临时菜单文本。选择器打开时会替代普通动态状态和输入框。使用 `↑`/`↓` 移动，按 Enter 确认，按 Esc 取消；取消命令审批始终等同于拒绝。

安装随项目提供的 VS Code 扩展后，在 Windows/Linux 上按住 `Ctrl` 点击已完成标记中灰色的 `Thinking #N`，或在 macOS 上按住 `Cmd` 点击，即可在可重绘动态状态区内打开对应灰色面板。用相同手势再次激活该标记，或激活面板底部 `↕` 控制行中的 `Thinking #N`，即可关闭；激活其他标记会切换到对应内容。模型请求进行期间该控件也会保持响应。Thinking 面板不支持也不占用 Esc；Esc 仍留给 overlay 和普通终端输入。

临时面板采用有界高度，确保折叠时可以安全擦除而不破坏终端 scrollback。如果保留的 Thinking 超出面板可见范围，面板会明确显示省略的行数，并给出对应的 `/thinking N`；执行该命令可把全部已保留内容写入稳定 scrollback。

在输入框中可以正常输入或粘贴，按 Enter 提交。多行文字会先显示为紧凑的 `[Pasted text #N · M lines]` 块；只有用户明确提交时才会恢复完整换行和缩进，因此剪贴板中的换行不会再被误当作 Enter。`/thinking N` 与 `Ctrl+T` 仍会把完整保留的 Thinking 内容写入稳定 scrollback，并保留当前草稿；它们不会切换临时面板。`Ctrl+C` 用于取消当前输入或操作。安装随项目提供的 VS Code 扩展后，使用系统原生图片粘贴快捷键会在光标处插入可见的 `[Image #N]` 附件；各平台快捷键和命令备用方式见[图片](#图片)。

当 stdin/stdout 不是交互式 TTY，或终端无法安全支持光标定位重绘时，EASY CODE 会降级为无 ANSI 颜色的纯文本追加式状态快照和单行输入。此时交互式覆盖选择器可能不可用，请改用明确的 CLI 选项或命令参数，例如 `/model <model-id>` 和 `/resume <thread-id>`。

## 支持的模型

| Provider | 模型 | 图片输入 |
| --- | --- | --- |
| DeepSeek | `deepseek-v4-flash` | 不支持 |
| DeepSeek | `deepseek-v4-pro`（默认） | 不支持 |
| DeepSeek | `deepseek-v4-flash-vision-exp` | 支持 |
| Alibaba Qwen | `qwen3.7-max`（默认） | 不支持 |
| Alibaba Qwen | `qwen3.7-plus` | 支持 |
| Alibaba Qwen | `qwen3.6-max` | 不支持 |
| Alibaba Qwen | `qwen3.6-plus` | 支持 |
| Alibaba Qwen | `qwen3.5-plus` | 支持 |
| Alibaba Qwen | `qwen3.5-flash` | 支持 |
| Alibaba Qwen | `qwen3-max` | 不支持 |
| Alibaba Qwen | `qwen3-vl-plus` | 支持 |
| Alibaba Qwen | `qwen3-vl-flash` | 支持 |
| 智谱 GLM | `glm-5.3-flash` | 支持 |
| 智谱 GLM | `glm-5.3`（默认） | 不支持 |
| 智谱 GLM | `glm-5.2` | 不支持 |

上表是 EASY CODE 当前支持的模型目录。模型是否能实际调用，还取决于 Provider 服务、账户、区域和模型权限。

在会话中切换模型：

```text
/model
/model <model-id>
/model qwen <model-id>
/model deepseek <model-id>
/model glm <model-id>
```

`/model` 会打开 Provider → Model → 思考强度选择菜单。也可以使用 `/provider qwen|deepseek|glm` 直接切换 Provider。

## 工作模式

| 模式 | 适用场景 |
| --- | --- |
| `plan` | 只希望 EASY CODE 调查项目并提供方案，不修改文件，也不执行构建或安装命令。 |
| `auto` | 让模型自行决定直接回答、先给出可审核计划，还是直接实现。默认使用该模式。 |
| `code` | 不需要预先展示计划，直接实现并验证需求。 |

在会话中切换模式：

```text
/mode plan
/mode auto
/mode code
```

Auto 的路由由当前所选模型控制，不依赖关键词匹配。如果请求可以仅根据当前对话完整回答，不需要访问工作区、调用工具、产生副作用或先审核方案，本次路由请求可以直接返回最终答案。直接回答仍遵守常规安全规则和 `EASYCODE.md`；上下文达到强制压缩阈值时，EASY CODE 会先完成压缩，再进行路由或回答。其他请求会被模型路由到 Plan 或 Code。

当 Auto 选择 Plan 后，EASY CODE 会显示方案，并打开包含三个选项的盒式审核 overlay：

```text
Yes, use Auto mode
No, reject plan
Adjust plan with feedback
```

选择 Yes 会切回 Auto 并执行已经接受的方案；选择 No 会拒绝方案；选择反馈行后会打开单行输入，再让模型调整方案并重新提交。

## 思考强度

如果所选模型支持，思考强度会影响模型推理。它还会决定默认任务预算和可以同时运行的子 Agent 数量。

| 强度 | 默认最大步骤 | 默认上下文大小 | 子 Agent 上限 |
| --- | ---: | ---: | ---: |
| `none` | 40 | 400,000 字符 | 2 |
| `low` | 40 | 400,000 字符 | 2 |
| `medium` | 80 | 800,000 字符 | 4 |
| `high` | 160 | 1,600,000 字符 | 8 |

对于允许关闭思考的模型，`none` 表示请求模型不进行思考。如果模型不支持可配置的思考强度，EASY CODE 仍会保存用户选择，但思考设置本身可能不会对该模型生效。

当模型返回 Thinking 内容时，EASY CODE 会把灰色 `Thinking #N` 标记和简短灰色预览写入稳定 scrollback。安装随项目提供的 VS Code 扩展后，在 Windows/Linux 上使用 `Ctrl+点击`、在 macOS 上使用 `Cmd+点击`，即可在动态状态区切换一个有界灰色面板。激活其他标记会切换内容；再次激活当前标记或面板底部控制行会关闭。Esc 不是 Thinking 面板快捷键。

如果要把完整保留的内容写入稳定 scrollback，而不是打开临时面板，请使用：

```text
/thinking
/thinking <id>
/thinking last
```

交互式终端中也可以按 `Ctrl+T` 查看最近一个内容。命令和快捷键都会保留当前输入框草稿。

可以在用户配置或 `.easycode/config.toml` 中调整基础限制：

```toml
[limits]
max_steps = 40
max_context_chars = 400000

[subagents]
isolation = "auto" # auto、shared 或 worktree

[worktrees]
base_mode = "current-snapshot" # fresh、head 或 current-snapshot
max_managed = 15
# root = "/位于整个仓库之外的绝对路径" # 仅可信用户配置
```

`medium` 使用基础值的 2 倍，`high` 使用基础值的 4 倍。
工作区位于 Git 仓库中时，`auto` 使用托管 Git Worktree；只有找不到 Git
仓库时才回退到共享工作区。如果已经选择 Worktree，但校验、数量限制或 checkout
创建失败，子 Agent 会失败关闭，不会静默降级为共享写入。

自定义存储路径的推荐配置名是 `[worktrees]` 下的 `root`。它只能来自可信用户
配置，必须位于整个 Git 仓库之外，默认使用 EASY CODE 应用数据目录下的
`worktrees` 子目录。项目中的
`.easycode/config.toml` 不能重定向该路径。对应环境变量为
`EASY_CODE_SUBAGENT_ISOLATION`、`EASY_CODE_WORKTREE_BASE_MODE`、
`EASY_CODE_WORKTREE_ROOT` 和 `EASY_CODE_MAX_MANAGED_WORKTREES`。

Worktree 基线是创建子 Agent 时确定的一次性输入：

| `base_mode` | 子 Agent 起点 |
| --- | --- |
| `fresh` | 使用当前已经配置的 `origin/HEAD`，不存在时回退本地 `HEAD`；EASY CODE 不会 Fetch。 |
| `head` | 使用本地 `HEAD`，不包含所属仓库尚未提交的修改。 |
| `current-snapshot` | 使用本地 `HEAD`，并在创建时捕获整个所属仓库中的 staged、unstaged 和未忽略 untracked 状态。 |

默认模式是 `current-snapshot`，因此所属 Git 仓库不需要保持干净。在 Monorepo
中，快照覆盖整个仓库，但子 Agent 文件工具仍限制在所选逻辑工作区的映射范围内。
它不是实时同步：父 checkout 后续发生的修改不会自动进入已经创建的子 Agent，并可能
在 Handoff 时产生冲突。

## 编程与工作区功能

EASY CODE 可以：

- 读取所选工作区内的文本文件。
- 新建文件，并避免静默覆盖已有文件。
- 更新已经查看过的文件。
- 查看文件后删除整个文件。
- 运行项目命令、测试、格式化、构建和受支持的安装操作。
- 把成功的文件变更显示成带行号的 Diff。
- 记录当前 Thread 中的文件变更和最近命令。

常用查看命令：

```text
/workspace
/workspace refresh
/changes
/commands
/tools
/permissions
```

文件操作会限制在所选工作区内。命令仍然使用启动 EASY CODE 的当前操作系统用户权限执行。

命令需要批准时，可以使用 `↑`/`↓` 和 Enter 选择：

1. `Yes, allow execute one time`：只批准当前这一次命令请求。
2. `Yes, don't ask me again with prefix [executable]`：在当前 Thread 中记住 Runtime 解析后的精确可执行文件路径。
3. `Reject`：拒绝执行。

第二项会作用于该可执行文件后续收到的不同参数，使用 `/resume` 后仍然有效，同一父 Thread 绑定的子 Agent 也可以复用；它不会进入 `/new` 或其他 Thread，子 Agent 自己也不能新增授权。Python、Node.js、`cmd`、PowerShell 等解释器或 Shell 的授权范围很大，因为后续脚本或 Shell 文本可能执行完全不同的操作。授权标识的是路径，而不是不可变的程序内容，因此替换该路径上的文件不会自动撤销授权。可以使用 `/permissions` 查看当前授权。永久策略拒绝、Plan mode 边界和 `--approval never` 始终拥有更高优先级。

## 图片

安装随项目提供的 VS Code 扩展后，可以在集成终端中使用系统原生快捷键粘贴截图：

- Windows：`Ctrl+V`
- Linux：`Ctrl+Shift+V`
- macOS：`Command+V`

图片会显示为 `[Image #1]`、`[Image #2]` 等编号。剪贴板中的普通文字仍然按文字粘贴。

也可以使用命令附加图片：

```text
/image clipboard
/image ./path/to/screenshot.png
/image clear
```

或者在启动时附加一张或多张图片：

```bash
easy-code --image ./screenshot.png --image ./diagram.jpg
```

EASY CODE 支持 PNG、JPEG、WebP 和静态 GIF；一个 Thread 或一次模型请求最多包含 99 张图片。当前模型必须在支持模型表中标记为支持图片。

## 任务与子 Agent

遇到复杂工作时，EASY CODE 可以建立包含任务名称和依赖关系的任务 DAG。这是可选功能，简单请求不需要建立 DAG。

使用 `/tasks` 查看任务列表：

- `✓` 已完成
- `▶` 正在进行
- `□` 尚未开始
- `⊠` 已阻塞

主 Agent 也可以把独立工作交给子 Agent。子 Agent 同样是可选的，无论是否建立 DAG 都可以使用。子 Agent 会继承当前 Provider、模型和思考强度，使用 Code mode 完成任务，并且不能继续创建子 Agent。

每个子 Agent 可以选择 `auto`、`shared` 或 `worktree` 隔离方式。原始项目仍是规则与记忆使用的逻辑工作区，Worktree 子 Agent 则在自己的物理 checkout 中执行。每次分配都会稳定绑定父 Thread、子 Thread、任务与执行环境，因此 Resume 不会把子 Agent 静默连接到另一个 checkout。

按子 Agent 选择隔离方式和执行 Handoff 都是主 Agent 能力，不是斜杠命令。可以直接用自然语言要求：

```text
让独立任务使用 Worktree 隔离的子 Agent。
把完成的结果 Handoff 到我的本地工作区。
把结果保存在分支 easy-code/login-feature。
```

Worktree 结果在父 Agent 显式 Handoff 前不会进入当前 checkout：

| 结果去向 | 行为 |
| --- | --- |
| Local Handoff | 先预检完整的子 Agent/DAG 增量，再应用到当前 Working Tree；不 Stage，也不 Commit。无关用户修改会保留，重叠修改会进入冲突状态而不是被覆盖。 |
| Branch Handoff | 创建或复用指向不可变结果 Commit 的本地分支；不切换当前 checkout，也不 Push。已有分支指向其他 Commit 时会发生冲突。 |
| Shared 子 Agent | 变更已经直接发生在当前工作区中，因此不存在可用于 Branch Handoff 的隔离 Commit。 |

使用 `current-snapshot` 时，父工作区原有的脏状态属于子 Agent 基线。Local
Handoff 只应用从该基线开始产生的子 Agent/DAG 增量，不会重复应用用户原有修改。

DAG 子任务只把不可变结果引用传给自己的直接后继节点。Join 会在新建的托管
Worktree 中合并依赖 Commit；发生冲突时停止节点完成并等待处理。完整 DAG 只有在
任务图已完成、存在唯一终点叶节点，并且目标子 Agent 拥有该终点任务时才能 Handoff
最终结果。多个终点分支必须先通过显式 Join 任务汇合。

查看子 Agent：

```text
/agents
/subagents
/status
```

`/agents` 是只读命令，会显示每个子 Agent 的任务与 Agent ID、可恢复的子 Thread
ID、请求和实际使用的隔离方式、执行环境状态，以及结果 Artifact/Handoff 状态。

`none`/`low` 最多同时运行 2 个子 Agent，`medium` 最多 4 个，`high` 最多 8 个。独立的 `max_managed` Worktree 上限不会随思考强度倍增，用于防止保留的 checkout 无限增长。清理只针对 Runtime 管理的路径；成功交付且干净的 checkout 可以自动移除，dirty、busy、retained 或 conflicted 环境会继续保留并占用名额。如果仍有子 Agent 正在运行或结果尚未收取，Auto 会保持在 Code mode，直到父 Agent 完成结果收集。

如果新的托管 checkout 需要某个被 Git 忽略的运行文件，可以在所属 Git 仓库根目录
创建 `.worktreeinclude`，其中只写相对于该仓库根目录的安全模式。无论选择哪种基线，
匹配文件都会复制到新建的 Worktree，但 Checkpoint 重建后不保证仍然存在，因此项目
必须能够再次提供这些文件。不要包含 API Key、私钥或其他秘密。

## 上下文与记忆

上下文和记忆由 EASY CODE 自动管理。用户可以查看，但不能手动新增、修改或删除记忆。

```text
/context
/memory short [limit]
/memory long
/memory long <id>
```

- 短期记忆属于当前 Thread，包括有效对话、摘要、任务状态和近期工具结果。`/memory short [limit]` 展示最近的活跃消息预览，而不是全部短期记忆；默认显示 8 条，可设置为 1 到 500 条。
- 长期记忆保存同一工作区中以后仍然有用的项目事实、决定、约定和偏好。
- 当对话变得较长时，EASY CODE 会自动压缩较早的上下文。
- 会话头部与状态栏会显示类似 `context:12.4k` 的近似 Token 数量。

## Token 效率与用量

EASY CODE 通过以下方式精简模型请求：

- 对于边界明确且不需要工具的请求，Auto 可以在一次路由请求中直接回答，不再额外发起第二次 Agent 请求。
- 每次模型请求只包含当前模式和步骤实际开放工具的相关指令。

使用只读命令 `/usage` 查看当前 Thread 中由 Provider 报告的累计 Token 用量：

```text
/usage
```

报告会按 Provider/模型、请求用途（`auto_route`、`agent_step` 和 `context_compaction`）以及执行者（主 Agent 和子 Agent）分类；如果 Provider 提供相应明细，还会分别显示缓存 Token 和推理 Token。Provider 没有返回用量数据的请求会计入未报告请求。失败请求以及未附带 usage 明细的 Provider 响应无法得到精确 Token 数，因此 `/usage` 可能低于 Provider 账单控制台中的总量。

`/context` 仍用于估算当前有效上下文大小；`/usage` 显示当前 Thread 中已保存模型请求的 Provider 累计报告用量。

## Thread 与 Resume

使用 `/status` 查看当前 Thread ID，或者列出已经保存的 Thread：

```text
/sessions
```

从 Shell 恢复：

```bash
easy-code --resume <thread-id>
```

在 EASY CODE 会话中恢复：

```text
/resume [thread-id]
```

省略 ID 会打开盒式 Resume 选择器；提供 ID 则直接恢复对应 Thread。

Resume 会尽可能恢复已经保存的状态，包括所选模型和模式、对话、已接受计划、任务进度、文件与命令历史、上下文摘要、已完成的子 Agent 结果，以及仍然有效的活动子 Thread/执行环境绑定。关键身份、仓库和路径元数据校验通过，并且已保存的快照 Commit 仍可解析时，缺失的托管 checkout 目录才能重建。已有子 Agent 的环境记录缺失，或其中的身份、仓库、路径元数据校验不一致时会失败关闭，不会另建 checkout 后静默改绑。已经持久完成的子任务不会重跑；被中断的命令或模型调用也不会自动重复执行。

使用 `/new` 新建一个独立 Thread。

## 项目规则

可以创建 `EASYCODE.md`，告诉 EASY CODE 应该如何处理项目。适合写入：

- 构建、测试、Lint 和格式化命令。
- 代码风格与命名约定。
- 重要目录和架构规则。
- 应该避免修改的文件或操作。

EASY CODE 可以读取用户级规则，以及工作区路径中的项目规则。

## CLI 参数

```text
-w, --workspace <path>                         选择工作区
--provider qwen|deepseek|glm                   选择 Provider
--model <id>                                   选择模型
--mode plan|auto|code                          选择工作模式
--thinking-effort none|low|medium|high         选择思考强度
--approval safe|ask|never                      选择命令审批策略
-y, --yes                                      自动批准策略允许的询问
--resume <thread-id>                           恢复 Thread
-i, --image <path>                             附加图片，可重复使用
```

在 Shell 中运行 `easy-code --help` 查看启动参数；进入 EASY CODE 后运行 `/help` 查看交互命令。

## 交互命令

```text
/mode plan|auto|code       切换工作模式
/provider <provider>       切换 Provider
/model                     打开模型选择菜单
/model <model-id>          切换模型
/status                    查看 Thread 和 Agent 状态
/workspace [refresh]       查看或刷新工作区信息
/image <path|clipboard>    附加图片
/image clear               清除尚未发送的图片
/changes                   查看文件变化
/tasks                     查看任务 DAG
/agents                    查看子 Agent
/tools                     查看可用工具
/permissions               查看命令权限
/commands                  查看近期命令
/context                   查看上下文使用量
/usage                     查看 Provider 累计报告的 Token 用量
/memory short [limit]      查看近期短期记忆预览（默认 8 条，最多 500 条）
/memory long [id]          查看长期记忆
/thinking [id|last]        查看模型 Thinking
/sessions                  列出保存的 Thread
/resume [id]               选择或恢复 Thread
/new                       新建 Thread
/clear                     清屏
/help                      显示帮助
/exit                      保存并退出
```

## 安全提示

- 让 Agent 进行大范围修改前，建议先提交或备份重要工作。
- 使用 `/permissions` 查看当前命令策略。
- 除非信任当前 Thread 中传给该可执行文件的所有后续参数，否则优先选择一次性批准。
- 只在可信工作区或隔离环境中使用 `--yes`。
- `--yes` 不会绕过 Plan mode 的限制，也不会放行始终禁止的命令。
- 获准执行的命令使用当前操作系统账户权限，可能访问工作区之外的资源。
- Git Worktree 只隔离工作状态，不隔离操作系统进程，因此不是安全 Sandbox。
- 不要把 API Key 写入源码、聊天提示词、`EASYCODE.md` 或 Git 历史。

## 常见问题

### 找不到 `easy-code`

确认 npm 全局二进制目录已经加入 `PATH`，然后重新安装：

```bash
npm install --global .
```

### API Key 缺失、401 或 403

检查当前 Provider 和 Key 状态：

```bash
easy-code config list
```

同时确认账户和区域有权访问所选模型。

### VS Code 中无法粘贴图片

在 EASY CODE 源码目录运行：

```bash
npm run vscode:install
```

然后在 VS Code 中执行 `Developer: Reload Window`。也可以使用 `/image clipboard` 作为备用方式。

### 自动记忆所需资源缺失

重新安装并确保没有使用 `--ignore-scripts`，或者在源码目录运行：

```bash
npm run memory:install
npm run memory:verify
```

### 命令被拒绝

使用 `/permissions` 查看当前模式和审批策略。Plan mode 不允许修改代码、构建、测试或安装依赖。

### Node.js 版本过低

查看当前版本：

```bash
node --version
```

EASY CODE 要求 Node.js `>=16.20.0`。
