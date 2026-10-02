import type { UISessionInfo } from "../ui/contracts.js";
import type { MessageKey } from "../i18n/catalog.js";
import { formatTokenCount } from "../cli/token-count.js";
import { t } from "./i18n.js";

const EFFORT: Readonly<Record<string, MessageKey>> = {
  none: "ui.effortNone",
  low: "ui.effortLow",
  medium: "ui.effortMedium",
};
const MODE: Readonly<Record<string, MessageKey>> = { plan: "ui.modePlan", code: "ui.modeCode" };
const ENVIRONMENT: Readonly<Record<string, MessageKey>> = {
  host: "ui.environmentHost",
  container: "ui.environmentContainer",
};
const APPROVAL: Readonly<Record<string, MessageKey>> = {
  auto_approve: "ui.approvalAgent",
  unrestricted: "ui.fullAccess",
};

export function modelLabel(session: UISessionInfo | null): string {
  if (!session) return t("ui.model");
  return `${session.provider}/${session.model} · ${t(EFFORT[session.thinkingEffort] ?? "ui.effortHigh")}`;
}

export function modeLabel(session: UISessionInfo | null): string {
  return t(MODE[session?.mode ?? ""] ?? "ui.modeAuto");
}

export function environmentLabel(session: UISessionInfo | null): string {
  return t(ENVIRONMENT[session?.commandEnvironment ?? ""] ?? "ui.environmentSandbox");
}

export function approvalLabel(session: UISessionInfo | null): string {
  return t(APPROVAL[session?.commandExecutionMode ?? ""] ?? "ui.manualApproval");
}

export function orchestrationLabel(session: UISessionInfo | null): string {
  return session?.orchestrationEnabled ? t("ui.dagOn") : t("ui.dagOff");
}

/** Context in use, e.g. `48.2k / 128k`, and the share of the model's window when it is known. */
export function contextUsage(session: UISessionInfo | null): { label: string; ratio?: number } | undefined {
  const used = session?.contextTokens;
  if (used === undefined) return undefined;
  const limit = session?.contextLimitTokens;
  if (!limit) return { label: formatTokenCount(used) };
  return { label: `${formatTokenCount(used)} / ${formatTokenCount(limit)}`, ratio: Math.min(1, used / limit) };
}
