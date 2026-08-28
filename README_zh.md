# EASY CODE

[English](./README.md) | 简体中文

技术文档：[简体中文](./docs/TECHNICAL_DESIGN_ZH.md) | [English](./docs/TECHNICAL_DESIGN.md)

EASY CODE 是一个支持 Alibaba Qwen、DeepSeek 和智谱 GLM 的本地 CLI 编程 Agent。在项目目录中启动它，描述你想要的结果，它就可以查看文件、修改代码、运行命令、验证变更、管理上下文，并在之后恢复未完成的工作。

EASY CODE 直接运行在当前终端中，不会另外打开桌面窗口。

## 功能概览

- 提供 Plan、Auto、Code 三种工作模式，其中 Auto 由模型控制路由。
- 读取、新建、更新和删除工作区内的文件。
- 运行命令、测试、构建工具以及受支持的 npm 安装命令。
- 显示带行号的代码 Diff：新增内容为绿色，删除内容为红色。
- 在会话中切换 Provider、模型和思考强度。
- 向支持视觉的模型发送截图和图片文件。
- 自动管理短期上下文和长期项目记忆。
- 通过 Auto 直接回答和按工具精简指令，减少模型请求内容。
- 使用 `/usage` 查看 Provider 累计报告的 Token 用量。
- 保存并恢复对话、计划、任务进度和子 Agent 结果。
- 根据任务复杂度选择是否建立任务 DAG。
- 根据需要把独立工作交给隔离的子 Agent。
- 从 `EASYCODE.md` 读取项目规则。
- 支持 Windows、macOS 和 Linux。

## 环境要求

- Node.js `>=16.20.0` 和 npm。
- Windows、macOS 或 Linux。
- 至少一个受支持 Provider 的 API Key。
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
5. 在 `EASY CODE [...] >` 提示符后输入任务。

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

当 Auto 选择 Plan 后，EASY CODE 会显示方案并提供三个选项：

```text
1. Yes, use Auto mode
2. No, reject plan
3. Type feedback and press Enter to adjust the plan
```

选择 Yes 会切回 Auto 并执行已经接受的方案；选择 No 会拒绝方案；直接输入修改意见会让模型调整方案并重新提交。

## 思考强度

如果所选模型支持，思考强度会影响模型推理。它还会决定默认任务预算和可以同时运行的子 Agent 数量。

| 强度 | 默认最大步骤 | 默认上下文大小 | 子 Agent 上限 |
| --- | ---: | ---: | ---: |
| `none` | 40 | 400,000 字符 | 2 |
| `low` | 40 | 400,000 字符 | 2 |
| `medium` | 80 | 800,000 字符 | 4 |
| `high` | 160 | 1,600,000 字符 | 8 |

对于允许关闭思考的模型，`none` 表示请求模型不进行思考。如果模型不支持可配置的思考强度，EASY CODE 仍会保存用户选择，但思考设置本身可能不会对该模型生效。

当模型返回 Thinking 内容时，终端会显示灰色 `Thinking #N` 标记和一段灰色预览。查看完整内容：

```text
/thinking
/thinking <id>
/thinking last
```

交互式终端中也可以按 `Ctrl+T`。

可以在用户配置或 `.easycode/config.toml` 中调整基础限制：

```toml
[limits]
max_steps = 40
max_context_chars = 400000
```

`medium` 使用基础值的 2 倍，`high` 使用基础值的 4 倍。

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

查看子 Agent：

```text
/agents
/subagents
/status
```

`none`/`low` 最多同时运行 2 个子 Agent，`medium` 最多 4 个，`high` 最多 8 个。如果仍有子 Agent 正在运行或结果尚未收取，Auto 会保持在 Code mode，直到父 Agent 完成结果收集。

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
- 提示符会显示类似 `context:12.4k` 的近似 Token 数量。

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
/resume <thread-id>
```

Resume 会尽可能恢复已经保存的状态，包括所选模型和模式、对话、已接受计划、任务进度、文件与命令历史、上下文摘要以及已经完成的子 Agent 结果。被中断的命令或模型调用不会被自动重新执行。

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
/resume <id>               恢复 Thread
/new                       新建 Thread
/clear                     清屏
/help                      显示帮助
/exit                      保存并退出
```

## 安全提示

- 让 Agent 进行大范围修改前，建议先提交或备份重要工作。
- 使用 `/permissions` 查看当前命令策略。
- 只在可信工作区或隔离环境中使用 `--yes`。
- `--yes` 不会绕过 Plan mode 的限制，也不会放行始终禁止的命令。
- 获准执行的命令使用当前操作系统账户权限，可能访问工作区之外的资源。
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
