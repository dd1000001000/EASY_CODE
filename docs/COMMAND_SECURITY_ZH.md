# 命令审批与执行环境

本方案把工作模式、审批主体和执行环境分开，替代此前“所有模式都强制内层沙箱”的设计。

## 工作模式

Code 执行实现；Plan 以调查和提交计划为目标，通过提示约束尽量避免直接文件编辑，
不再保证文件系统只读。Plan 命令与 Code 使用同一审批流程，获得授权后可以写文件。
文件工具在所有模式下仍保持工作区相对路径、先读后改、版本哈希和 Runtime 资源保护。

## 三种审批模式

| 模式 | 新命令 | 已保存前缀 | 默认环境 |
| --- | --- | --- | --- |
| 请求批准 / manual | 用户选择此次允许、允许前缀、拒绝 | 命中则复用 | 工作区 OS 沙箱 |
| 帮我批准 / auto_approve | 独立审批 Agent 判断；拒绝、错误、超时交给用户 | 命中则复用 | 工作区 OS 沙箱 |
| 完全访问 / unrestricted | 不需要批准 | 不需要 | 宿主机，无 EASY CODE 沙箱 |
| Benchmark 固定模式 | 不需要批准 | 不需要 | 仅离线任务容器完全访问 |

手动模式包括只读调查命令，不再靠静态风险标签自动放行。
审批 Agent 是独立、无工具的一次模型请求，不是普通工作子 Agent，也不是防停滞 reviewer。
输入包含用户任务、结构化命令、权限范围和 Runtime 生成的前缀；输出严格限制为三个结论和理由。
不执行命令、不写文件、不管理 DAG、不自行扩大权限。拒绝后用户仍可选择三个结论中的任意一个。
失败不再循环要求修正，直接转用户。所有请求和 Token 计入共享任务预算。

默认 limits：approvalInputChars=24000、approvalOutputTokens=1024、approvalTimeoutMs=60000。
用户配置可选 approvalModel，使用当前 provider 下的指定模型；不设置则沿用当前模型。
工作区配置不能设置审批模型。审批和原始任务模型不采用 provider 特有的安全规则。

主 Agent 和子 Agent 的审批统一在主界面排队，不存在两个 stdin 所有者。
等待时取消、切换任务或修改模式会使旧决定失效。
非交互模式不能询问用户时，返回 approval_unavailable，不默认批准。
重启不会恢复“此次允许”，也不会自动重放付费审批调用。

## 前缀权限

command:v2 绑定规范化可执行文件路径和内容哈希、子命令前缀或精确 argv 哈希、
cwd、工作区/宿主/容器范围和联网权限。工作区 cwd 使用相对位置，允许根任务与对应子任务共享授权；
宿主/容器 cwd 使用绝对路径。授权不跨无关 Thread。

普通程序可得到类似 git status 的子命令前缀；解释器、Shell、包管理器和非子命令形式采用精确 argv。
持久化的是精确参数哈希，不包含 inline 脚本或密钥明文。
脚本文件和仓库 hook 仍可能改变，因此前缀是“重复运行这个调用”的授权，不保证未来副作用完全相同；
审批 Agent 被要求在这类情形优先选择此次允许。审批后再次检查程序身份及解析材料。
/permissions 查看权限，/permissions revoke <序号> 持久化撤销；Journal 是事实来源，压缩和 Resume 不增加权限。

## DAG / 子 Agent 联动

- 手动模式开启编排时，必须明确确认同时开启“帮我批准”。
- 有未完成 DAG、活动子 Agent、待收集结果或活动命令时，禁止切到手动审批。
  不停止、不取消、不偷偷改变现有工作，提示完成后再次切换。
- 空闲时切换手动审批，原子地关闭 DAG/子 Agent 开关并保存。
- 手动模式恢复任务时，不自行启动未完成子 Agent；需要用户先选足够的审批等级。
- 切回自动审批不会自动重新开启已关闭的编排。
- 防停滞 reviewer 继续默认启用、严格只读。子 Agent 并发仍为 none/low=2、medium=4、high=8。

## 执行环境与网络

普通命令默认使用 Windows/Linux 工作区 OS 沙箱；Plan 与 Code 一样允许工作区写入。
敏感 Runtime 文件、凭据和受保护 Git 元数据仍在默认可写边界之外。
失败不会自动切到宿主机；macOS 严格沙箱的已有限制仍然存在。
命令可显式请求 executionScope=host，把宿主文件和网络权限与该命令一起审批。
完全访问直接采用宿主后端，不是防恶意命令的安全边界，也不提升用户的 OS 权限。
Runtime 不主动将 provider 密钥传入子进程环境，但完全访问命令仍可读取当前用户有权限的宿主文件。

不再把 Shell 写法当作安全证明：支持多行参数、脚本、管道、重定向、login/编码 Shell 和正常安装参数。
缺少 program、参数类型错误、NUL、不支持的远端程序路径、无效 cwd 仍返回输入/路径错误。
工作区 cwd 仍检查边界，获批宿主 cwd 可在工作区外。intent 不是权限；缺少验证分类降为 custom。

工作区联网使用逐命令 HTTP/SOCKS 网关：已知联网在启动前审批，
未知脚本第一次连接时补充联网审批。同一次命令缓存结果，避免反复询问。
网关继续限制内网、元数据地址及不支持的原始 UDP/IPv6；需要这些能力时应明确申请宿主执行。
完全访问使用宿主网络，不经过该网关。Benchmark 没有命令联网或依赖下载例外，也不提供清单下载工具。
开发模式的清单下载仍限定可信清单和完整性校验，不等同任意 Web 搜索。

## Benchmark 三个角色

1. Harbor 原始任务容器保留为干净评测器。
2. 控制容器运行 EASY CODE，保留密钥、日志、桥接文件，只允许模型端点外连。
3. 离线 worker 执行所有模型命令：容器内文件系统完全访问，Docker network=none。

控制端和 worker 只共享任务卷；不向 worker 挂载宿主目录、Docker socket、密钥或控制日志。
控制端 .git 使用额外私有卷，worker 修改自身 Git 配置不会影响控制端的 Git helper 执行。
子 Agent 固定使用同一个共享任务卷。只有宿主 Python broker 能控制 Docker。

worker 使用 private IPC 和普通 64 MiB /dev/shm，支持本地 socket、asyncio 和 Python 多进程。
不再叠加原来的 Landlock/seccomp 限制；不启用 privileged、宿主 PID/IPC/network 或额外 capabilities。
容器命令串行执行，每次终态后由 Docker 重启 worker，清掉包括 detached 在内的所有后代，
保留文件系统但不保留进程。因此需要服务器与客户端协同时，应放在同一受监督命令里。
排队不计入命令执行超时且可取消。桥接输出单命令上限 32 MiB，归档传输/导出也有容量上限。

评测前先停 worker，再把普通项目文件和未改变的基线符号链接导出到原始 checkout。
不导出 worker .git、Runtime 目录、新符号链接、设备或 hardlink。
干净评测器保留原始 Git 和工作区外测试材料。
命令租约全部关闭且无清理隔离标记时才恢复评测器网络。
worker 根文件系统的临时安装不纳入 checkpoint，保留的是项目改动和控制端状态。
详见 [Benchmark 说明](../benchmarks/swebench_verified/README.md#harbor-command-isolation)。

## 证据、恢复与测试

审批 review/decision、前缀授权/撤销、模式切换进入 Journal。
模型用量单独记为 purpose=command_approval、actor=approval_agent，不混入进展 reviewer。
错误区分参数、策略边界、审批不可用/拒绝、沙箱/基础设施、超时/取消、进程退出。
未启动拒绝不算测试失败；派发后状态未知不能自动重跑。

独立控制管道记录派发、终态、清理，不从裁剪输出推断。
Windows 沙箱 Job 和 Linux 隔离负责后代管理；宿主完全访问仅有尽力而为的进程监督，不提供同等隔离保证。
清理未知保留租约并隔离环境，压缩不会删除这些记录。

测试结果独立于外层退出码：识别出的 unittest/Django、pytest、Jest、Node 失败覆盖管道返回 0；
冲突或不完整证据记 unknown，不清空停滞。ProgressGuard 读取原始结构化证据。

npm run build:test 和测试 runner 覆盖审批、权限范围、前缀恢复、状态切换、Plan、网络、生命周期。
scripts/smoke-split-benchmark.py 不调用模型，仅用临时本地 Docker 容器验证：
密钥/宿主隔离、外网不可达、本地 IPC、12 进程 Pool、worker 独有程序、控制端 Git 隔离、
detached 清理、超时、干净导出和 Django 46 个 writer 测试。
这是兼容性/隔离烟测，不是正式 SWE-bench 分数。
