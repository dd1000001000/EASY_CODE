# EASY CODE

![EASY CODE — 面向终端与浏览器的本地编程 Agent](./docs/assets/easy-code-banner.png)

[English](./README.md) | 简体中文

EASY CODE 是面向本地项目的编程 Agent，提供终端和浏览器两种界面。用自然语言描述任务，即可探索代码、修改文件、运行命令并验证结果。使用你自己的模型供应商账户；内置模型注册表包含 Qwen、DeepSeek、Kimi、智谱 GLM 和 GLM Coding Plan。

## 功能

- **终端与网页交互：** 保存对话、多文件夹项目、图片输入、停止任务和运行中追加调整。
- **灵活选择模型：** 在同一对话中切换供应商、模型和思考强度；新对话默认沿用上次选择，显式指定时除外。
- **Auto、Plan、Code 模式：** 回答问题、分析方案或直接实施修改。
- **受控执行：** 命令审批、操作系统原生沙箱、文件变更检查和长时间命令管理。
- **可选多 Agent 协作：** 带依赖关系的任务图（DAG）、并行子 Agent，以及在反复验证失败时介入的独立审查。
- **持久上下文：** 对话恢复、上下文压缩、历史召回、全局记忆和项目记忆。
- **能力扩展：** 全局／项目级 Skill、本地或远程 MCP 服务器、VS Code 终端集成。
- **中英文界面：** CLI 与网页共享并保存语言偏好。

“本地”指应用、工具和历史数据在本机运行或保存。执行任务时，所选模型供应商仍会收到必要的请求上下文。

## 安装

需要 Node.js **20.11.0 或更新版本**、npm 和受支持供应商的 API Key。支持目标为 Windows、macOS 和 Linux；Git Worktree 隔离需要 Git。沙箱是否可用还取决于操作系统和硬件架构。

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm ci --ignore-scripts
npm run build
npm install --global --allow-scripts=easy-code-agent .
```

全局安装会准备检索和集成资源，需要允许该包执行安装脚本。原生沙箱使用项目固定的运行时版本，不会自动选择最新版。Windows 沙箱初始化可能需要管理员确认；普通 CLI／网页使用不需要安装虚拟机或容器引擎。

## 快速开始

### 配置供应商

以下命令会以隐藏输入的方式询问 API Key：

```bash
easy-code config set qwen.api-key
```

其他内置凭据名称为 `deepseek.api-key`、`kimi.api-key`、`glm.api-key` 和 `glm-coding-plan.api-key`，只需配置准备使用的供应商。模型供应商的 Key 保存在操作系统凭据库中，不从 TOML 或环境变量读取。

### 打开网页或终端

```bash
# 浏览器界面
easy-code --web

# 打开交互式终端；自动创建项目并把该目录作为第一个文件夹
easy-code --workspace "/path/to/project"
```

将示例路径替换为本地目录；包含空格的路径需加引号。网页服务仅监听本机回环地址。使用时保留启动它的终端，结束后从该终端停止服务。

全新安装的网页不会自动创建默认项目。先在“项目”标题旁创建空项目，展开项目并添加一个或多个本地文件夹；至少添加一个文件夹后，才能使用项目旁的 **＋** 新建对话。同一项目不能重复添加同一文件夹，也不允许添加已有文件夹的父目录或子目录。CLI 启动时会创建新项目，并把指定工作目录作为第一个文件夹。

### 选择模型并开始任务

网页使用输入框下方的模型入口；CLI 输入 `/model` 打开选择器。然后描述任务，例如：

> 找出登录失败的原因，修复问题，并运行相关测试。

执行单次终端任务或恢复已有对话：

```bash
easy-code --workspace "/path/to/project" --mode code -y run "修复登录失败的问题并运行相关测试"
easy-code --workspace "/path/to/project" --resume <thread-id>
```

交互式 CLI 和网页任务不设置固定的模型请求次数上限。对于无人值守的单次运行，可在 `run` 后添加 `--max-model-requests N`，统一限制主 Agent、子 Agent、Reviewer、审批和上下文压缩产生的模型请求总数。

`-y` 启用独立的命令审批 Agent，**不是**授予完全访问权限，也不保证整个过程无需用户决策。

## 网页使用方法

| 区域 | 操作 |
| --- | --- |
| 项目 | 先创建空项目，再通过项目的编辑入口改名、添加或移除文件夹、指定主文件夹。侧边栏只展示项目及其对话。项目仍有任务运行时不能修改文件夹。悬浮或选中已可用项目时显示新建对话操作。顶部按钮可收起整个侧栏，点击图标可重新展开。 |
| 输入框 | **Enter 发送，Shift+Enter 换行**。打开对话后才能发送；Windows、macOS、Linux 使用同一规则，输入法组字时不会误发送。 |
| 附件 | 粘贴或上传图片后显示可移除的预览。超长粘贴文本显示为预览卡片，发送时保留全文。图片需要支持视觉的模型。 |
| 运行中任务 | 输入为空时按钮用于停止；输入文字后改为发送调整，在后续安全执行边界应用。此时仍可切换项目、对话并并行运行其他任务。 |
| 模型与权限 | 输入框下方可选择模型／思考强度、批准模式和 DAG／Agent 编排。运行中不允许的变更会被禁用或拒绝。 |
| 指令 | 输入 `/` 或前缀查看带说明的匹配项；点击条目打开输入框上方的操作界面，也可直接输入并发送受支持指令。点击面板外部可关闭。 |
| 阅读进展 | Thinking 和工具条目显示单行预览与字符数，展开可查看命令内容、文件名、任务／Agent 名称等详情。紧凑导航条用于跳转到用户消息。 |
| 状态 | 顶部显示对话与运行信息，右上角卡片显示活动中的 DAG、子 Agent 和 Reviewer。通知在 15 秒后自动关闭，也可手动关闭。 |
| 语言 | 使用右上角语言选择器；与 CLI 共享偏好，不翻译已有消息或模型回答。 |

每个对话必然属于一个项目，并且只能由用户或主 Agent **自定义命名一次**，之后不能再次改名。项目显示名称可以修改，不会重命名任何已添加目录。每轮对话都会记录当时的文件夹版本，运行中不能改变项目文件夹。

删除对话会清除其历史、关联子对话及记忆贡献；涉及共享记忆时可能恢复到更早版本。删除项目还会删除项目下的对话、项目记忆、项目 Skill 和项目自有运行数据。**删除项目或移除其中一个文件夹都不会删除源码文件。** 删除前应停止活动任务，并仔细阅读确认提示。

同一项目中的并行对话共享全部已添加文件夹和沙箱边界。不要同时安排互相冲突的文件修改；对话并行不代表每个对话都有独立代码副本。多文件夹项目中的文件路径以稳定的文件夹键开头，例如 `api/src/main.ts`；命令中的 `.` 表示主文件夹。

## 工作模式、批准模式与模型

| 设置 | 含义 |
| --- | --- |
| Auto | 根据请求选择直接回答、规划或实施。 |
| Plan | 侧重调查与方案，**不是强制只读模式**。 |
| Code | 直接进行实现与验证。 |
| 手动批准 | 除适用的已保存授权外，命令需要用户批准。 |
| 审批 Agent | 独立评估命令；拒绝或无法判断时仍可能需要用户批准。 |
| 完全访问 | 移除普通宿主命令的沙箱和逐条审批，以当前账户权限执行。 |

仅在可信任务和环境中使用完全访问。普通沙箱命令可写入项目添加的所有文件夹，但限制外部写入和直接访问外网。Linux 下 thread 级服务会让后续命令复用同一受监督沙箱，因此前后端联调可以共享 localhost；经批准的 HTTP(S) 活动仍使用独立的网络审批路径。沙箱失败不会自动降级为完全访问。

DAG／子 Agent 编排默认关闭，且要求非手动批准模式。从手动批准启用时，会先询问是否切换批准模式。关闭编排不会关闭独立 Reviewer。主 Agent 可为子 Agent 分配不高于自身的思考强度。

模型注册表位于 `~/.easy_code/models.toml`，首次启动从[内置注册表](./resources/models.default.toml)创建，后续启动不会覆盖。可在其中维护兼容供应商、模型 ID 和能力；修改后需重启 EASY CODE。

思考强度影响 EASY CODE 的本地执行预算，并在受支持时传递为供应商推理设置。**“已保存，但尚未生效”表示该强度未作为供应商推理参数发送，不表示选择丢失。** 是否支持取决于模型与协议；图片能力也取决于所选模型。

## 指令

以下文字指令在 CLI 和网页都可用，网页同时提供对应的操作面板。

| 指令 | 作用 |
| --- | --- |
| `/mode plan\|auto\|code` | 切换工作模式。 |
| `/status` | 查看对话与运行状态。 |
| `/workspace list\|refresh\|add <路径>\|remove <文件夹-id>\|primary <文件夹-id>` | 查看、刷新或修改当前项目的文件夹；修改时对话必须空闲。 |
| `/tools` | 查看当前可用工具。 |
| `/skills` | 查看全局和项目级 Skill。 |
| `/mcp [server-id action]` | 管理 MCP 连接与授权；菜单中列出可用操作。 |
| `/permissions [revoke <index>]` | 查看权限／沙箱状态，或撤销已保存授权。 |
| `/context`、`/usage` | 查看上下文容量或供应商报告的 Token 用量。 |
| `/memory short [limit]` | 查看近期对话预览。 |
| `/memory long [global\|project] [id]` | 按范围或 ID 查看长期记忆。 |
| `/help` | 显示指令帮助。 |

`/language [en_us|zh_cn]` 在两种界面都可查看或切换共享语言偏好。网页通常直接使用右上角选择器。

以下文字指令**仅供 CLI 使用**，网页使用对应 UI：

| CLI 指令 | 作用／网页替代入口 |
| --- | --- |
| `/model` | 网页输入框下方的模型／思考强度选择器。CLI 还支持 `/model <model-id>` 或 `/model <provider> <model-id> [none\|low\|medium\|high]`。 |
| `/provider <provider-id>` | 切换供应商；网页使用模型选择器。 |
| `/approval [manual\|auto_approve\|unrestricted]` | 网页输入框下方的批准模式入口。 |
| `/orchestration [on\|off]` | 网页批准模式旁的 DAG／Agent 入口。 |
| `/image <path\|clipboard\|clear>` | 网页上传／粘贴图片，以及可移除的附件预览。 |
| `/sessions`、`/resume [id]`、`/new` | 网页项目／对话侧栏和项目旁的 **＋**。 |
| `/workspace list\|refresh\|add <路径>\|remove <文件夹-id>\|primary <文件夹-id>` | 仅用于 CLI 的项目文件夹管理；网页请使用项目编辑弹窗。 |
| `/clear` | 只清空终端显示，不删除历史；网页不提供此功能。 |
| `/exit` | 保存并退出 CLI；网页服务从启动终端停止。 |

不支持指令别名。未识别的斜杠文本按普通输入处理，不会作为受支持指令执行；在网页输入已识别但仅限 CLI 的指令会被拒绝。

## Skill、MCP 与记忆

**Skill** 保存可复用的说明与资源。EASY CODE 将全局 Skill 和项目 Skill 存在应用自有数据中，不再写入某个源码文件夹。每个 `SKILL.md` 需包含 YAML `name`、`description` 字段和正文说明，旁边可放参考资料、素材和脚本。用 `/skills` 查看，或让 Agent 创建、更新 Skill。Agent 的变更需要审批；删除采用归档方式。删除项目会删除该项目的 Skill，全局 Skill 仍可供其他项目使用。

**MCP** 用于接入额外工具。可让 Agent 在 `~/.easy_code/mcp.toml` 中添加或编辑服务器，再通过 `/mcp` 授权和连接；只修改配置不会自动连接。本地 stdio 服务器在工作区沙箱内运行，远程服务器支持 HTTP／SSE 及已配置的 Bearer 认证或 OAuth。除本机回环 HTTP 外，远程地址必须使用 HTTPS。MCP 调用需要审批，服务器描述本身不能授予权限。

**记忆** 不等同于 Skill 或对话历史。全局记忆保留跨项目偏好，项目记忆保留相关项目知识。Agent 可保存有价值的信息；用户可通过 `/memory` 查看，但 CLI 和网页均不支持手动修改长期记忆。上下文压缩可支持更长任务，但摘要和召回记忆不能代替对当前文件的核实。后台记忆整理可能额外请求模型并消耗 Token。

## 配置与排查

在主文件夹的 `EASYCODE.md` 中填写项目约定和验证要求。项目配置使用主文件夹内的 `.easycode/config.toml`，具体设置见[配置示例](./docs/config.example.toml)。`easy-code config defaults` 可查看默认配置。不要将 API Key 写入项目文件。

```bash
easy-code install doctor
easy-code sandbox doctor
easy-code sandbox setup
easy-code sandbox recover --workspace "/path/to/project"
```

安装检查用于排查多个全局启动器的冲突；沙箱指令用于检查、准备或核对执行状态。安装和启动不会重配 Docker、Podman 或 WSL。更新 EASY CODE 后需重启已有进程。当前开发版本不承诺兼容旧内部数据格式或已改变的提示词包；升级前请备份重要数据。

## 开发与评测

```bash
npm run build
npm run typecheck
npm test
```

架构和设计边界见[技术设计文档](./docs/TECHNICAL_DESIGN_ZH.md)。SWE-bench 的准备与运行见[评测指南](./benchmarks/swebench_verified/README.md)。评测凭据与交互式使用的凭据分开，通过 `easy-code benchmark credential set <provider>` 配置。

## 卸载

```bash
easy-code uninstall --dry-run
easy-code uninstall
```

建议先查看预演结果。确认后，卸载会移除安装拥有的配置、凭据、历史、记忆、缓存、集成资源、受管理 Worktree 和全局 CLI。`--yes` 表示不再交互确认同一操作。**没有备份就无法撤销。**

用户项目文件夹、关联源码目录和共享系统软件会保留；Windows 的共享沙箱账户不会删除。无法确认归属或不安全的资源会阻止移除或被保留，不会猜测后删除；请检查输出中的提示。

[MIT 许可证](./LICENSE) · [第三方声明](./THIRD_PARTY_NOTICES.md)
