/**
 * Response masking: recursively redacts sensitive fields from any JSON
 * payload before it is returned to the caller or written to the audit log.
 *
 * Rules (in priority order):
 *   1. Policy.maskingRules — dotted-path rules (e.g. "user.token", "*.secret")
 *   2. Policy.redactFields — field-name denylist (recursive, case-insensitive)
 *
 * Redacted values are replaced with "[REDACTED]" (configurable per rule).
 */
import { getPolicy, type MaskingRule } from "./policy.js";

const DEFAULT_REPLACEMENT = "[REDACTED]";

/** Mask a value (typically a parsed JSON response). Returns a deep copy. */
export function mask(value: unknown): unknown {
  const policy = getPolicy();
  return maskValue(value, policy.redactFields, policy.maskingRules, []);
}

function maskValue(
  value: unknown,
  redactFields: string[],
  rules: MaskingRule[],
  path: string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => maskValue(v, redactFields, rules, path));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = [...path, k];
      const dotted = childPath.join(".");
      // Rule match by exact dotted path or "*.field" wildcard.
      const rule = rules.find(
        (r) => r.path === dotted || r.path === `*.${k}` || matchTail(r.path, childPath),
      );
      if (rule) {
        out[k] = rule.replacement ?? DEFAULT_REPLACEMENT;
        continue;
      }
      // Field-name denylist.
      if (redactFields.includes(k.toLowerCase())) {
        out[k] = DEFAULT_REPLACEMENT;
        continue;
      }
      out[k] = maskValue(v, redactFields, rules, childPath);
    }
    return out;
  }
  return value;
}

/** Match a rule path like "a.b" against a path tail ["x","a","b"]. */
function matchTail(rulePath: string, path: string[]): boolean {
  if (!rulePath.includes("*") && !rulePath.includes(".")) return false;
  const parts = rulePath.split(".");
  if (parts.length > path.length) return false;
  const tail = path.slice(path.length - parts.length);
  return parts.every((p, i) => p === tail[i]);
}

/** Mask a params object for safe storage in the audit log. */
export function maskParams(params: unknown): string {
  try {
    const masked = mask(params);
    return masked === undefined || masked === null ? "{}" : JSON.stringify(masked);
  } catch {
    return "{}";
  }
}
