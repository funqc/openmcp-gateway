/**
 * Heuristic risk classification for an OpenAPI operation.
 *
 * Output is one of:
 *   - "safe"       : GET/HEAD reads that don't look destructive
 *   - "elevated"   : writes that mutate state (POST/PUT/PATCH) but aren't obviously destructive
 *   - "dangerous"  : DELETE, or any method whose summary/description/tags match destructive keywords
 *
 * Policy overrides (governance/policy.ts) take precedence over this default.
 */
import type { HttpMethod, RiskLevel } from "../types.js";

const DESTRUCTIVE_KEYWORDS = [
  "delete",
  "remove",
  "purge",
  "wipe",
  "destroy",
  "drop",
  "reset",
  "truncate",
  "format",
  "reboot",
  "shutdown",
  "power off",
  "factory",
  "expire",
  "revoke",
  "invalidate",
];

const WRITE_METHODS: HttpMethod[] = ["POST", "PUT", "PATCH"];
const DESTRUCTIVE_METHODS: HttpMethod[] = ["DELETE"];

function normalize(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

export function classifyRisk(
  method: HttpMethod,
  path: string,
  summary?: string,
  description?: string,
  tags: string[] = [],
): RiskLevel {
  const haystack = [summary, description, path, ...tags].map(normalize).join(" \n ");

  if (DESTRUCTIVE_METHODS.includes(method)) return "dangerous";

  const hitsDestructive = DESTRUCTIVE_KEYWORDS.some((k) => haystack.includes(k));
  if (hitsDestructive) return "dangerous";

  if (WRITE_METHODS.includes(method)) return "elevated";

  return "safe";
}
