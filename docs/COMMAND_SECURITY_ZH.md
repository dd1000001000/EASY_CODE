# 命令执行的强制隔离

本安全底线与 provider、thinking、DAG 和审批模式无关。威胁范围是模型控制的进程，不包含已经被攻破的宿主管理员或内核。

## 四批改动

1. 所有命令统一走 OS 沙箱。Plan 始终只读；旧 ID `unrestricted` 现在仅表示“隔离下免逐条审批”，不再提供宿主机完全访问。工作区同名 Git/Node/npm 不享受可信只读豁免；审批后重新校验可执行文件内容和 npm 策略材料。
2. 独立 worker 管道传递有界生命周期事件，不再从裁剪后的输出推断执行状态。派发、启动器退出、清理分开记录。Windows 用 kill-on-close Job Object 管住进程树，确认后代结束后才恢复 ACL，确认 Job 为空后才释放资源；普通 Linux 使用沙箱 PID namespace，Harbor 使用下述专用内核隔离与 subreaper 后端。
3. Runtime 清单下载代理只接受已授权 artifact ID。开发模式另外提供逐命令联网代理，按下述审批规则授权；Benchmark 命令在清单下载期间仍完全离线。
4. Harbor 外层保留模型端点白名单，命令改用 Landlock/seccomp 后端，不再要求嵌套 namespace。安装阶段编译受信任的 supervisor，预检与执行选择同一后端。只有 Agent 根进程已返回，且没有未结束命令租约和清理隔离标记，才恢复可信评测器的网络。

## 审批和文件边界

本地自动审批由主 Agent 与子 Agent 共用判断：常规工作区读取、构建、测试、项目代码自动允许；明确高风险/系统影响和未分类工具请求审批。点名的本地文件删除、移动不再一律禁止；递归或影响范围不明的操作仍审批。这只是风险提醒，不声称任意项目代码无法删除工作区文件。子 Agent 不打开终端审批，缺少授权时报告主 Agent；危险模式仍免命令审批，不解除隔离。

手动模式审批符合策略的本地命令和所有联网；自动模式允许本地命令与明确只读联网，下载/上传/未知联网仍审批；危险模式不再请求任何命令或联网审批，并解除 Code 的命令分类拒绝。OS 隔离、Plan 只读、资源上限和 Benchmark 禁网仍保留。历史普通 Shell/解释器/包管理器授权仍不生效；用户可以另外授予显式联网前缀权限，授权前会说明其包含上传等广泛能力。

文件工具在所有模式下都只接受工作区相对路径。目录穿越、网络/设备工作区根、重定向工作区根，以及文件工具沿符号链接/Junction 的访问均被拒绝。Runtime 配置、凭据、缓存、日志和正在执行的资源必须位于命令可写边界之外或显式受保护。在支持 Plan 命令的 Linux 上，除了策略只允许调查命令，还在 OS 层将工作区设为只读；即使分类器误判，也不能获得项目写权限。临时 scratch 写入不等于项目写权限。

严格命令后端当前支持 Windows 和 Linux。macOS 的进程组终止不足以证明所有后代已结束，因此这一严格方案暂时拒绝 macOS 命令执行，文件工具仍可使用。预检失败不得通过弱隔离、privileged Docker、host network 或宿主执行绕过。

Windows Plan 当前**仅提供只读文件工具**：真实烟测表明，目录继承的 deny-write ACL 无法可靠覆盖此前由沙箱创建文件的显式权限。因此 Plan 隐藏命令工具，后端也拒绝 Plan 启动，即使分类器被绕过也不执行。Linux 保留内核文件系统隔离下的只读命令。这是主动限制能力，不是宣称 ACL 保证已成立。

## 开发模式联网规则

| 操作 | 手动模式 | 自动模式 | 危险模式 |
| --- | --- | --- | --- |
| 明确只读联网 | 审批 | 自动允许 | 允许 |
| 下载文件/依赖 | 审批 | 审批 | 允许 |
| 上传/修改远端 | 审批 | 审批 | 允许 |
| 未知脚本联网 | 审批 | 审批 | 允许 |

命中显式联网前缀后，手动/自动模式不再重复询问。前缀绑定规范化程序路径、可执行文件内容哈希和结构化 argv：`git fetch` 不匹配 `git push`。只选择程序、不限定子命令的广泛联网前缀确实包含上传和远端修改；旧普通程序授权不会自动升级为网络授权。`/permissions` 查看，`/permissions revoke <序号>` 撤销并写入 Journal，Resume 后继续生效；撤销前须结束/取消运行中的命令。撤销前缀不会关闭危险模式。

分类来自实际解析的命令，不信任模型的 `intent`。初版自动只读配方为可信 `curl`、禁用默认配置（`-q`）、限定 GET/HEAD 参数。写文件算下载；自定义请求头、正文、配置文件、未知参数、Git helper 和任意脚本按未知联网审批。只读是操作分类，不保证远端 GET 绝无副作用或查询参数绝无敏感信息。批准安装命令也包含其子进程；普通 npm install/ci 默认禁用生命周期脚本，危险模式保留模型提交的参数。

沙箱 HTTP/SOCKS 代理串联到带逐命令能力令牌的 Runtime 网关。先审批，再解析公共 IPv4 地址并固定实际连接目标，防止 DNS 重绑定。内网、回环、元数据地址和 IPv6 当前均不开放，危险模式也不例外。不使用代理的原始 TCP/UDP 客户端仍可能被沙箱拒绝；免审批不等于切到宿主机网络。HTTPS 使用 CONNECT，不解密，因此任意脚本不能声明自己只有只读权限。已识别联网命令启动前审批，未知脚本第一次实际代理请求时审批；批准和拒绝都只缓存到本次命令，避免循环弹窗。超时/取消会关闭审批等待及全部连接；Runtime 不自动重试上传。

单命令网关上限为 2,048 次连接/请求、512 MiB、16 KiB 请求头，DNS 等待最多 10 秒，连接有空闲超时。`network.authorization` / `network.connection` 只记录类型、主机/端口、结果，不写请求正文、URL 查询或代理口令。后台子 Agent 不争抢终端审批，只能使用父 Thread 已有前缀或自动只读授权，否则向主 Agent 报告；危险模式子 Agent 也免审批。

Benchmark 使用可信环境 profile，不是模型可改参数：所有授权模式均不下发命令网关。清单下载不能作为检索答案的例外，仍受审批及外层防火墙限制。非交互/禁用提示时，除已有前缀或模式已允许外，联网默认拒绝。

## 清单下载使用方式

用户在工作区外的可信 EASY CODE 配置目录放置 `artifact-catalog.json`。完整 JSON 示例见 [English contract](COMMAND_SECURITY.md)。条目包含：固定 ID、类型、工作区、HTTPS URL、SHA-256/SHA-512 完整性值、文件名、最大字节数和精确重定向列表。类型为 `file`、`npm`（`.tgz`）或 `wheel`（`.whl`）。模型不能通过工具修改此清单。“允许下载文件”不等于允许检索答案、网页搜索或上传数据，必要文件仍需明确授权。

初始 `package-lock.json` v2/v3 还可以授权固定 `registry.npmjs.org` tarball，但必须带完整性值。初始清单哈希和 artifact ID 按 Thread 持久化；模型修改 lock、压缩上下文、Resume 都不会获得新包的下载权限。无效或不支持的 lock 不提供隐式权限。Python wheel 和其他文件须显式登记；当前不是通用依赖解析器。

主 Agent 的 Code 模式可用 `fetch_artifact` 的 `list`/`fetch`。输出固定为 `vendor/downloads/<id>/<filename>`，不覆盖已被修改的文件。下载代理只做 HTTPS GET，验证公共 IPv4 DNS 并固定连接地址、验证证书、仅接受精确授权重定向（最多 3 次），不携带 Cookie/代理凭据；限制大小与时间，完整性校验后才写入独立缓存和工作区。IPv6 暂时保守拒绝。逐 Thread 下载额度账本跨 Resume 保留，损坏/未完成账本不会重置额度。

安全上限：单文件 256 MiB，隐式 npm 包 64 MiB；每 Thread 512 MiB，每次传输 60 秒。失败保留已预留的额度；这些安全上限不能由模型修改。

清单产物可以单独离线安装：npm 将校验过的 tarball 加入工作区缓存，再用 `npm ci --offline --ignore-scripts --cache <工作区缓存>`；wheel 使用 `python -m pip install --no-index --find-links vendor/downloads/... <包名>`。清单代理不解压、不执行安装脚本。开发模式也可批准普通安装命令联网；Benchmark 缺少传递依赖不会自动开放联网。

Benchmark 优先在可信镜像/安装阶段预置依赖；其外层白名单也可能拒绝代理下载，不会为此临时向 Agent 开放公共网络。

## 失败证据与恢复

`command.preparing`、worker 生命周期事件和 `command.finished` 写入所属 Thread Journal。`<dataDir>/command-leases/<workspaceId>/` 保存未结束命令租约；`<dataDir>/command-quarantine/` 保存清理隔离标记。它们不能由模型修改，也不会因压缩或 Resume 被清空。

Windows 还在 `<OS temp>/easy-code-srt-runtime/windows-acl-quarantine.json` 隔离共享沙箱身份，不会自动夺取陈旧的共享 ACL 锁，防止另一工作区复用未知状态。清理时直接检查 revoke/restore 的逐路径结果，因为底层 SDK 的 `reset()` 可能仅记录 ACL 错误但仍正常返回。

退出码是沙箱启动器的终态结果，不证明目标的所有副作用均成功。已经派发后缺少终态只能标为“未知”，不能说成“未启动，可以重试”。清理失败保留原退出码和输出，不重复命令，并禁止该环境继续执行命令或文件修改；只读诊断保留。结束状态无法持久化或审计失败时也采取保守处理。只有确认派发前失败且清理完成，才可能给出一次可重试初始化失败。

不要为了继续任务直接删除租约。操作人员应确认相关进程已结束，运行 `easy-code sandbox doctor`，必要时使用现有先 dry-run 的 Windows 工作区修复流程，确认 ACL 状态后才归档具体陈旧记录。没有提供模型可调用的“清空隔离标记”绕过。一次性 benchmark 应保留日志并重建出问题的环境，不把清理状态未知的环境恢复到公共网络。

## 验证范围

### 命令易用性与验证证据

Windows 命令派发后取消/超时，先结束目标后代，保留可信 worker 完成 ACL 恢复，再关闭已清空的 Job。并发清理请求只复用正在进行的操作，不复用旧 `QUIET` 回执；清理超过有界期限仍强制终止并隔离未知状态。`smoke-command-usability.mjs` 在真实 OS 后端验证脚本、多行/字面 argv、管道掩盖失败、子进程取消与超时。

Code 模式 PowerShell `-File` 默认规范化为该子进程的 `-NoProfile -NonInteractive -ExecutionPolicy Bypass`，与已经允许的 inline-code 能力一致；显式指定的执行策略保持原样。Runtime 不调用 `Set-ExecutionPolicy`，不修改用户/机器全局策略，仍受 OS 沙箱和组织策略约束。

`normalizeCommandRequest` 由 run/start 和 Runtime 共用。verify/test 缺少分类补为 `custom`，build 补为 `build`；无效或不适用的验证元数据记有界警告，不再要求模型重发命令。缺少 program、执行参数类型错误和 NUL 仍拒绝。规范化元数据保留在 Journal、模型投影和后续轮询中；intent 不是授权依据。

直接 argv 按字面传递，支持多行 Python/Node 和标点参数；相对程序路径以 cwd 为基准。cwd 接受工作区内绝对/相对路径以及归一化后仍在工作区的父目录片段。先检查本地链接目标再遍历，拒绝网络/设备链接；经校验的本地系统解释器链接不扩大文件访问权限。Git `-C` 在工作区内规范化；配置覆盖和 `.git` 写入仍受限。

支持一次性脚本（`bash script.sh`、`pwsh -File`）、heredoc/here-string、管道、重定向、同步嵌套调用、PowerShell `&`、短暂 sleep 和 timeout 包装。显式脱离进程的写法仍引导使用 Runtime 后台句柄；危险模式以外不支持交互/login/编码命令协议。脚本是不透明的项目代码，安全靠 OS 隔离和后代清理，不靠完整 Shell 静态证明。不自动拼接错误 cmd 参数、不加 `set -e`、不偷偷改管道语义。

`validation` 与执行退出码/状态分开。有界流式收集器在**展示裁剪前**识别匹配的 unittest/Django、pytest、Jest、Node 测试终态。框架失败覆盖外层退出 0；只有 Shell/过滤器退出码、多目标/多终态、成功摘要与非零退出冲突、证据不完整，均记 `unknown`。只有失败数量而没有具体错误证据时可信度低，不单凭数量触发 reviewer。失败行保留完整哈希，展示片段之后的断言差异也不会被合并。直接声明的 custom/build 命令可使用进程退出证据；这不是需求正确性证明，也不防伪造测试输出。

ProgressGuard 使用 Runtime 结论和失败签名，不使用展示摘要：三个独立周期的相同高置信失败可以触发审查；轮询去重；未知/低置信结果不清空停滞状态。Resume 回放 Journal Observation，不从裁剪后的历史输出重建框架证据。`unknown` 不代表要求自动重跑。

`node scripts/replay-command-requests.mjs <job绝对目录>` 只回放参数格式和参考策略，不启动历史命令、不在宿主解析容器程序、不调用模型、不改 job。新增 `command-usability`、`command-verification` 测试；隔离保证仍须真实 OS 烟测。

回归覆盖联网授权、命令、安全底线、审批、沙箱、下载、生命周期和 benchmark 接入。构建后，`node scripts/smoke-command-isolation.mjs` 检查 OS 隔离和清理；`node scripts/smoke-command-network.mjs` 用真实 curl 检查 SRT 与授权网关链路，测试专用可信解析器仅把固定测试域名映射到本地服务。两项均不调用模型 API 或公共互联网；失败时保留精确目录用于诊断。

单元测试不能代替部署机的内核/防火墙预检。Linux/Docker 命名空间策略、Windows WFP/ACL 初始化仍须在真实运行环境中验证。
## Harbor Benchmark 专用后端（2026-09）

Harbor 适配器在安装阶段编译受信任的 `scripts/harbor-sandbox.c`，并在
`sandbox doctor` 前设置 `EASY_CODE_OUTER_SANDBOX=harbor`。预检和 Runtime
均选择 `HarborSandboxBackend`；普通 CLI 仍使用原 OS 沙箱后端。

这不是裸执行回退：Docker 提供外层隔离，Landlock ABI 6+ 提供文件访问与信号
隔离，seccomp 禁止模型命令创建任何 socket、使用 io_uring、提升能力或创建
namespace。不要求 Docker 特权模式；缺少内核能力或受信任 helper 时仍失败关闭。

主 Runtime 仅能通过 Harbor 的白名单调用固定模型服务。模型命令即使处于危险模式
也不能联网，包括访问模型服务、DNS、TCP、UDP、IPv6 和本地 Unix socket。
可信安装／评测依赖准备与模型执行分阶段处理；清理未确认时不恢复 verifier 网络。

命令使用无 capability 的子进程、独立控制管道和 subreaper 监督；普通退出、超时、
取消均清理包括 setsid／双重 fork 在内的后代。Plan 的工作区仍为内核只读。

兼容性边界：本地 socket 测试和依赖 socket 的多进程功能同样不可用；chmod、
chown、xattr 操作禁止。容器内 Git／Runtime 元数据移除写权限，可信 root Runtime
仍可维护；保护目录的祖先下直接条目的删除／重命名受限，普通源码原地写入正常。
这些限制不会放宽为不受监督的宿主机命令。可用 `scripts/smoke-harbor-sandbox.mjs`
在一次性 Docker 容器里验证，无须调用模型。
