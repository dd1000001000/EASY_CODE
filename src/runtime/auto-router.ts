import type { ChatMessage, ModelProvider } from "../core/types.js";

export interface AutoRouteResult {
  route: "plan_only" | "direct_code";
  reason: string;
}

const PLAN_HINTS = [
  /只(?:要|需).*(?:计划|方案|分析)/i,
  /不要(?:修改|写代码|执行)/i,
  /(?:review|explain|analy[sz]e|investigate)\b/i,
  /(?:删除|迁移数据库|部署|发布|push|重置|格式化磁盘|系统级安装)/i
];

function fallbackRoute(userInput: string): AutoRouteResult {
  const planOnly = PLAN_HINTS.some((pattern) => pattern.test(userInput));
  return planOnly
    ? { route: "plan_only", reason: "任务包含计划、调查或高风险操作信号。" }
    : { route: "direct_code", reason: "需求看起来明确且可以在工作区内验证。" };
}

export async function determineAutoRoute(
  provider: ModelProvider,
  userInput: string,
  signal?: AbortSignal
): Promise<AutoRouteResult> {
  const fallback = fallbackRoute(userInput);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是 EASY CODE 的 Auto Router。只判断本轮应直接编码还是只给计划。" +
        "当需求明确、变更可逆、范围在工作区且可验证时选择 direct_code；" +
        "当存在会改变产品方向的歧义、删除/部署/系统修改/凭据缺失等风险时选择 plan_only。" +
        "只输出一行 JSON：{\"route\":\"plan_only|direct_code\",\"reason\":\"简短原因\"}。"
    },
    { role: "user", content: userInput }
  ];

  try {
    const response = await provider.complete({ messages, signal, temperature: 0 });
    const content = response.message.content ?? "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const parsed = JSON.parse(match[0]) as { route?: unknown; reason?: unknown };
    if (parsed.route !== "plan_only" && parsed.route !== "direct_code") return fallback;
    return {
      route: parsed.route,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : fallback.reason
    };
  } catch {
    return fallback;
  }
}
