# EASY CODE

EASY CODE 是一个仅运行在终端中的本地编程 Agent。它使用 Qwen 或 DeepSeek 的 OpenAI 兼容 API，在指定工作区内读取、新建、更新文件，并通过受控的命令工具运行检查、构建、测试和严格限定的 npm 安装。

当前版本是 MVP，重点是让工具调用、工作区边界、命令审批、上下文压缩和自动记忆形成一个可恢复的完整闭环。

## 运行要求

- Node.js **16.20.0 或更高版本**。npm 包声明这一兼容范围，CLI 启动时也会检查并拒绝更低版本。Node.js 16 已经 EOL，只作为 EASY CODE 的最低兼容性基线；新安装推荐使用当前仍受维护的 Node.js 22 或 24。
- npm。
- Windows、macOS 或 Linux。
- Qwen 或 DeepSeek API Key。

先确认版本：

```bash
node --version
npm --version
```

EASY CODE 不依赖外部数据库服务。npm 包自带 `node-sqlite3-wasm@0.8.60` 的 SQLite WASM 运行时；数据库部分不含 Node 原生 ABI 插件，也不需要 Python、C/C++ 编译器或平台构建工具。API Key 的系统凭据存储由 `@napi-rs/keyring@1.3.0` 提供，并随 npm 安装当前平台的预编译 N-API 二进制。安装 EASY CODE 自身时，npm 会运行本包的 `postinstall` 脚本，打开内存 SQLite，并分别创建普通表和 FTS5 虚拟表以验证运行时；第一次实际启动时才会在当前平台的应用数据目录中创建持久数据库、执行迁移并创建会话目录。

## 安装

### 从当前源码安装

当前可直接从源码目录全局安装：

```bash
npm install
npm run build
npm install --global .
easy-code --help
```

也可以不做全局安装，直接在源码目录中运行：

```bash
npm install
npm run build
npm start -- --workspace .
```

### 发布后的 Registry 安装

EASY CODE 当前尚未发布到 npm Registry。发布后可使用以下命令全局安装：

```bash
npm install --global easy-code-agent
easy-code --help
```

发布后也可以安装为项目开发依赖：

```bash
npm install --save-dev easy-code-agent
npx easy-code --workspace .
```

## 配置 API Key

默认 Provider 是 Qwen。推荐使用类似 Git 配置命令的方式，把 Key 写入操作系统凭据存储：

```bash
easy-code config set qwen.api-key
# 或
easy-code config set deepseek.api-key
```

命令会在 TTY 中隐藏输入；在脚本或 CI 中也可以通过标准输入传入。`config set` 不接受命令行中的 Key 值，避免它进入 Shell 历史或进程参数。以下命令只显示配置状态和来源，绝不会显示 Key 本身：

```bash
easy-code config get qwen.api-key
easy-code config list
easy-code config unset qwen.api-key
```

Windows 使用 Credential Manager，macOS 使用 Keychain。Linux 会先尝试 Secret Service；不可用时，底层库会回退到内核 keyutils，后者可能只在当前登录会话内有效。无桌面会话、容器或受限 Linux 环境若无法使用凭据存储，请改用环境变量。

也可以直接使用环境变量；环境变量的优先级高于系统凭据存储：

| Provider | API Key | 默认模型 | 默认 Base URL |
| --- | --- | --- | --- |
| Qwen | `QWEN_API_KEY`，也兼容 `DASHSCOPE_API_KEY` | `qwen3-coder-plus` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` | `https://api.deepseek.com` |

macOS/Linux：

```bash
export QWEN_API_KEY="your-api-key"
# 或
export DEEPSEEK_API_KEY="your-api-key"
```

PowerShell：

```powershell
$env:QWEN_API_KEY = "your-api-key"
# 或
$env:DEEPSEEK_API_KEY = "your-api-key"
```

还可以通过以下环境变量覆盖连接参数：

| Qwen | DeepSeek | 用途 |
| --- | --- | --- |
| `QWEN_MODEL` | `DEEPSEEK_MODEL` | 模型 ID |
| `QWEN_BASE_URL` 或 `DASHSCOPE_BASE_URL` | `DEEPSEEK_BASE_URL` | OpenAI 兼容 API 地址 |
| `QWEN_TIMEOUT_MS` | `DEEPSEEK_TIMEOUT_MS` | 请求超时 |
| `QWEN_MAX_RETRIES` | `DEEPSEEK_MAX_RETRIES` | 最大重试次数 |

不要把 API Key 写进项目的 `.easycode/config.toml`、`EASYCODE.md`、源码、聊天内容或提交记录。工作区配置会拒绝 API Key、Base URL 和数据目录等信任根字段。旧版本用户级 `config.toml` 中的 Key 仍可读取以便迁移，但新配置不会再把 Key 写入 TOML。

## 快速开始

进入项目目录后启动交互模式：

```bash
cd your-project
easy-code
```

EASY CODE 不会打开新的终端窗口；交互式 Agent 会占用当前终端，并显示类似 `EASY CODE [auto qwen/qwen3-coder-plus] >` 的提示符。Shell 中查看 CLI 帮助使用 `easy-code --help`；`/help` 只能在 Agent 提示符出现后输入，不能写成 `easy-code /help`。

或者显式指定工作区和 Provider：

```bash
easy-code --workspace ./your-project --provider qwen --mode auto
```

执行一次任务并退出：

```bash
easy-code --workspace ./your-project --provider deepseek --mode code run "修复登录接口的空指针问题并运行相关测试"
```

交互模式要求真实 TTY。脚本、管道和 CI 中请使用 `easy-code run "<task>"`，不要向根交互命令管入多行指令。非 TTY 环境无法显示交互审批：策略判定为 `ask` 的命令会被拒绝；如果可信的 CI 任务确实需要执行这类命令，必须显式传入 `--yes`，例如 `easy-code --yes run "<task>"`。

顶层参数如下：

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--workspace <path>` | 工作区根目录 | 当前目录 |
| `--provider qwen\|deepseek` | Provider | `qwen` |
| `--model <id>` | 覆盖当前 Provider 的模型 | Provider 默认模型 |
| `--mode plan\|auto\|code` | 工作模式 | `auto` |
| `--approval safe\|ask\|never` | 命令审批策略 | `safe` |
| `--yes` | 自动同意原本需要交互确认的命令 | 关闭 |
| `--resume <thread-id>` | 恢复已保存的 Thread | 新建 Thread |

`--yes` 不会绕过硬性拒绝规则或 Plan mode 限制，但会减少人工检查机会。只应在可信工作区和受隔离的自动化环境中使用。

## 三种工作模式

交互过程中使用 `/mode` 切换模式；使用 `/model` 查看或切换 Provider/模型，二者不是同一件事。

| 模式 | 行为 |
| --- | --- |
| `plan` | 读取工作区并执行策略认可的只读调查，然后给出可执行计划；禁止写文件、构建、测试和安装依赖。 |
| `auto` | Agent 先判断任务是否足够明确，再选择只给计划或直接编码。直接编码时仍受工具、命令策略和审批约束。 |
| `code` | 不要求预先展示计划，直接开始实现、检查和验证；所有安全规则仍然有效。 |

示例：

```text
/mode plan
请分析这个仓库的鉴权流程并给出重构计划

/mode code
按照刚才的计划实现第一阶段
```

## Agent 的四个工具

模型只能调用以下四个工具：

| 工具 | 能力与约束 |
| --- | --- |
| `read_file` | 分段读取工作区内的 UTF-8 文本，并记录内容哈希；读取有大小和行数上限。 |
| `create_file` | 在工作区内新建 UTF-8 文件；目标已存在时失败，不会覆盖。 |
| `update_file` | 对已经读取的文件做精确文本替换；写入前校验 SHA-256，文件被外部修改时拒绝覆盖。 |
| `run_command` | 在工作区目录中运行一个可执行程序及其参数数组；不接受 Shell 命令字符串。 |

文件路径必须是工作区相对路径。绝对路径、`..` 路径穿越，以及通过符号链接或 Windows junction 逃逸工作区都会被拒绝。文件修改会进入当前会话的 Change Set，可用 `/changes` 查看。

### 命令执行和 npm 安装

`run_command` 使用 `program + args[]` 的结构化调用，不会把模型文本交给 Shell。策略会在执行前把命令分类为 `allow`、`ask` 或 `deny`：

- `safe`：允许已知的只读检查，以及 Auto/Code mode 下严格限定、禁用生命周期脚本的工作区本地 npm 安装；运行仓库代码等风险命令需要一次性精确审批；硬性禁用项仍拒绝。
- `ask`：所有本来可执行的命令都要求确认。
- `never`：不显示审批请求；所有策略结果为 `ask` 的命令直接拒绝，策略结果为 `allow` 的操作仍会执行，包括安全检查以及 Auto/Code mode 下符合严格规则的本地 npm 安装。

当前硬性禁止 Shell、Shell 操作符、破坏性命令、提权、系统包管理器、`npx`、直接远程命令和全局 npm 安装。运行仓库代码、解释器脚本、构建或测试时，因为没有 OS 级沙箱，会要求精确的一次性审批。

Agent 可以执行受限的工作区本地 npm 安装。直接传入包规格时必须使用正常 Registry 包名和精确版本，例如 `package-name@1.2.3`；直接传入的版本范围、Git/HTTP URL、tarball、file/link 依赖和 alias 会被拒绝。裸 `npm install` 与不带包规格的 `npm ci` 也允许，其最终依赖版本由现有 `package.json` 和 lockfile 决定，因此现有 manifest 中的普通 semver 范围可能仍会参与解析。

所有由 Agent 发起且通过策略的 npm 安装都会补充 `--ignore-scripts --no-audit --no-fund`；直接安装包规格时还会补充 `--save-exact`。这里的 `--ignore-scripts` 仅约束 Agent 对用户工作区发起的依赖安装，不影响安装 EASY CODE 自身时用于验证 SQLite 的 `postinstall` 脚本。全局安装、重定向安装位置以及依赖生命周期脚本在 Agent 工具中仍被禁止。

## 重要安全边界

EASY CODE 当前有工作区路径保护、环境变量过滤、命令分类、精确审批和审计记录，**但没有实现操作系统级进程沙箱**。

这意味着：

- `read_file`、`create_file` 和 `update_file` 的路径受 EASY CODE 的工作区守卫限制。
- 一旦命令获准执行，子进程仍以启动 EASY CODE 的操作系统用户身份运行。应用级审批不是容器、虚拟机、macOS sandbox、Windows AppContainer 或 Linux namespace。
- 命令可能利用自身能力访问网络或工作区外资源；“已审批”只表示用户接受了显示的精确调用，不代表进程已被内核隔离。
- 文件写入工具不会逐文件弹出命令审批。在修改前需要人工审查时，请先使用 Plan mode。

对于不可信仓库，建议在容器、虚拟机或低权限临时账户中运行，不要使用 `--yes`，并先提交或备份现有改动。

发送给 Provider 的上下文可能包含用户请求、相关代码、工具结果、工作区摘要和检索到的记忆。处理机密代码前，请确认所用 Provider 的数据政策符合你的要求。

## 上下文与自动记忆

记忆完全由 EASY CODE 自动维护。用户可以查看，但不能手动新建、修改、固定或删除记忆；普通对话也不会成为绕过这一限制的记忆编辑接口。

- 短期记忆与当前 Thread 绑定，包括对话、工具结果、文件版本、变更集和自动生成的 Working Summary。上下文接近预算时会自动压缩。
- 长期记忆按工作区隔离，只从已完成任务中提取较稳定的信息。用户明确表达的长期偏好和约定可直接成为候选；助手给出的架构、决策和环境事实只有在本轮存在文件读取、已验证变更或成功命令证据时才会成为候选。检索结果只是辅助提示，当前文件和最新命令结果优先。
- 敏感信息会在写入和展示前做启发式过滤与脱敏，但这不是密码管理器，也不能保证识别所有秘密。

只读查看命令：

```text
/memory short
/memory long
/memory long <id>
```

不存在 `/memory add`、`/memory edit` 或 `/memory delete`。

## 会话和 SQLite

每个 Thread 使用追加式 JSONL 事件日志记录对话和工具活动；SQLite 保存可查询的会话投影、FTS5 全文检索索引和长期记忆。当前 WASM VFS 使用 `journal_mode=DELETE` 的 rollback journal，而不是 WAL；启动时会设置外键、busy timeout 和同步级别，并执行顺序迁移。

持久数据库的每次操作和完整同步事务还会取得 EASY CODE 自己的跨进程 advisory lock。锁记录 PID、主机名和随机所有权 token；只有在同一主机上确认原进程已经退出时，后续进程才会把旧 owner 隔离为按 token 固定的 tombstone，并回收 WASM VFS 遗留的空锁目录。tombstone 会保留以阻止多个恢复者之间的 ABA 竞态；活进程或身份无法验证的锁不会被删除。这样可以在强制退出后自动恢复，同时避免另一个仍在运行的 CLI 被误判为 stale lock。

- 无需安装或启动 MySQL、PostgreSQL、Redis 或单独的 SQLite 服务。
- npm 安装阶段会验证随包提供的 SQLite WASM 能否打开内存数据库，并确认 FTS5 可用。
- 第一次运行会自动创建实际数据库和表。
- 进程崩溃后，下一次启动会验证旧锁所有者并安全恢复 rollback journal；并发实例会短暂等待，超时后明确报告数据库正忙。
- 数据目录由 `env-paths` 按操作系统确定，也可通过 `EASY_CODE_DATA_DIR` 覆盖。
- 不要在 EASY CODE 运行时手工编辑数据库或 JSONL 日志。

## config.toml

用户级配置文件位于 `env-paths` 返回的 EASY CODE 配置目录下，文件名为 `config.toml`。可通过 `EASY_CODE_CONFIG_DIR` 指定配置目录。每个工作区还可以提供：

```text
<workspace>/.easycode/config.toml
```

用户级配置示例：

```toml
provider = "qwen"
mode = "auto"
approval_policy = "safe"

[limits]
max_steps = 40
max_context_chars = 320000
max_output_chars = 64000
command_timeout_ms = 120000

[providers.qwen]
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
model = "qwen3-coder-plus"
timeout_ms = 120000
max_retries = 2

[providers.deepseek]
base_url = "https://api.deepseek.com"
model = "deepseek-v4-pro"
timeout_ms = 120000
max_retries = 2
```

配置优先级从低到高为：内置默认值、用户 `config.toml`、工作区 `.easycode/config.toml`、操作系统凭据存储、环境变量、当前 CLI 参数。操作系统凭据存储只提供 API Key。工作区配置只能调整非信任根选项，不能设置 API Key、Provider Base URL、配置目录、数据目录或缓存目录。

常用通用环境变量包括：

```text
EASY_CODE_PROVIDER
EASY_CODE_MODE
EASY_CODE_APPROVAL_POLICY
EASY_CODE_WORKSPACE_ROOT
EASY_CODE_CONFIG_DIR
EASY_CODE_DATA_DIR
EASY_CODE_CACHE_DIR
EASY_CODE_MAX_STEPS
EASY_CODE_MAX_CONTEXT_CHARS
EASY_CODE_MAX_OUTPUT_CHARS
EASY_CODE_COMMAND_TIMEOUT_MS
```

## 系统提示词和 EASYCODE.md

每次模型调用都会重新构建系统提示词，并加入当时的本地时间、UTC 时间、IANA 时区、系统 Locale 和语言、操作系统、CPU 架构、Shell、当前目录、工作区、模式以及 Provider/模型。这些字段用于减少环境误判，不会扩大权限。

EASY CODE 还会加载用户配置目录中的 `EASYCODE.md`，以及从工作区根目录到当前目录沿途的 `EASYCODE.md`。它们适合记录构建命令、代码风格和项目约定，但不能授予工具、网络、文件系统或命令权限。工作区文件、命令输出、摘要和记忆都会作为“不可信上下文数据”传给模型，不能覆盖用户请求与运行时策略。

## 交互命令

```text
/mode plan|auto|code       切换工作模式
/provider qwen|deepseek    切换 Provider
/model                     查看 Provider、模型和 Key 状态
/model <model>             切换当前 Provider 的模型
/model qwen|deepseek <id>  同时切换 Provider 和模型
/status                    查看当前状态
/workspace                 查看工作区摘要
/workspace refresh         刷新工作区清单
/changes                   查看当前 Thread 的文件变化
/tools                     查看当前工具
/permissions               查看命令权限与沙箱状态
/commands                  查看最近命令
/context                   查看上下文预算
/memory short              查看自动短期记忆
/memory long               查看自动长期记忆
/memory long <id>          查看一条长期记忆
/sessions                  列出历史 Thread
/resume <id>               恢复 Thread
/new                       新建 Thread
/clear                     清屏
/help                      显示帮助
/exit                      保存并退出
```

## 常见故障

### Node.js 版本过低

如果安装时出现 `Unsupported engine` 或运行时语法错误，先执行 `node --version`。最低版本是 16.20.0；切换 Node.js 大版本后，请重新执行 `npm install`，确保依赖和锁文件状态一致。SQLite 使用 WASM；系统凭据存储使用随包提供的预编译 N-API 二进制，正常情况下都不需要本地编译。

### SQLite WASM 检查失败

`node-sqlite3-wasm` 随 npm 包提供 WASM，不需要本地 C++ 工具链。如果普通 `npm install` 的 `postinstall` 检查失败，请先确认 Node.js 至少为 16.20、安装未使用 `--ignore-scripts`、包文件没有被安全软件隔离，并检查依赖是否完整。以下命令需在 EASY CODE 源码或已安装包根目录运行：

```bash
npm ls node-sqlite3-wasm
node scripts/postinstall.cjs
```

如果安装成功但第一次启动无法创建持久数据库，请检查 `EASY_CODE_DATA_DIR` 或平台默认应用数据目录是否可写；这属于文件权限或路径问题，不是原生 ABI 编译问题。

### 找不到 `easy-code`

确认 npm 全局 bin 目录在 `PATH` 中，或改用项目内的 `npx easy-code`。Windows 上也可以检查是否生成了 `easy-code.cmd`。

### API Key 缺失、401 或 403

先运行 `easy-code config list` 查看配置状态；缺失时运行 `easy-code config set qwen.api-key` 或 `easy-code config set deepseek.api-key`。如果使用环境变量，确认启动 EASY CODE 的同一个终端进程能读取 `QWEN_API_KEY`、`DASHSCOPE_API_KEY` 或 `DEEPSEEK_API_KEY`，并确认当前 Provider 与 Key 匹配。Linux 无桌面会话或凭据服务不可用时，优先使用环境变量。不要把 Key 粘贴到聊天中排查。

### API 超时或模型不存在

检查网络、代理、Base URL、账户区域和模型权限。可用 `QWEN_MODEL`、`DEEPSEEK_MODEL` 或 `--model` 覆盖模型；私有网关应在用户级配置或环境变量中设置，不要写入工作区配置。

### 命令被拒绝

运行 `/permissions` 查看当前模式和审批策略。Plan mode 只允许安全调查；`never` 会拒绝所有需要批准的命令；Shell、系统安装、破坏性操作和远程命令无论是否确认都会被策略拒绝。请改用结构化、作用域更小的程序和参数，不要尝试用 Shell 包装绕过策略。

### 文件更新冲突

`update_file` 要求文件内容与最近一次读取时的哈希一致。若编辑器或其他进程改过文件，Agent 必须重新读取后再应用修改；这是防止覆盖并发更改的正常保护。

### 长期记忆没有内容

长期记忆只在任务成功完成或计划完成后，从稳定且可复用的信息中自动提取，并按工作区隔离。一次性任务、未验证猜测、敏感内容和低置信度信息可能不会保存。

### TOML 配置报错

确认字符串带引号、表名和键名拼写正确。工作区配置若包含 API Key、Base URL 或数据目录等受保护字段会被主动拒绝；API Key 请移到操作系统凭据存储或环境变量，其他受保护设置请移到用户级配置或环境变量。

## 开发验证

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

更完整的架构、状态模型和后续路线见 [PLAN.md](./PLAN.md)。
