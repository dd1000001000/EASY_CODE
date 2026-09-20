# EASY CODE

[English](./README.md) | 简体中文

EASY CODE 是本地运行的 CLI 编程 Agent。内置模型注册表包含 Qwen、DeepSeek、Kimi K3、智谱 GLM 和 GLM Coding Plan，也可以不改源码直接加入其他 OpenAI-compatible 供应商。进入项目目录，用自然语言描述任务，即可让模型阅读代码、修改文件、运行命令与测试。

## 核心功能

- Auto / Plan / Code 工作模式，支持交互式对话和单次任务。
- 文件编辑、命令审批、测试验证与 Diff 展示。
- 自动保存会话，支持 Resume、上下文管理、全局用户记忆与项目记忆。
- 可复用的用户级和项目级 Skill，支持 Agent 按需发现、读取和维护。
- 可选 DAG / 子 Agent 协作；支持视觉模型图片输入与 VS Code 终端增强。

## 安装

需要 Node.js **>=20.11.0**、npm，以及一个受支持供应商的 API Key。支持 Windows、macOS、Linux；使用 Worktree 需要 Git。

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm ci --ignore-scripts
npm run build
npm install --global --allow-scripts=easy-code-agent .
```

最后一步全局安装会准备本地检索和集成资源，并解析安装时可用的最新版 `@openai/codex` 原生沙箱 Runtime。Windows 首次使用需要管理员确认，以建立专用离线身份；macOS 使用 Seatbelt；Linux 使用 bubblewrap/seccomp。普通 CLI 命令不再要求安装虚拟机或容器引擎。

## 开始使用

只需配置准备使用的供应商。以下命令会隐藏输入 Key：

```bash
easy-code config set qwen.api-key
# 其他选择：deepseek.api-key、kimi.api-key、glm.api-key、glm-coding-plan.api-key
easy-code --workspace /path/to/project
```

首次安装会创建固定文件 `~/.easy_code/models.toml`。用户可在这里统一维护供应商端点、协议（`chat_completions` 或 `responses`）、端点流式及 `tool_stream` 能力、模型 ID、上下文窗口、视觉/工具/reasoning 能力及 Benchmark Profile。EASY CODE 每次启动都会严格校验，并且不会覆盖已存在的文件。供应商 API Key 只保存在系统凭据库，并绑定对应端点；环境变量和 TOML 不再提供 Key。Benchmark 使用独立的凭据库命名空间，通过 `easy-code benchmark credential set <provider>` 设置。

在选择器中选择模型，然后输入任务，例如：“修复登录错误，并运行相关测试”。

安装时会检查沙箱。直接启动 `easy-code` 时若发现 Windows 一次性初始化未完成，也会自动尝试一次；失败后显示恢复菜单，不循环安装。以下指令用于检查、继续初始化或核对未完成命令：

```bash
easy-code sandbox doctor
easy-code sandbox setup
easy-code sandbox recover --workspace /path/to/project
```

普通命令在当前项目上由平台原生沙箱执行：允许写工作区，禁止写工作区外路径，默认禁止直接访问外网；获批的 HTTP(S) 下载经过 Runtime 网络门。完全访问会明确绕过沙箱；Benchmark 仍限制在离线 Harbor/Docker 容器内，不会静默回退宿主机。

单次运行或恢复会话：

```bash
easy-code --workspace /path/to/project --mode code -y run "修复登录错误并验证"
easy-code --workspace /path/to/project --resume <thread-id>
```

`auto` 自动选择处理方式；`plan` 以调查和方案为主，**不是强制只读**；`code` 直接实施。

`/approval` 切换请求批准、帮我批准或完全访问。`-y` 启用独立审批 Agent，不等于全部允许。**完全访问会取消普通 CLI 命令的沙箱与逐条审批，请仅在可信环境使用。**

## 常用操作

| 命令 | 用途 |
| --- | --- |
| `/model`、`/mode` | 切换模型、工作模式 |
| `/approval`、`/permissions` | 切换审批方式、查看与撤销授权 |
| `/orchestration`、`/tasks`、`/agents` | 开关与查看 DAG / 子 Agent |
| `/sessions`、`/resume`、`/new` | 查看、恢复、新建会话 |
| `/image ./screenshot.png` | 向支持视觉的模型附加图片 |
| `/mcp` | 查看、授权、连接、断开或移除 MCP Server |
| `/skills` | 列出用户级与项目级 Skill |
| `/context`、`/usage`、`/help` | 查看上下文、用量和完整帮助 |

可让 Agent 创建、修改或删除 Skill，也可手动放到 `~/.easy_code_skills/<名称>/SKILL.md`（用户级）或 `<项目根目录>/.easy_code_skills/<名称>/SKILL.md`（同项目跨 Thread 共享）。`SKILL.md` 需包含 YAML 格式的 `name`、`description` 和后续操作说明；可用 `references/`、`assets/`、`scripts/` 存放辅助内容。`/skills` 列出两处 Skill。Agent 修改 Skill 需经过工具审批；删除时会归档以便恢复。

可以让 Agent 添加或修改 MCP Server，再用 `/mcp` 批准并连接。配置保存在 `~/.easy_code/mcp.toml`。本地 Server 使用 stdio，在工作区沙箱内运行，默认不能直接联网。远端 Server 支持 Streamable HTTP 和旧版 SSE，要求 HTTPS（本机回环地址可用 HTTP），可使用环境变量中的 Bearer Token 或交互式 OAuth 授权。OAuth 会自动打开授权链接；等待时可按 Ctrl+C 取消。凭据保存在操作系统凭据库，不写入配置文件。每次 MCP 工具调用都需批准。

在项目 `EASYCODE.md` 中写入约定和验证命令；在 `.easycode/config.toml` 的 `[limits]` 中调整运行预算。运行 `easy-code config defaults` 查看默认值。

## 卸载

~~~sh
easy-code uninstall --dry-run
easy-code uninstall
~~~

卸载只确认一次：输入 `y` 后删除当前用户的配置、普通及 Benchmark API Key 条目、会话与记忆、缓存、终端插件、托管 Worktree 和全局 CLI。`--yes` 无交互确认同一份清单；`--dry-run` 查看所有具体目标。用户项目、链接的源码仓库、Benchmark 项目和共享系统软件保留。Windows 上游原生沙箱使用的系统账户属于共享 OS 基础设施，不归 EASY CODE 所有，因此不会在卸载时删除。

更多资料：[配置示例](./docs/config.example.toml) · [架构与模块技术文档](./docs/TECHNICAL_DESIGN_ZH.md) · [Benchmark 指南](./benchmarks/swebench_verified/README.md)

[MIT License](./LICENSE) · [第三方开源声明](./THIRD_PARTY_NOTICES.md)
