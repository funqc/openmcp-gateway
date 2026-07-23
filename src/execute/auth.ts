/**
 * AuthResolver: maps a registered service's auth scheme to the HTTP headers
 * that should be attached to the upstream call.
 *
 * Credentials are sourced from environment (config.auth) — never from the
 * caller, and never returned in tool output. The resolver is the *only*
 * place credentials touch request headers.
 */
import { getAuthForService, type ServiceAuthConfig } from "../config.js";
import type { ServiceRecord } from "../types.js";

export interface ResolvedAuth {
  headers: Record<string, string>;
}

export function resolveAuthHeaders(service: ServiceRecord): ResolvedAuth {
  const cfg: ServiceAuthConfig = getAuthForService(service.id);
  const headers: Record<string, string> = {};

  // If config says 'none' but the spec advertised a scheme, prefer the more
  // specific: spec scheme with config value if provided.
  const effectiveScheme = cfg.scheme !== "none" ? cfg.scheme : service.authScheme;

  switch (effectiveScheme) {
    case "bearer":
      if (cfg.value) headers["Authorization"] = `Bearer ${cfg.value}`;
      break;
    case "basic":
      if (cfg.value) headers["Authorization"] = `Basic ${Buffer.from(cfg.value).toString("base64")}`;
      break;
    case "apikey":
      if (cfg.value) headers[cfg.headerName ?? "X-API-Key"] = cfg.value;
      break;
    case "none":
    default:
      break;
  }
  return { headers };
}
