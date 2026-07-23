/**
 * Assembles the upstream HTTP request from a validated params object.
 *
 * Splits the flat params into:
 *   - path parameters (substituted into the URL template)
 *   - query parameters (URL-encoded)
 *   - header parameters (namespaced as "header:Name" in the params schema)
 *   - request body (the `body` key, if the operation declares one)
 *
 * Auth headers are merged in last (highest precedence) by the caller.
 */
import type { OperationRecord } from "../types.js";

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export function buildRequest(
  op: OperationRecord,
  baseUrl: string,
  params: Record<string, unknown>,
  body: unknown,
  authHeaders: Record<string, string>,
): BuiltRequest {
  const pathParams: Record<string, string> = {};
  const queryParams: Record<string, string> = {};
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith("header:")) {
      headers[key.slice("header:".length)] = String(value);
    } else if (op.path.includes(`{${key}}`)) {
      pathParams[key] = String(value);
    } else {
      queryParams[key] = String(value);
    }
  }

  // Substitute path params.
  let path = op.path;
  for (const [k, v] of Object.entries(pathParams)) {
    path = path.replace(`{${k}}`, encodeURIComponent(v));
  }
  // Any remaining unsubstituted path params → error is the caller's problem,
  // but we leave them as-is so the upstream returns a clear 404.

  // Build query string.
  const qs = Object.keys(queryParams).length
    ? "?" + new URLSearchParams(queryParams).toString()
    : "";

  // Merge headers: caller-supplied < auth (auth wins).
  const finalHeaders: Record<string, string> = { ...headers, ...authHeaders };
  if (body !== undefined && !finalHeaders["Content-Type"] && !finalHeaders["content-type"]) {
    finalHeaders["Content-Type"] = "application/json";
  }

  const url = `${baseUrl.replace(/\/$/, "")}${path}${qs}`;
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

  return { url, method: op.method, headers: finalHeaders, body: bodyStr };
}
