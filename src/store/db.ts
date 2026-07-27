/**
 * SQLite connection + schema migrations (better-sqlite3, FTS5 enabled).
 *
 * Singleton: import { db } from this module.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

let _db: Database.Database | null = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS services (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  spec_version  TEXT,
  spec_hash     TEXT NOT NULL,
  auth_scheme   TEXT NOT NULL DEFAULT 'none',
  registered_at INTEGER NOT NULL,
  -- operation 提取逻辑版本号。提取逻辑变了（如本次加 service 前缀）就 bump，
  -- 即使 spec hash 未变也强制重新提取，保证 DB 里的 operation 与最新逻辑一致。
  schema_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS operations (
  id            TEXT PRIMARY KEY,
  service_id    TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  summary       TEXT,
  description   TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  params_schema TEXT NOT NULL,
  body_schema   TEXT,
  body_required INTEGER NOT NULL DEFAULT 0,
  response_hint TEXT,
  risk_level    TEXT NOT NULL,
  example       TEXT NOT NULL,
  graphql_query TEXT
);
CREATE INDEX IF NOT EXISTS idx_operations_service ON operations(service_id);

-- FTS5 mirror for BM25 keyword search over operation text.
CREATE VIRTUAL TABLE IF NOT EXISTS operations_fts USING fts5(
  operation_id UNINDEXED,
  service_id   UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  session_id TEXT,
  operation_id TEXT NOT NULL,
  caller  TEXT,
  params_redacted TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_op  ON audit_log(operation_id);
`;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const conn = new Database(config.dbPath);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA_SQL);
  // Lightweight migration: add body_required column if an older DB lacks it.
  const cols = conn.prepare("PRAGMA table_info(operations)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "body_required")) {
    conn.exec("ALTER TABLE operations ADD COLUMN body_required INTEGER NOT NULL DEFAULT 0");
  }
  // graphql_query: stores the auto-generated document for GraphQL-sourced ops.
  if (!cols.some((c) => c.name === "graphql_query")) {
    conn.exec("ALTER TABLE operations ADD COLUMN graphql_query TEXT");
  }
  // schema_version on services: forces re-extraction when the operation-id
  // generation logic changes (e.g. adding the serviceId_ prefix). Old DBs have
  // no such column → treat as version 0, which is below CURRENT_SCHEMA_VERSION,
  // so the first boot after upgrade re-registers every service.
  const svcCols = conn.prepare("PRAGMA table_info(services)").all() as { name: string }[];
  if (!svcCols.some((c) => c.name === "schema_version")) {
    conn.exec("ALTER TABLE services ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0");
  }
  _db = conn;
  return conn;
}

/** For tests: close & drop the in-memory handle. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export const db = getDb();
