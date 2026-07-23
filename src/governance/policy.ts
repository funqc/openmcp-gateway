/**
 * Governance policy: per-service enable/disable, allow/deny operation lists,
 * masking rules, and per-operation risk overrides.
 *
 * Loaded from a JSON file (POLICY_PATH) if present, else defaults.
 * The policy is the single source of truth consulted by the executor's
 * policy gate and by the response masker.
 */
import { readFileSync, existsSync } from "node:fs";
import { config } from "../config.js";
import type { RiskLevel } from "../types.js";

export interface ServicePolicy {
  enabled?: boolean;
  allow?: string[]; // operationIds; empty/absent = all allowed
  deny?: string[]; // operationIds; explicit blocklist
}
export interface MaskingRule {
  /** JSONPath-ish dotted path, e.g. "user.token" or "*.password". */
  path: string;
  /** Replacement shown in output. */
  replacement?: string;
}
export interface Policy {
  services: Record<string, ServicePolicy>;
  /** Field names to redact recursively (from REDACT_FIELDS + policy). */
  redactFields: string[];
  maskingRules: MaskingRule[];
  /** Per-operationId risk overrides (highest precedence). */
  riskOverrides: Record<string, RiskLevel>;
}

interface PolicyFile {
  services?: Record<string, ServicePolicy>;
  redactFields?: string[];
  maskingRules?: MaskingRule[];
  riskOverrides?: Record<string, RiskLevel>;
}

function loadPolicyFile(): PolicyFile {
  try {
    if (config.policyPath && existsSync(config.policyPath)) {
      return JSON.parse(readFileSync(config.policyPath, "utf8")) as PolicyFile;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[policy] failed to load ${config.policyPath}:`, (err as Error).message);
  }
  return {};
}

function build(): Policy {
  const file = loadPolicyFile();
  const redactFields = Array.from(
    new Set([...config.redactFields.map((f) => f.toLowerCase()), ...(file.redactFields ?? []).map((f) => f.toLowerCase())]),
  );
  return {
    services: file.services ?? {},
    redactFields,
    maskingRules: file.maskingRules ?? [],
    riskOverrides: file.riskOverrides ?? {},
  };
}

let _policy: Policy | null = null;

export function getPolicy(): Policy {
  if (!_policy) _policy = build();
  return _policy;
}

/** Reload policy from disk (for hot-reload scenarios). */
export function reloadPolicy(): Policy {
  _policy = build();
  return _policy;
}

// ---- Decisions ----

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export function decideOperation(
  serviceId: string,
  operationId: string,
): PolicyDecision {
  const policy = getPolicy();
  const svc = policy.services[serviceId];
  if (svc?.enabled === false) {
    return { allowed: false, reason: `service "${serviceId}" is disabled by policy` };
  }
  if (svc?.deny?.includes(operationId)) {
    return { allowed: false, reason: `operation "${operationId}" is denied by policy` };
  }
  if (svc?.allow && svc.allow.length && !svc.allow.includes(operationId)) {
    return { allowed: false, reason: `operation "${operationId}" is not in the allow list for "${serviceId}"` };
  }
  return { allowed: true, reason: "ok" };
}
