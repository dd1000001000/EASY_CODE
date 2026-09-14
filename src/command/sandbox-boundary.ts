import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ApprovalDecision, ToolContext } from "../core/types.js";

interface BoundaryIncident {
  scope: string;
  family: string;
  fingerprint: string;
  attempts: number;
  lastSeenAt: string;
  grant?: { kind: "host_once"; fingerprint: string; expiresAt: string };
  lastDecision?: ApprovalDecision | "user_required" | "benchmark_allow_once";
}

interface BoundaryState {
  version: 1;
  incidents: BoundaryIncident[];
}

const sharedStores = new Map<string, SandboxBoundaryStore>();
const HOST_GRANT_TTL_MS = 10 * 60_000;

function validIncident(value: unknown): value is BoundaryIncident {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BoundaryIncident>;
  const grant = candidate.grant;
  const grantValid = grant === undefined || grant !== null && typeof grant === "object" &&
    grant.kind === "host_once" && typeof grant.fingerprint === "string" && grant.fingerprint.length > 0 &&
    typeof grant.expiresAt === "string" && Number.isFinite(Date.parse(grant.expiresAt));
  const decisionValid = candidate.lastDecision === undefined ||
    ["allow_once", "allow_prefix", "reject", "user_required", "benchmark_allow_once"].includes(candidate.lastDecision);
  return typeof candidate.scope === "string" && candidate.scope.length > 0 &&
    typeof candidate.family === "string" && candidate.family.length > 0 &&
    typeof candidate.fingerprint === "string" && candidate.fingerprint.length > 0 &&
    Number.isSafeInteger(candidate.attempts) && Number(candidate.attempts) > 0 &&
    typeof candidate.lastSeenAt === "string" && Number.isFinite(Date.parse(candidate.lastSeenAt)) &&
    grantValid && decisionValid;
}

/** Durable, bounded state for one exact sandbox-boundary incident. The store
 * never grants broad host authority: an approved token is consumed before one
 * exact canonical command is dispatched. */
export class SandboxBoundaryStore {
  private readonly incidents = new Map<string, BoundaryIncident>();

  constructor(
    private readonly filename: string | undefined,
    private readonly limit: number,
  ) {
    if (!filename || !existsSync(filename)) return;
    const parsed = JSON.parse(readFileSync(filename, "utf8")) as Partial<BoundaryState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.incidents) || !parsed.incidents.every(validIncident)) {
      throw new Error("Invalid sandbox boundary incident state");
    }
    for (const incident of parsed.incidents) this.incidents.set(this.key(incident.scope, incident.fingerprint), incident);
  }

  scope(context: ToolContext): string {
    return `${context.threadId}:${context.assignedTaskId ?? context.turnId}`;
  }

  recordViolation(scope: string, family: string, fingerprint: string): number {
    const key = this.key(scope, fingerprint);
    const existing = this.incidents.get(key);
    const incident: BoundaryIncident = {
      scope,
      family,
      fingerprint,
      attempts: (existing?.attempts ?? 0) + 1,
      lastSeenAt: new Date().toISOString(),
      ...(existing?.lastDecision ? { lastDecision: existing.lastDecision } : {}),
    };
    this.incidents.delete(key);
    this.incidents.set(key, incident);
    this.trim();
    this.persist();
    return incident.attempts;
  }

  recordDecision(scope: string, fingerprint: string, decision: BoundaryIncident["lastDecision"], grantFingerprint?: string): void {
    const key = this.key(scope, fingerprint);
    const incident = this.incidents.get(key);
    if (!incident) throw new Error("Sandbox boundary incident disappeared before approval was recorded");
    incident.lastDecision = decision;
    if (decision === "allow_once" || decision === "allow_prefix") {
      if (!grantFingerprint) throw new Error("Exact host command identity is required for a boundary grant");
      incident.grant = { kind: "host_once", fingerprint: grantFingerprint,
        expiresAt: new Date(Date.now() + HOST_GRANT_TTL_MS).toISOString() };
    } else delete incident.grant;
    incident.lastSeenAt = new Date().toISOString();
    this.persist();
  }

  /** Consume before dispatch so a crash cannot replay host authority. */
  consumeHostGrant(scope: string, fingerprint: string): boolean {
    const incident = [...this.incidents.values()].find(candidate =>
      candidate.scope === scope && candidate.grant?.fingerprint === fingerprint);
    if (!incident?.grant || Date.parse(incident.grant.expiresAt) <= Date.now()) {
      if (incident?.grant) { delete incident.grant; this.persist(); }
      return false;
    }
    delete incident.grant;
    this.persist();
    return true;
  }

  private key(scope: string, fingerprint: string): string { return `${scope}\n${fingerprint}`; }
  private trim(): void {
    while (this.incidents.size > this.limit) {
      const oldest = this.incidents.keys().next().value as string | undefined;
      if (!oldest) break;
      this.incidents.delete(oldest);
    }
  }
  private persist(): void {
    if (!this.filename) return;
    mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, incidents: [...this.incidents.values()] } satisfies BoundaryState), { mode: 0o600 });
    renameSync(temporary, this.filename);
  }
}

export function sharedSandboxBoundaryStore(filename: string | undefined, limit: number): SandboxBoundaryStore {
  if (!filename) return new SandboxBoundaryStore(undefined, limit);
  const canonical = path.resolve(filename);
  const existing = sharedStores.get(canonical);
  if (existing) return existing;
  const store = new SandboxBoundaryStore(canonical, limit);
  sharedStores.set(canonical, store);
  return store;
}
