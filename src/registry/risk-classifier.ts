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

/**
 * Match a keyword as a whole word (not a substring), so that e.g. "format"
 * matches "format the disk" but NOT "information". Uses word boundaries; for
 * multi-word phrases (e.g. "power off") the boundary is applied at both ends.
 */
function matchesKeyword(haystack: string, keyword: string): boolean {
  // \b doesn't always behave well with non-ASCII; the classifier haystack is
  // already lowercased ASCII-ish. Escape regex meta in the keyword.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Treat spaces in the keyword literally (multi-word phrases); boundary on
  // the outer edges only.
  const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i");
  return re.test(haystack);
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

  const hitsDestructive = DESTRUCTIVE_KEYWORDS.some((k) => matchesKeyword(haystack, k));
  if (hitsDestructive) return "dangerous";

  if (WRITE_METHODS.includes(method)) return "elevated";

  return "safe";
}
