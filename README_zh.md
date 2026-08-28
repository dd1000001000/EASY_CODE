# EASY CODE

[English](./README.md) | 简体中文

EASY CODE 是一个支持 Alibaba Qwen、DeepSeek 和 GLM 的本地 CLI 编程 Agent。它可以在受控工作区内读取、新建、更新和删除代码，运行命令，管理上下文与记忆，并向视觉模型发送图片。

当前版本是 MVP，仅提供终端界面，不会打开单独的桌面窗口。

## 运行环境

- Windows、macOS 或 Linux。
- Node.js `>=16.20.0` 和 npm。建议使用仍受维护的 Node.js LTS。
- Alibaba Qwen、DeepSeek 或 GLM API Key。
- 可选：VS Code `>=1.93`，用于在集成终端中通过系统原生粘贴快捷键输入图片。

EASY CODE 使用 SQLite WASM 持久保存 Thread 和长期记忆，并用嵌入式 Orama 向量索引完成语义 Top-K 检索。本地多语言向量模型通过 ONNX Runtime 运行，不需要 Python、外部向量数据库、Redis 或模型服务。

## 安装

### 从源码全局安装

项目当前尚未发布到 npm Registry，请从 GitHub 源码安装：

```bash
git clone https://github.com/dd1000001000/EASY_CODE.git
cd EASY_CODE
npm install
npm run build
npm install --global .
easy-code --version
```

如果使用 SSH，也可以克隆 `git@github.com:dd1000001000/EASY_CODE.git`。

全局安装成功后，可以进入任意项目目录运行 `easy-code`；当前目录会成为默认工作区。

更新或重新安装：

```bash
git pull
npm install
npm run build
npm install --global .
```

不全局安装时，可以在 EASY CODE 源码目录运行：

```bash
npm install
npm run build
npm start -- --workspace /path/to/project
```

普通 npm 安装会依次完成 SQLite 自检，把固定版本的量化向量模型资源（约 135 MB）下载到 EASY CODE 的系统用户缓存，校验精确大小和 SHA-256，实际运行一次本地 ONNX/向量检索自检，然后尝试安装随包提供的 VS Code 图片粘贴扩展。安装完成后的向量推理完全离线，记忆文本不会发送给 Hugging Face。

正常安装不要使用 `--ignore-scripts`，否则会跳过必需的模型准备。在 EASY CODE 源码目录可以使用以下命令修复或校验本地记忆模型：

```bash
npm run memory:install
npm run memory:verify
```

如果自动检测不到便携版或自定义位置的 VS Code，可运行：

```bash
npm run vscode:install
```

CI 或托管环境可设置 `EASY_CODE_SKIP_VSCODE_EXTENSION=1` 跳过扩展安装。自定义 VS Code CLI 可通过绝对路径环境变量 `EASY_CODE_VSCODE_CLI` 指定。

## 配置 API Key

推荐使用下面的命令，把 Key 保存到操作系统凭据存储：

```bash
easy-code config set qwen.api-key
easy-code config set deepseek.api-key
easy-code config set glm.api-key
easy-code config list
```

`config set` 会隐藏终端输入，而且不接受把 Key 直接写在命令参数中，以免泄漏到 Shell 历史或进程列表。还可以查看或移除配置状态：

```bash
easy-code config get qwen.api-key
easy-code config unset qwen.api-key
easy-code config get glm.api-key
easy-code config unset glm.api-key
```

也可以使用环境变量：

| Provider | 环境变量 |
| --- | --- |
| Alibaba Qwen | `QWEN_API_KEY` 或 `DASHSCOPE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| GLM | `ZAI_API_KEY`（推荐）、`GLM_API_KEY` 或 `ZHIPUAI_API_KEY` |

PowerShell 示例：

```powershell
$env:QWEN_API_KEY = "your-api-key"
$env:DEEPSEEK_API_KEY = "your-api-key"
$env:ZAI_API_KEY = "your-api-key"
```

macOS/Linux 示例：

```bash
export QWEN_API_KEY="your-api-key"
export DEEPSEEK_API_KEY="your-api-key"
export ZAI_API_KEY="your-api-key"
```

首次交互启动时，如果选中的 Provider 尚未配置 Key，EASY CODE 也会提示隐藏输入并保存。这里会检查输入和凭据存储读回；账户权限、区域和模型是否真正可用，会在第一次 API 请求时由 Provider 确认。

不要把 API Key 写入项目配置、`EASYCODE.md`、源码、聊天内容或 Git 提交。

## 在终端中使用

进入要处理的项目目录，然后启动 Agent：

```bash
cd /path/to/project
easy-code
```

EASY CODE 会占用当前终端，不会弹出另一个 Agent 窗口。普通启动流程如下：

1. 选择 `DeepSeek`、`Alibaba Qwen` 或 `GLM`。
2. 选择该 Provider 下的模型。
3. 选择思考强度：`none`、`low`、`medium` 或 `high`。
4. 使用上下方向键移动，按 Enter 确认，按 Esc 取消。
5. 在 `EASY CODE [auto qwen/qwen3.7-max thinking:medium] >` 一类提示符后输入任务。

`/help` 是 Agent 内部命令，只能在提示符出现后输入。查看程序参数应在 Shell 中运行：

```bash
easy-code --help
```

显式指定工作区、Provider、模型、思考强度和模式：

```bash
easy-code --workspace ./my-project --provider qwen --model qwen3.7-plus --thinking-effort high --mode code
```

运行一次任务并退出，适合脚本或 CI：

```bash
easy-code --workspace ./my-project --mode code run "Fix the login error and run the relevant tests"
```

恢复历史 Thread：

```bash
easy-code --resume <thread-id>
```

常用顶层参数：

| 参数 | 作用 |
| --- | --- |
| `-w, --workspace <path>` | 指定工作区，默认为当前目录 |
| `--provider qwen\|deepseek\|glm` | 指定 Provider |
| `--model <id>` | 指定当前 Provider 的模型 |
| `--thinking-effort none\|low\|medium\|high` | 指定思考强度，默认为 `medium` |
| `--mode plan\|auto\|code` | 指定工作模式，默认为 `auto` |
| `--approval safe\|ask\|never` | 指定命令审批策略 |
| `-y, --yes` | 自动批准策略允许但原本需要询问的命令 |
| `--resume <thread-id>` | 恢复历史 Thread |
| `-i, --image <path>` | 为第一个任务添加图片，可重复使用 |

## 支持的 Provider 和模型

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
| GLM | `glm-5.3-flash` | 支持 |
| GLM | `glm-5.3` | 不支持 |
| GLM | `glm-5.2` | 不支持 |

这是 EASY CODE 当前内置的模型目录，不是 Provider 的实时模型发现结果。模型能否实际调用仍取决于 Provider 服务、账户、区域和模型权限；失败时会显示 API 返回的错误。

在 GLM 模型中，只有 `glm-5.3-flash` 支持图片输入；`glm-5.3` 和 `glm-5.2` 在 EASY CODE 中仅支持文本。

### 思考强度

选择模型后，交互菜单会继续要求选择 `none`、`low`、`medium` 或 `high` 四档标准化思考强度。该选择会随当前 Thread 保存，并用于构造包括 Auto mode 路由在内的每次模型请求。也可以在启动时使用 `--thinking-effort` 指定；未指定时默认为 `medium`。

该选择还会决定每条用户任务最多可以进行多少次模型请求：`none` 和 `low` 为 40 步，`medium` 为 80 步，`high` 为 120 步。即使所选模型不支持思考参数，这个 Agent 循环预算仍然按照用户保存的档位生效。显式配置的 `max_steps` 或环境变量 `EASY_CODE_MAX_STEPS` 只作为更低的硬上限，不能把任何档位提高到其内置预算以上。

所有模型都会显示这四个选项。EASY CODE 只会向 Provider 发送该精确模型已经明确支持的字段。如果模型不支持可配置思考，选择仍会保留在界面和 Thread 中，但请求不会携带思考参数，因此不会生效。

各 Provider 的行为：

- Alibaba Qwen：对于支持混合思考的模型，`none` 会关闭思考；`low`、`medium`、`high` 会开启思考，并分别使用 EASY CODE 定义的 4,096、16,384、32,768 个推理 Token 上限。这些值是输出上限，不表示模型一定会用满。由于 `qwen3.6-max` 的精确模型 ID 尚未被官方文档列入该能力，目前不会向它发送思考参数。
- DeepSeek：对于 `deepseek-v4-flash` 和 `deepseek-v4-pro`，`none` 会关闭思考，`low` 和 `high` 使用同名 Provider 档位；DeepSeek 会把 `medium` 按 `high` 处理。实验性视觉模型目前不会收到思考参数。
- GLM：`glm-5.2` 可通过 `none` 关闭思考，也接受另外三档，但 GLM 会把 `low` 和 `medium` 映射为自身的 `high`。`glm-5.3` 和 `glm-5.3-flash` 始终进行思考，因此选择 `none` 时只保留该选择，不发送关闭参数；它们的 `medium` 会映射为 `high`。

当所选强度不是 `none`，并且 Provider 返回了 `reasoning_content` 时，EASY CODE 会保留灰色的 `Thinking #2` 标记，并在下一行用灰色自动显示最多 160 个字符的单行预览；内容更长时以 `...` 结尾。可以使用 `/thinking`、`/thinking <id>` 或 `Ctrl+T` 查看展开后的受限内容。在 VS Code 集成终端中，随 npm 安装的扩展仍可让标记变为可点击链接，但现在无需依赖点击。预览和展开内容都会先进行控制字符清理与敏感信息脱敏。非交互式 `easy-code run` 不输出这套交互展示。

运行中可以切换 Provider 或模型：

```text
/model
/model <model-id>
/model qwen <model-id>
/model deepseek <model-id>
/model glm glm-5.3-flash
/provider qwen
/provider deepseek
/provider glm
```

直接输入 `/model` 会重新打开 Provider → Model → 思考强度三级菜单；`/model <model-id>` 等带参数形式会直接切换并保留当前思考强度。如果目标 Provider 缺少 API Key，EASY CODE 会提示配置。

## 三种工作模式

| 模式 | 行为 |
| --- | --- |
| `plan` | 只读取和调查工作区，然后提交结构化计划供用户审核；禁止写文件、构建、测试和安装依赖。 |
| `auto` | 使用一次独立模型调用，通过 `select_mode` 工具选择 Plan 或 Code；不再使用本地关键词匹配。 |
| `code` | 无需预先展示计划，直接实现并验证；安全策略仍然生效。 |

在交互过程中切换：

```text
/mode plan
/mode auto
/mode code
```

Auto 选择 Plan 后，规划模型必须调用 `propose_plan`；普通回复文本不能冒充可批准的计划。CLI 随后展示：

```text
1. Yes, use Auto mode
2. No, reject plan
3. Type feedback and press Enter to adjust the plan
```

选择 Yes 会记录批准并切回 Auto 执行；选择 No 会记录拒绝且不再调用模型；输入任意其他非空提示词会作为调整意见交给 Plan 模型，模型提交新版计划后再次显示菜单。待审核和已批准的计划状态属于 Thread，可通过 `/resume` 恢复。非交互式 `easy-code run` 只输出计划与 Thread ID，不会等待输入；`--yes` 不会自动批准计划。

## 已有功能

主提示符会显示短期记忆的估算 Token 数，例如 `context:12.4k`。统计范围包括持久化上下文摘要、当前有效的对话与工具消息、返回到上下文中的 Thinking 内容以及有效图片的 Token 估算。由于不同模型的 tokenizer 不同，该数值是近似值。

在交互式终端中等待模型 API 返回时，EASY CODE 会显示灰色旋转动画和已等待时间。Auto mode 路由及 Agent 循环中的每次模型请求都会显示；请求成功、失败或被中断时自动清除。管道输出和 CI 环境仍保持静态文本。

### Agent 工具

主 Agent 最多可以调用十个 Runtime 工具；Auto 路由是一次独立模型请求，只暴露 `select_mode`。`read_image` 只会提供给代码中已确认支持视觉的模型。

| 工具 | 功能 |
| --- | --- |
| `read_file` | 分段读取工作区内的 UTF-8 文件 |
| `read_image` | 读取并校验工作区图片，发送给视觉模型 |
| `create_file` | 新建文件；目标已存在时不会覆盖 |
| `update_file` | 精确替换或删除已读取文件中的代码，并检查内容哈希 |
| `delete_file` | 删除已经读取且路径、内容哈希仍然匹配的整个文件 |
| `run_command` | 使用结构化 `program + args[]` 运行受策略控制的命令 |
| `manage_tasks` | 按需创建和推进可持久恢复的单 Agent 任务 DAG |
| `propose_plan` | 提交 Plan mode 的结构化计划并等待用户审核 |
| `compact_context` | 由模型提交累计摘要并推进上下文压缩边界 |
| `manage_memory` | 搜索并暂存长期记忆的新建、修订或退休操作 |

`delete_file` 必须携带 `read_file` 返回的 SHA-256。未读取文件、过期哈希、目录、链接、工作区逃逸路径，以及 Plan mode 中的删除都会被拒绝。

### 工作区和代码变更

- 文件工具只能访问工作区内的路径；绝对路径、`..` 穿越、符号链接和 Windows junction 逃逸会被拒绝。
- `update_file` 和 `delete_file` 会校验最近读取时的 SHA-256；文件被编辑器或其他进程改动后不会静默修改。
- 新建、更新或删除文件后，终端会显示带旧/新行号的 Diff：新增行绿色，删除行红色。
- `/changes` 可以查看当前 Thread 的文件变化。

### 可选任务编排

在 Code mode 中，或 Auto mode 已选择 Code 后，模型可以针对真正复杂的目标调用 `manage_tasks`。它会创建一张结构固定的 DAG，其中包含任务 ID、依赖、输入、预期产物、完成检查和失败处理。是否启用编排由模型根据复杂度决定；只制定计划、简单解释、小范围修复和短线性任务仍然直接执行，不会强制建立 DAG。

DAG 创建后由 Runtime 而不是提示词强制执行：同时最多一个任务处于 `in_progress`，依赖未完成的节点不能启动，文件及命令工具必须绑定到活动节点，并且每条完成检查都必须记录一项简短、具体的证据后才能标记完成。Runtime 会校验状态转换和证据结构，模型仍须依据真实工具结果填写证据。DAG 仍为 `active` 时，模型直接给最终答案会被拒绝。如果遇到真实的外部条件阻塞，可以暂停图；条件解决后，后续 Turn 可恢复该节点继续执行。Auto mode 会以 Code mode 继续尚未完成的 DAG；在 DAG 完成前，`/mode plan` 会被拒绝。

每次 DAG 状态成功变化后，终端都会按顺序显示任务列表：`✓` 表示已完成，`▶` 表示正在执行，`□` 表示尚未开始，`⊠` 表示任务已阻塞。用户也可以随时使用 `/tasks` 查看同一个视图。

当前 DAG 属于 Thread 级短期状态。声明的操作和转换后的完整快照会与对应工具结果原子写入同一条事件；恢复时会重新执行该操作，并拒绝与合法结果不一致的快照。`/resume` 可以恢复 DAG，上下文压缩后仍会向每次模型请求注入紧凑的权威控制视图。用户可通过只读的 `/tasks` 查看，只有模型工具能够改变 DAG。首版严格串行执行节点，不会启动额外智能体。

### 命令和 npm

- `run_command` 底层使用结构化参数和 `shell: false`；需要 Shell 语法时，模型必须显式调用一次性 `cmd /c`、PowerShell `-Command` 或 `sh -c`。
- 命令按 `allow`、`ask` 或 `deny` 分类，并记录调用、工作目录、结果和文件变化。
- Auto/Code mode 支持受限的工作区本地 npm 安装；Agent 发起的安装会禁用依赖生命周期脚本、audit 和 fund。
- `--yes` 可以自动批准策略允许的询问项，但不会绕过 Plan mode 或硬性拒绝规则。

### 图片输入

在安装了随包扩展的 VS Code 集成终端中，可以使用三个平台的原生快捷键：

- Windows：`Ctrl+V`
- Linux：`Ctrl+Shift+V`
- macOS：`Command+V`

图片会在输入行显示为 `[Image #1]`、`[Image #2]`，编号在同一 Thread 中持续递增。普通文本仍按 VS Code 原生方式粘贴。

其他终端可能在按键到达 CLI 前拦截粘贴快捷键，可使用以下稳定入口：

```text
/image clipboard
/image ./path/to/screenshot.png
/image clear
```

也可以在启动时使用 `--image <path>`。目前支持完整、非动画的 PNG、JPEG、WebP 和静态 GIF；每个 Thread 以及单次模型请求最多可包含 99 张图片，同时继续受总计 20 MiB 和 8,000 万像素的安全限制。只有表中标记“支持”的视觉模型才能接收图片。Qwen 还有额外尺寸和格式限制，并且不接受 GIF。

剪贴板截图会复制到工作区之外的 EASY CODE 私有数据目录；Thread 日志和 SQLite 只保存受控引用和元数据，不保存图片 Base64。

### 上下文、记忆和 Thread

- 上下文由字符、输出和图片预算控制。模型可以调用 `compact_context` 生成可继续工作的累计摘要；超过硬限制时还有请求级兜底截断。
- 短期记忆与当前 Thread 绑定，包括对话、工具结果、文件版本、变更集、当前任务 DAG 和 Working Summary。
- 长期记忆按工作区隔离。模型通过 `manage_memory` 搜索、记住、修订或退休持久偏好、约定、决策、已验证架构和稳定环境信息。每条记忆只保存一个不超过 120 字符的原子事实；完成搜索后，模型可以并列调用多次 `remember`，在一个 Turn 中保存最多八条独立事实，最后整组原子提交，而不是合并成长段落。
- 长期记忆采用混合检索：把 384 维语义相似度和 FTS5 关键词结果一起重排。SQLite 持久保存记忆行和 Float32 向量，Orama 是可以随时重建、按 generation 跨进程失效的内存 Top-K 索引。
- 向量由固定版本的量化模型 [`Xenova/paraphrase-multilingual-MiniLM-L12-v2`](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2) 在本地生成。旧数据库中的既有记忆会在第一次检索时自动补齐向量。
- 记忆修改会在当前 Turn 中暂存，只有结果为 `success` 或 `planned` 时才原子提交；失败、中断或达到步骤上限的 Turn 会丢弃候选。修订会保留被取代的旧记录，遗忘只会把记录标记为过期，不会物理删除审计历史。
- 记忆仍然完全自动维护；用户可以通过 `/memory short` 和 `/memory long` 查看，但没有手动添加、修改或删除记忆的命令。
- Thread 使用追加式 JSONL 保存原始事件，SQLite WASM/FTS5 保存可检索投影、长期记忆和持久向量；支持列出和恢复会话。
- 跨进程锁和 Thread lease 会阻止两个 EASY CODE 进程同时恢复同一个 Thread。

### 系统提示词和项目约定

每次模型调用都会重新构建系统提示词，其中包含当前本地/UTC 时间、IANA 时区、系统语言和 Locale、操作系统、CPU 架构、Shell、当前目录、工作区、模式、Provider 和模型。

EASY CODE 会读取用户配置目录中的 `EASYCODE.md`，以及工作区根目录到当前目录沿途的 `EASYCODE.md`。这些文件适合记录构建命令、代码风格和项目约定，但不能扩大 Agent 权限。

## 常用交互命令

```text
/mode plan|auto|code       切换工作模式
/provider qwen|deepseek|glm  切换 Provider
/model                     打开 Provider 和模型选择菜单
/model <model>             切换当前 Provider 的模型
/model <provider> <model>  同时切换 Provider 和模型
/status                    查看当前状态
/workspace                 查看工作区摘要
/workspace refresh         刷新工作区清单
/image <path>              为下一个任务附加图片
/image clipboard           读取剪贴板图片
/image clear               清除尚未发送的图片
/changes                   查看当前 Thread 的文件变化
/tasks                     查看当前模型管理的任务 DAG
/tools                     查看当前工具
/permissions               查看命令权限和沙箱状态
/commands                  查看最近命令
/context                   查看上下文预算
/memory short              查看自动短期记忆
/memory long               查看自动长期记忆
/memory long <id>          查看一条长期记忆
/thinking [id|last]        展示展开后的模型 Thinking
/sessions                  列出历史 Thread
/resume <id>               恢复 Thread
/new                       新建 Thread
/clear                     清屏
/help                      显示帮助
/exit                      保存并退出
```

## 安全边界

EASY CODE 有工作区路径保护、命令分类、审批、环境变量过滤和审计，但当前没有操作系统级进程沙箱。

- 文件工具受工作区边界限制。
- 获准执行的命令仍拥有启动 EASY CODE 的当前系统用户权限，也可能访问网络或工作区外资源。
- 显式 Shell 能执行复杂命令；`--yes` 只应在可信工作区、容器、虚拟机或低权限环境中使用。
- `--yes` 不会绕过 Plan mode 和硬性拒绝规则。
- 对不可信仓库，建议先提交或备份现有改动，并保持人工审批。

## 常见问题

- 找不到 `easy-code`：确认 npm 全局 bin 目录已加入 `PATH`，或在本地依赖场景使用 `npx easy-code`。
- 缺少 API Key、401 或 403：运行 `easy-code config list`，确认当前 Provider、Key、账户和区域匹配。
- 图片快捷键无反应：确认已安装 `dd1000001000.easy-code-image-paste`，必要时运行 `npm run vscode:install` 并执行 VS Code 的 `Developer: Reload Window`；备用入口是 `/image clipboard`。
- 语义记忆降级为关键词检索：重新安装且不要使用 `--ignore-scripts`；也可以在 EASY CODE 源码目录依次运行 `npm run memory:install` 和 `npm run memory:verify`。
- 命令被拒绝：运行 `/permissions` 查看模式和审批策略。Plan mode 不允许写入或执行构建；需要无人值守审批时用 `--yes`，但硬性拒绝仍然有效。
- Node.js 版本过低：运行 `node --version`，最低版本是 `16.20.0`；切换 Node.js 后重新执行 `npm install`。

## 开发验证

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```
