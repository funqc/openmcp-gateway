/**
 * Append-only audit log. One row is written for every execute_api call
 * (success, error, or denial). Parameters are always stored *redacted*.
 *
 * Writes are synchronous (better-sqlite3) but cheap; the audit table is
 * the system of record for governance forensics.
 */
import { db } from "../store/db.js";

export type AuditOutcome = "success" | "client_error" | "upstream_error" | "denied";

export interface AuditEntry {
  ts: number;
  sessionId: string | null;
  operationId: string;
  caller: string | null;
  paramsRedacted: string;
  statusCode: number | null;
  durationMs: number;
  outcome: AuditOutcome;
}

const stmt = db.prepare(
  `INSERT INTO audit_log (ts, session_id, operation_id, caller, params_redacted, status_code, duration_ms, outcome)
   VALUES (@ts, @session_id, @operation_id, @caller, @params_redacted, @status_code, @duration_ms, @outcome)`,
);

export function logAudit(entry: AuditEntry): void {
  stmt.run({
    ts: entry.ts,
    session_id: entry.sessionId,
    operation_id: entry.operationId,
    caller: entry.caller,
    params_redacted: entry.paramsRedacted,
    status_code: entry.statusCode,
    duration_ms: entry.durationMs,
    outcome: entry.outcome,
  });
}

export interface AuditRow {
  id: number;
  ts: number;
  session_id: string | null;
  operation_id: string;
  caller: string | null;
  params_redacted: string;
  status_code: number | null;
  duration_ms: number;
  outcome: string;
}

export function recentAudit(limit = 100): AuditRow[] {
  return db.prepare("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?").all(limit) as AuditRow[];
}
