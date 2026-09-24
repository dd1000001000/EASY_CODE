# V10 决策模型输入合约

V10 是实验数据，不改变 EASY CODE 线上决策路径。前期数据继承了 Luna 教师模型生成并经筛查修订的样本；本轮新增对照题由主 Agent 编写、标注并审查。`reason` 仅用于审计，不进入模型输入或训练目标。命令样本只是字符串，不执行。

## 路由

训练输入使用 `src/runtime/auto-router.ts` 发给 Auto controller 的 **user 消息正文**：首轮是用户原文；有历史时使用受限的 `BEGIN_UNTRUSTED_PRIOR_THREAD_CONTEXT` 和 `BEGIN_CURRENT_USER_REQUEST` 包装。通用决策规则仍由 Laya 的题目说明表示。V9 的 `imagesPresent`、`capabilityStatus`、`availableControlTools` 等描述性 JSON 字段不再进入输入，因为真实模型不会收到那个 JSON。图片没有参与本轮实验，不能据此声称多模态路由有效。

## 命令审批前置筛查

训练输入使用 `reviewCommandApproval()` 的 user 消息 JSON 字段：`userTask`、`command`、`preview`、`description`、可选 `network` 和 `source`、`proposedPermission`。V10 教师命令调用 Runtime 的前缀格式化函数生成许可范围；模拟可执行文件摘要不代表用户机器上的真实可执行文件。**AUTO_ALLOW** 仅表示这个精确调用可交给现有审批流程自动放行一次；**NEED_REVIEW** 表示继续交给独立审批 Agent／用户，绝非命令永久禁止。用户任务的授权范围、参数、工作目录、管道、重定向、网络作用必须一起判断，不能根据程序名或描述字段单独判断。完整访问模式、已有前缀授权和平台沙箱仍由 Runtime 处理。

## 交付前检查

当前产品尚无 Laya 交付门槛。V10 采用拟接入的最小接口：`Original user request` + `Main agent completion summary` 两段正文，不使用 V9 的虚构 `future_pre_delivery_gate_v1` / `evidenceStatus` 字段。RELEASE 的含义只是在摘要自己的叙述中覆盖全部用户要求且无明显矛盾，**不是独立验证补丁或测试**。如果将来接入线上流程，必须先实现这一接口并用真实调用轨迹重评测，不能直接拿本次离线分数当上线效果。

## 数据与选权重约束

- 继承 V9 的训练、验证、测试成员关系，只改变路由与交付的输入表示；审批继承 Runtime 形状的 JSON。
- 新审批对照按整个语义家族分组，不跨训练、验证、测试。测试题不参与选权重。
- 每次训练打乱样本和答案顺序；评测枚举每题的全部答案排列。
- V10 选权重先最小化验证集危险命令在**任一答案顺序**下被误放的数量，再比较安全命令稳定放行数，最后比较路由与交付。该选择规则无法证明未知命令安全；高误放时不得接管现有审批。
- 不依赖模型供应商：中文和英文请求、简短与详细完成摘要、Windows 与 Linux 命令都在同一输入合约下评估。
