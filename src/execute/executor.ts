/**
 * The Execute pipeline — the heart of execute_api.
 *
 * Steps:
 *   1. Resolve operation by id (404 → typed error)
 *   2. Policy gate (allow/deny)
 *   3. Validate params against resolved JSON Schema (Ajv)
 *   4. Risk gate — elicit confirmation for elevated/dangerous ops
 *   5. Build request + resolve auth (server-side, never returned)
 *   6. Invoke upstream via undici (shared Agent)
 *   7. Mask response + write audit row + return
 */
import { request } from "undici";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OperationRecord } from "../types.js";
import * as store from "../store/operation-store.js";
import { decideOperation } from "../governance/policy.js";
import { validateParams } from "./validator.js";
import { buildRequest } from "./request-builder.js";
import { resolveAuthHeaders } from "./auth.js";
import { requestConfirmation } from "../governance/confirm.js";
import { mask } from "../governance/masker.js";
import { logAudit, type AuditOutcome } from "../governance/audit.js";
import type { ExecuteOutput } from "../schemas/execute.js";
import { getDispatcher } from "./dispatcher.js";

export interface ExecuteContext {
  sessionId: string | null;
  caller: string | null;
  /** The MCP server, used for elicitation. Null when invoked outside MCP. */
  mcpServer: McpServer | null;
}

export async function execute(
  operationId: string,
  params: Record<string, unknown> | undefined,
  confirm: boolean | undefined,
  ctx: ExecuteContext,
): Promise<ExecuteOutput> {
  const startedAt = Date.now();

  // 1. Resolve
  const op = store.getOperation(operationId);
  if (!op) {
    return { ok: false, status: "not_found", operation_id: operationId, message: `Unknown operationId "${operationId}".` };
  }
  const service = store.getService(op.serviceId);
  if (!service) {
    return { ok: false, status: "not_found", operation_id: operationId, message: `Service "${op.serviceId}" not registered.` };
  }

  const baseOut: Partial<ExecuteOutput> = {
    operation_id: operationId,
    risk_level: op.riskLevel,
    summary: op.summary,
    required_params: requiredParams(op),
  };

  // 2. Policy gate
  const decision = decideOperation(op.serviceId, op.id);
  if (!decision.allowed) {
    finish(ctx, op.id, params, null, startedAt, "denied");
    return { ok: false, status: "denied", operation_id: operationId, message: decision.reason, ...baseOut };
  }

  // 3. Validate
  const validation = validateParams(op, params);
  if (!validation.ok) {
    finish(ctx, op.id, params, null, startedAt, "client_error");
    return {
      ok: false,
      status: "validation_error",
      operation_id: operationId,
      message: "Parameter validation failed.",
      details: validation.errors,
      ...baseOut,
    };
  }

  // 4. Risk gate
  if ((op.riskLevel === "elevated" || op.riskLevel === "dangerous") && !confirm) {
    if (ctx.mcpServer) {
      const outcome = await requestConfirmation({ mcpServer: ctx.mcpServer, operation: op });
      if (outcome === "declined") {
        finish(ctx, op.id, params, null, startedAt, "denied");
        return { ok: false, status: "denied", operation_id: operationId, message: "User declined confirmation.", ...baseOut };
      }
      if (outcome === "not_supported") {
        // Tell the agent to ask the user itself and re-call with confirm:true.
        return {
          ok: false,
          status: "confirmation_required",
          operation_id: operationId,
          message: `This is a ${op.riskLevel} operation. Ask the user to confirm, then re-call execute_api with confirm:true.`,
          ...baseOut,
        };
      }
    } else {
      // No MCP context → surface confirmation_required.
      return {
        ok: false,
        status: "confirmation_required",
        operation_id: operationId,
        message: `This is a ${op.riskLevel} operation. Confirm with the user, then re-call execute_api with confirm:true.`,
        ...baseOut,
      };
    }
  }

  // 5. Build request + auth
  const auth = resolveAuthHeaders(service);
  const built = buildRequest(op, service.baseUrl, validation.coercedParams, validation.body, auth.headers);

  // 6. Invoke
  let statusCode = 0;
  let outcome: AuditOutcome = "upstream_error";
  let data: unknown;
  try {
    const res = await request(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body,
      dispatcher: getDispatcher(service.proxyUrl),
    });
    statusCode = res.statusCode;
    const text = await res.body.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep as text */
    }
    data = parsed;
    outcome = statusCode >= 200 && statusCode < 300 ? "success" : statusCode >= 400 && statusCode < 500 ? "client_error" : "upstream_error";
  } catch (err) {
    finish(ctx, op.id, params, null, startedAt, "upstream_error");
    return {
      ok: false,
      status: "upstream_error",
      operation_id: operationId,
      message: `Upstream request failed: ${(err as Error).message}`,
      ...baseOut,
    };
  }

  // 7. Mask + audit + return
  const masked = mask(data);
  finish(ctx, op.id, params, statusCode, startedAt, outcome);

  const ok = statusCode >= 200 && statusCode < 300;
  // 状态映射：401/403 → 认证/授权被拒；其它 4xx → 客户端参数问题；5xx → 上游错误。
  const failStatus: ExecuteOutput["status"] =
    statusCode === 401 || statusCode === 403 ? "denied" : outcome === "client_error" ? "validation_error" : "upstream_error";
  return {
    ok,
    status: ok ? "success" : failStatus,
    operation_id: operationId,
    status_code: statusCode,
    data: masked,
    ...baseOut,
  };
}

// ---- helpers ----

function requiredParams(op: OperationRecord): string[] {
  const schema = op.paramsSchema as { required?: string[] };
  // Copy to avoid mutating the shared operation record's schema.
  const req = [...(schema.required ?? [])];
  if (op.bodyRequired) req.push("body");
  return req;
}

function finish(
  ctx: ExecuteContext,
  operationId: string,
  params: unknown,
  statusCode: number | null,
  startedAt: number,
  outcome: AuditOutcome,
): void {
  logAudit({
    ts: Date.now(),
    sessionId: ctx.sessionId,
    operationId,
    caller: ctx.caller,
    paramsRedacted: maskParamsSafe(params),
    statusCode,
    durationMs: Date.now() - startedAt,
    outcome,
  });
}

function maskParamsSafe(params: unknown): string {
  try {
    const masked = mask(params);
    // JSON.stringify(undefined) returns the value undefined (not a string);
    // normalize null/undefined to "{}" so the audit column is always valid JSON.
    return masked === undefined || masked === null ? "{}" : JSON.stringify(masked);
  } catch {
    return "{}";
  }
}
