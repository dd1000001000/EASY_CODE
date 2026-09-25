# EASY CODE

![EASY CODE — 面向终端与浏览器的本地编程助手](./docs/assets/easy-code-banner.png)

[English](./README.md) | 简体中文

EASY CODE 是运行在本地的 AI 编程助手，同时提供终端和网页界面。用自然语言描述任务，就可以让它理解项目、实现功能、排查问题并执行验证。模型使用你自己的供应商 API Key。

## 主要功能

- **终端与网页双入口**：保存对话、附加图片、展示实时进度，支持运行中补充要求。
- **按需读取文档与网页**：网页附件和工作区内受支持的文档共用同一套本地转换流程，并成为对话私有的只读资源；Agent 也可搜索公开网页，把选中的网页保存后分段读取。
- **项目管理**：一个项目可关联一个或多个本地文件夹，不同任务使用独立对话。
- **灵活选择模型**：内置 Qwen、DeepSeek、Kimi、GLM 和 GLM Coding Plan 供应商配置，模型、端点和能力均可配置。
- **本地决策（实验性）**：微调后的多语言 Laya 模型负责 Auto 模式选择，并在 Code 交付前进行一次检查。
- **可控的执行方式**：Auto、Plan、Code 工作模式；手动审批、独立审批 Agent、完全访问；原生系统命令沙箱。
- **长任务与记忆**：恢复历史对话、召回历史证据、使用全局／项目记忆，自动管理上下文容量。
- **可选的协作能力**：任务依赖图、子 Agent 分工，以及对重复验证失败的独立审查。
- **扩展工作流程**：可复用的 Skill、MCP 工具、VS Code 终端集成，支持中英文界面。

应用、历史和微调后 Laya 的决策运行在本地；编程与回答仍由你选择的云端模型完成，相关任务上下文会发送给该供应商。

## 新增：实验性本地决策

安装程序会自动启用随包提供的**微调后 Laya（joint-v2）**：

- **Auto 路由**：微调后 Laya 选择直接回答、Plan 或 Code，再由云端模型完成具体工作。
- **交付检查**：微调后 Laya 对比用户需求和 Agent 的完成摘要。放行分数默认至少 **0.90**，可在运行配置中调整；未通过时要求 Agent 复查一次。
- **共享本地服务**：多个 EASY CODE 会话共用模型实例，输入和选择记录在项目的 `.easycode/decision-traces/`。

命令审批和独立 reviewer 继续生效。详见[设计与训练方法](./docs/TECHNICAL_DESIGN_ZH.md#61-实验性本地决策模型)、[微调结果](./finetuning/laya-joint-v2/README.md)和 [微调后 Laya + GLM 实验](<./laya-bench mark/README.md>)。

## 安装

需要 **Node.js 20.11+**、**Python 3.10–3.14**、npm，以及可用的模型供应商账号。以下源码安装方式还需要 Git；Python 用于创建 EASY CODE 私有的文档转换和 Laya 决策运行环境。原生沙箱是否可用取决于操作系统和架构。

```sh
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm ci --ignore-scripts
npm run build
npm install --global --allow-scripts=easy-code-agent . --foreground-scripts
```

请确认每一步成功后再执行下一步。全局安装会准备本地检索资源、私有 Python 环境、Laya 推理、编辑器集成和原生沙箱，可能需要下载资源；Windows 可能请求管理员授权。日常使用不需要 Docker、Podman，也不需要另外安装 Codex 应用。

## 三步开始使用

### 1. 配置 API Key

例如使用 GLM Coding Plan：

```sh
easy-code config set glm-coding-plan.api-key
```

按提示输入密钥，输入内容不会显示，密钥保存在操作系统凭据库中。其他内置名称为 `qwen.api-key`、`deepseek.api-key`、`kimi.api-key`、`glm.api-key`。配置你实际要选择的供应商，不要把密钥写进项目文件。

### 2. 打开网页或终端

```sh
easy-code --web
```

网页中先创建项目、关联本地文件夹，再点击项目旁的 **＋** 创建对话，使用输入框下方的控件选择模型。附件按钮支持图片以及常见 PDF、Word、PowerPoint、表格和文本格式。文档作为该对话的只读资源保存；在 Agent 按需读取相关范围前，只会把文件名和资源路径放入提示。请保持启动终端打开；网页服务仅供本机访问。

也可以直接在终端打开项目：

```sh
easy-code --workspace "/path/to/project"
```

把示例路径换成你的本地文件夹，路径含空格时保留引号。输入 `/model` 选择模型。

### 3. 描述你希望得到的结果

> 找出登录失败的原因，修复问题并运行相关测试。最后说明修改内容，以及还有哪些没有验证。

希望先看方案时选择 Plan；直接实施选择 Code；也可以使用 Auto 自动判断。Auto 一旦选出 Plan 或 Code，当前轮立即按该模式开放工具，之后保持该模式，直到用户手动切回 Auto。无需工具即可直接回答时仍保持 Auto；新对话从 Auto 开始。**Plan 是工作方式，不是强制只读的安全边界。**

运行时若 Laya 推理失败，Auto 使用云端路由；Code 交付会提示故障，并继续执行现有任务完成检查。

## 常用操作

| 操作 | 终端 | 网页 |
| --- | --- | --- |
| 选择模型与思考强度 | `/model` | 输入框下方模型控件 |
| 选择审批模式 | `/approval` | 输入框下方审批控件 |
| 开启子 Agent | `/orchestration on` | DAG／agents 控件 |
| 查看任务、上下文和用量 | `/status`、`/context`、`/usage` | 同名命令或对应面板 |
| 查看项目记忆 | `/memory long project` | 同名命令或记忆面板 |
| 继续已有任务 | `/sessions`、`/resume <thread-id>` | 在侧栏打开对应对话 |
| 查看更多命令 | `/help` | 输入 `/` 或打开帮助 |

手动审批会在没有匹配授权时询问你；独立审批 Agent 可以代为判断，但仍可能需要人工确认。**完全访问会移除普通宿主机命令的沙箱和逐条审批**，只在你接受相关风险时使用。DAG／子 Agent 需要非手动审批模式。

执行一次性终端任务：

```sh
easy-code --workspace "/path/to/project" --mode code -y run --max-model-requests 40 "修复登录失败问题并运行相关测试"
```

`-y` 表示使用审批 Agent，**不是完全访问**。可选的请求次数上限包含辅助 Agent 和上下文压缩；交互式 CLI／Web 没有固定的模型请求次数上限。

## 文档、设置与卸载

- [架构与详细使用手册](./docs/TECHNICAL_DESIGN_ZH.md)：项目、审批、记忆、Skill、MCP、使用示例与故障排查。
- [配置参考](./docs/config.example.toml)：运行参数。模型和端点位于 `~/.easy_code/models.toml`，修改后重启生效。
- [SWE-bench 使用说明](./benchmarks/swebench_verified/README.md)：独立的 Docker 评测环境与凭据配置。

```sh
easy-code install doctor
easy-code sandbox doctor
easy-code sandbox setup
```

前两个命令用于诊断安装和沙箱状态，需要准备沙箱时再运行 setup。沙箱不可用时不会自动改为宿主机直接执行。

```sh
easy-code uninstall --dry-run
easy-code uninstall
```

确认后会删除属于 EASY CODE 的配置、凭据、历史、记忆等资源，请先备份需要保留的内容。用户项目文件夹、链接的源码目录和共享系统软件不会删除。

[MIT 许可证](./LICENSE) · [第三方许可声明](./THIRD_PARTY_NOTICES.md)
