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
    ? { route: "plan_only", reason: "The request indicates planning, investigation, or a high-risk operation." }
    : { route: "direct_code", reason: "The request appears clear and can be verified within the workspace." };
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
        "You are the EASY CODE Auto Router. Decide only whether this request should be handled by " +
        "coding directly or by providing a plan only. Choose direct_code when the request is clear, " +
        "the changes are reversible, the scope is within the workspace, and the result can be verified. " +
        "Choose plan_only when there is ambiguity that could change the product direction or risk involving " +
        "deletion, deployment, system changes, or missing credentials. Output exactly one line of JSON: " +
        "{\"route\":\"plan_only|direct_code\",\"reason\":\"brief reason\"}."
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
