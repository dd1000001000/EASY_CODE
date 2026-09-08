# Output generation and retention / 输出生成与保留

## Contract / 约定

All model requests omit `max_tokens`, `max_completion_tokens` and `max_output_tokens`.
`ModelRequest.outputReserveTokens` and `limits.maxResponseTokens` are **local estimates**
for context headroom and shared accounting, not parameters sent to the server.
Actual reported usage settles reservations. A request already in flight may exceed
its estimate or the remaining task budget; subsequent requests stop at the shared
budget. Server defaults may still end generation. We do not promise unlimited output.

所有模型请求均不发送上述生成上限参数。本地仍为输出预留上下文和任务预算，
返回后按实际用量结算。已发出的请求可能超过预估或剩余总预算，后续请求才会被阻止。
服务端默认限制仍可能结束生成，不承诺无限输出。

The HTTP response is received and parsed before business-text projection. Its
independent `providerResponseMaxBytes` safety ceiling defaults to 16 MiB; timeouts,
cancellation and malformed JSON remain errors, never executable partial responses.
The transport cap is unrelated to the 2048-token retained summary or tool display limits.

完整接收、解析 HTTP 响应后，才裁剪业务文本。独立的 16 MiB 传输安全保护、超时、
取消和 JSON 结构校验仍保留；不能把半份 HTTP JSON 当成成功响应使用。

## Projection boundaries / 裁剪边界

- Summary, approval, routing and review consume non-thinking content or complete
  tool arguments. Returned reasoning is never substituted for missing business output.
  Normal work-agent reasoning and complete recent tool exchanges remain unchanged.
- Summary field lengths and total retained size are repaired locally. Raw business
  candidates remain in Journal; aggregate overflow uses a valid JSON prefix wrapper,
  explicitly lossy/unverified. Thinking-only summaries use deterministic recovery.
- Approval reasons, reviewer summary/diagnosis, routing reasons/answers, Plan titles/overview,
  and child summaries are clipped with no length-correction model request.
- Executable commands, paths, patches, approval scope, experiment arguments, Plan
  step descriptions/verification, reviewer evidence/success/falsification conditions,
  and child completion evidence remain strict. Their
  existing bounded error/correction protocols are unchanged. Never run half a command
  or declare completion after silently dropping a required check.
- Oversized long-term memory proposals are archived as historical previews with scoped
  recall references, not committed as truncated facts. Responses explicitly report
  `staged: false` and `committed: false`; no length-only retry is required. This does
  not relax provenance or semantic admission for actual durable memory writes.

摘要、审批、路由和审查只消费正文或完整工具参数，不用 thinking 代替缺失结果。
主 Agent 的近期推理/工具链不做全局删除。纯展示内容超限本地裁剪并标明有损；
命令、补丁、授权范围、实验参数、计划执行/验证条件和子任务完成证据继续严格校验，
保留现有有界纠正机制。长期记忆超限保留可回忆的历史预览，不把残缺前缀写成事实。

Token projections use the provider-neutral estimator, not a claim to exact native
tokenization. Character projections preserve UTF-16 boundaries; structured payloads
are parsed before designated text fields are shortened. Existing command output
head/tail projections remain intact so trailing test failures are not discarded.

Token 裁剪使用统一估算器，并非各模型原生 tokenizer。字符前缀不切断 UTF-16 代理对；
先解析结构再缩短指定文字字段，不截断可执行 JSON。命令结果原有头尾保留机制不变，
避免丢掉尾部测试失败信息。
