/**
 * CRUD over services + operations tables.
 * All JSON columns are stored as TEXT and (de)serialized here.
 */
import { db } from "./db.js";
import type { OperationRecord, SearchableOperation, ServiceRecord } from "../types.js";

// ---- Row types (what SQLite returns) ----
interface ServiceRow {
  id: string;
  name: string;
  base_url: string;
  spec_version: string | null;
  spec_hash: string;
  auth_scheme: string;
  registered_at: number;
  schema_version: number | null;
  proxy_url: string | null;
}
interface OperationRow {
  id: string;
  service_id: string;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  tags: string;
  params_schema: string;
  body_schema: string | null;
  body_required: number;
  response_hint: string | null;
  risk_level: string;
  example: string;
  graphql_query: string | null;
}

function rowToService(r: ServiceRow): ServiceRecord {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    specVersion: r.spec_version ?? "",
    specHash: r.spec_hash,
    authScheme: r.auth_scheme as ServiceRecord["authScheme"],
    registeredAt: r.registered_at,
    schemaVersion: r.schema_version ?? 0,
    proxyUrl: r.proxy_url ?? "",
  };
}

function rowToOperation(r: OperationRow): OperationRecord {
  return {
    id: r.id,
    serviceId: r.service_id,
    method: r.method as OperationRecord["method"],
    path: r.path,
    summary: r.summary ?? undefined,
    description: r.description ?? undefined,
    tags: JSON.parse(r.tags) as string[],
    paramsSchema: JSON.parse(r.params_schema) as object,
    bodySchema: r.body_schema ? (JSON.parse(r.body_schema) as object) : null,
    bodyRequired: r.body_required === 1,
    responseHint: r.response_hint ?? undefined,
    riskLevel: r.risk_level as OperationRecord["riskLevel"],
    example: r.example,
    graphqlQuery: r.graphql_query ?? null,
  };
}

// ---- Services ----

export function upsertService(svc: ServiceRecord): void {
  db.prepare(
    `INSERT INTO services (id,name,base_url,spec_version,spec_hash,auth_scheme,registered_at,schema_version,proxy_url)
     VALUES (@id,@name,@base_url,@spec_version,@spec_hash,@auth_scheme,@registered_at,@schema_version,@proxy_url)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       base_url=excluded.base_url,
       spec_version=excluded.spec_version,
       spec_hash=excluded.spec_hash,
       auth_scheme=excluded.auth_scheme,
       schema_version=excluded.schema_version,
       proxy_url=excluded.proxy_url`,
  ).run({
    id: svc.id,
    name: svc.name,
    base_url: svc.baseUrl,
    spec_version: svc.specVersion,
    spec_hash: svc.specHash,
    auth_scheme: svc.authScheme,
    registered_at: svc.registeredAt,
    schema_version: svc.schemaVersion,
    proxy_url: svc.proxyUrl,
  });
}

export function getService(id: string): ServiceRecord | undefined {
  const row = db.prepare("SELECT * FROM services WHERE id = ?").get(id) as ServiceRow | undefined;
  return row ? rowToService(row) : undefined;
}

export function getServiceByHash(hash: string): ServiceRecord | undefined {
  const row = db.prepare("SELECT * FROM services WHERE spec_hash = ?").get(hash) as
    | ServiceRow
    | undefined;
  return row ? rowToService(row) : undefined;
}

export function listServices(): ServiceRecord[] {
  const rows = db.prepare("SELECT * FROM services ORDER BY id").all() as ServiceRow[];
  return rows.map(rowToService);
}

export function deleteService(id: string): void {
  // 先清该服务的 FTS 行（CASCADE 只删 operations 表，不会动 FTS 镜像），
  // 再删 service 行（CASCADE 级联删 operations 表行）。
  db.prepare("DELETE FROM operations_fts WHERE service_id = ?").run(id);
  db.prepare("DELETE FROM services WHERE id = ?").run(id);
}

// ---- Operations ----

export function clearOperationsFor(serviceId: string): void {
  // Keep FTS in sync: remove rows whose service_id matches.
  const ids = (
    db.prepare("SELECT id FROM operations WHERE service_id = ?").all(serviceId) as { id: string }[]
  ).map((r) => r.id);
  db.prepare("DELETE FROM operations WHERE service_id = ?").run(serviceId);
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM operations_fts WHERE operation_id IN (${placeholders})`).run(...ids);
  }
}

export function insertOperation(op: OperationRecord): void {
  db.prepare(
    `INSERT INTO operations
       (id,service_id,method,path,summary,description,tags,params_schema,body_schema,body_required,response_hint,risk_level,example,graphql_query)
     VALUES
       (@id,@service_id,@method,@path,@summary,@description,@tags,@params_schema,@body_schema,@body_required,@response_hint,@risk_level,@example,@graphql_query)
     ON CONFLICT(id) DO UPDATE SET
       service_id=excluded.service_id, method=excluded.method, path=excluded.path,
       summary=excluded.summary, description=excluded.description, tags=excluded.tags,
       params_schema=excluded.params_schema, body_schema=excluded.body_schema, body_required=excluded.body_required,
       response_hint=excluded.response_hint, risk_level=excluded.risk_level, example=excluded.example,
       graphql_query=excluded.graphql_query`,
  ).run({
    id: op.id,
    service_id: op.serviceId,
    method: op.method,
    path: op.path,
    summary: op.summary ?? null,
    description: op.description ?? null,
    tags: JSON.stringify(op.tags),
    params_schema: JSON.stringify(op.paramsSchema),
    body_schema: op.bodySchema ? JSON.stringify(op.bodySchema) : null,
    body_required: op.bodyRequired ? 1 : 0,
    response_hint: op.responseHint ?? null,
    risk_level: op.riskLevel,
    example: op.example,
    graphql_query: op.graphqlQuery ?? null,
  });
}

export function getOperation(id: string): OperationRecord | undefined {
  const row = db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as
    | OperationRow
    | undefined;
  return row ? rowToOperation(row) : undefined;
}

/** 统计某服务下的 operation 数量。 */
export function countOperationsByService(serviceId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM operations WHERE service_id = ?").get(serviceId) as { c: number };
  return row.c;
}

export function listAllSearchable(): SearchableOperation[] {
  const rows = db.prepare("SELECT * FROM operations").all() as OperationRow[];
  return rows.map((r) => ({
    operationId: r.id,
    serviceId: r.service_id,
    method: r.method as SearchableOperation["method"],
    path: r.path,
    summary: r.summary ?? undefined,
    description: r.description ?? undefined,
    tags: JSON.parse(r.tags) as string[],
  }));
}

/** Atomically replace all operations of a service within one transaction. */
export function replaceServiceOperations(
  svc: ServiceRecord,
  ops: OperationRecord[],
): void {
  const tx = db.transaction(() => {
    upsertService(svc);
    clearOperationsFor(svc.id);
    for (const op of ops) insertOperation(op);
  });
  tx();
}
