# EASY CODE

[English](./README.md) | 简体中文

EASY CODE 是本地运行的 CLI 编程 Agent。内置模型注册表包含 Qwen、DeepSeek、Kimi K3、智谱 GLM 和 GLM Coding Plan，也可以不改源码直接加入其他 OpenAI-compatible 供应商。进入项目目录，用自然语言描述任务，即可让模型阅读代码、修改文件、运行命令与测试。

## 核心功能

- Auto / Plan / Code 工作模式，支持交互式对话和单次任务。
- 文件编辑、命令审批、测试验证与 Diff 展示。
- 自动保存会话，支持 Resume、上下文管理与项目记忆。
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

最后一步全局安装会自动准备 Podman、专用虚拟机（Windows/macOS）、沙箱基础镜像、本地检索模型与集成资源，可能需要下载和系统授权。如果 npm 报告已有 `easy-code` 启动文件，先运行 `npm run install:doctor`，按输出用旧 npm 卸载对应副本，再重新安装；不要使用 `--force`。

## 开始使用

只需配置准备使用的供应商。以下命令会隐藏输入 Key：

```bash
easy-code config set qwen.api-key
# 其他选择：deepseek.api-key、kimi.api-key、glm.api-key、glm-coding-plan.api-key
easy-code --workspace /path/to/project
```

首次安装会创建固定文件 `~/.easy_code/models.toml`。用户可在这里统一维护供应商端点、密钥环境变量名、协议（`chat_completions` 或 `responses`）、端点流式能力、模型 ID、上下文窗口、视觉/工具/reasoning 能力及 Benchmark Profile。EASY CODE 每次启动都会严格校验，并且不会覆盖已存在的文件。API Key 仍应保存在系统凭据库或配置的环境变量中，不要写入 `models.toml`。

在选择器中选择模型，然后输入任务，例如：“修复登录错误，并运行相关测试”。

沙箱随安装自动准备。直接启动 `easy-code` 时若发现缺少依赖或初始化未完成，也会自动尝试准备一次；失败后显示恢复菜单，不循环安装。系统授权或必要重启仍需用户完成。以下指令用于检查或继续初始化：

```bash
easy-code sandbox doctor
easy-code sandbox setup
easy-code sandbox resources
```

安装 EASY CODE 时会自动安装缺失的 [Podman](https://podman.io/docs/installation)、准备 Windows/macOS 专用的 rootless `easy-code` 虚拟机并构建基础镜像。复用已有 Podman，不切换默认连接。下载、系统授权或重启中断后，可用 `sandbox setup` 继续；`sandbox doctor` 检查环境。Linux 安装系统包需要权限，rootless 镜像准备必须以普通用户运行。自动安装不可用时明确报错，不退回宿主机。普通命令在持久化的 Linux 任务容器 `/workspace` 内运行，模型可经批准的 HTTP(S) 网络安装依赖。完全访问仍使用原生宿主机；Benchmark 保留离线 Harbor/Docker 执行器。

需要清理时，先检查资源列表，再用 `easy-code sandbox remove <container|volume|image> <完整名称> --yes` 永久删除单个已停止/未使用资源。项目和历史记录保留；容器/卷内容需要备份才能恢复。

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
| `/context`、`/usage`、`/help` | 查看上下文、用量和完整帮助 |

在项目 `EASYCODE.md` 中写入约定和验证命令；在 `.easycode/config.toml` 的 `[limits]` 中调整运行预算。运行 `easy-code config defaults` 查看默认值。

更多资料：[配置示例](./docs/config.example.toml) · [架构与模块技术文档](./docs/TECHNICAL_DESIGN_ZH.md) · [Benchmark 指南](./benchmarks/swebench_verified/README.md)

[MIT License](./LICENSE) · [第三方开源声明](./THIRD_PARTY_NOTICES.md)
