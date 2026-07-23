/**
 * Public Registry API — the single entry point for ingesting OpenAPI sources.
 *
 * Pipeline per source:
 *   load → sha256 dedupe → validate → dereference → extract ops →
 *   classify risk → transactional upsert → reindex search
 *
 * Also exposes discover() for boot-time + periodic refresh of a configured
 * service list.
 */
import { createHash } from "node:crypto";
import { getAuthForService, loadServiceDescriptors } from "../config.js";
import type { OperationRecord, ServiceRecord } from "../types.js";
import * as store from "../store/operation-store.js";
import { loadSpec, parseAndValidate, resolveBaseUrl } from "./parser.js";
import { extractOperations } from "./operation-extractor.js";
import { ingestGraphql, authHeadersForService } from "./graphql-source.js";
import type { OperationSearch } from "../search/types.js";
import { logAudit } from "../governance/audit.js";

export interface RegisterOptions {
  serviceId: string;
  /** file path, URL, or inline object (OpenAPI) — or GraphQL endpoint URL. */
  source: string | object;
  /** Override the base URL (otherwise first OpenAPI server entry). */
  baseUrl?: string;
  /** Per-operationId risk overrides (also influenced by policy). */
  riskOverrides?: Record<string, "safe" | "elevated" | "dangerous">;
  /**
   * Source type. "openapi" (default) ingests an OpenAPI doc;
   * "graphql" introspects a GraphQL endpoint instead.
   */
  type?: "openapi" | "graphql";
}

export interface RegisterResult {
  serviceId: string;
  inserted: number;
  skipped: boolean; // true if hash matched an existing registration (no-op)
  hash: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Common shape both ingestion paths produce before storage + indexing. */
interface Ingested {
  hash: string;
  operations: OperationRecord[];
  service: ServiceRecord;
}

/** OpenAPI path: load → validate/dereference → extract operations. */
async function ingestOpenapi(opts: RegisterOptions): Promise<Ingested> {
  const loaded = await loadSpec(opts.source);
  const hash = sha256(loaded.raw);
  const parsed = await parseAndValidate(loaded.raw, loaded.absoluteRef);
  const extraction = extractOperations(opts.serviceId, parsed.doc, opts.riskOverrides);
  const auth = getAuthForService(opts.serviceId);
  const baseUrl = opts.baseUrl ?? resolveBaseUrl(parsed.servers);
  return {
    hash,
    operations: extraction.operations,
    service: {
      id: opts.serviceId,
      name: parsed.infoTitle,
      baseUrl,
      specVersion: parsed.openapiVersion,
      specHash: hash,
      authScheme: auth.scheme,
      registeredAt: Date.now(),
    },
  };
}

/** GraphQL path: introspect endpoint → build operations from root fields. */
async function ingestGraphQL(opts: RegisterOptions): Promise<Ingested> {
  if (typeof opts.source !== "string" || !/^https?:\/\//i.test(opts.source)) {
    throw new Error(
      `GraphQL service "${opts.serviceId}" requires source to be an http(s) endpoint URL (got: ${String(opts.source)})`,
    );
  }
  const auth = getAuthForService(opts.serviceId);
  const authHeaders = authHeadersForService(auth);
  const result = await ingestGraphql({
    serviceId: opts.serviceId,
    endpoint: opts.source,
    authHeaders,
    riskOverrides: opts.riskOverrides,
  });
  // GraphQL 的 baseUrl：显式优先，否则从 endpoint 推断（去掉 /graphql 后缀）。
  const baseUrl = opts.baseUrl ?? graphqlEndpointToBase(opts.source);
  return {
    hash: result.hash,
    operations: result.operations,
    service: {
      id: opts.serviceId,
      name: result.infoTitle,
      baseUrl,
      specVersion: "graphql",
      specHash: result.hash,
      authScheme: auth.scheme,
      registeredAt: Date.now(),
    },
  };
}

/** Strip a trailing /graphql (or similar) from an endpoint URL to get the base. */
function graphqlEndpointToBase(endpoint: string): string {
  return endpoint.replace(/\/graphql\/?$/i, "").replace(/\/$/, "");
}

export class Registry {
  constructor(private readonly search: OperationSearch) {}

  async register(opts: RegisterOptions): Promise<RegisterResult> {
    // 分流：GraphQL 走 introspection，否则走 OpenAPI 摄取。两路最终都产出
    // { hash, operations, service }，后半段（存储 + 建索引）完全共用。
    const ingested =
      opts.type === "graphql"
        ? await ingestGraphQL(opts)
        : await ingestOpenapi(opts);

    const { hash, operations, service } = ingested;

    // 去重：哈希未变、且 baseUrl 也没变（或调用方未指定 baseUrl）时跳过。
    const existing = store.getService(opts.serviceId);
    const baseUrlUnchanged = !service.baseUrl || existing?.baseUrl === service.baseUrl;
    if (existing && existing.specHash === hash && baseUrlUnchanged) {
      return { serviceId: opts.serviceId, inserted: 0, skipped: true, hash };
    }

    store.replaceServiceOperations(service, operations);
    await this.search.index(operations.map((o) => ({
      operationId: o.id,
      serviceId: o.serviceId,
      method: o.method,
      path: o.path,
      summary: o.summary,
      description: o.description,
      tags: o.tags,
    })));

    return { serviceId: opts.serviceId, inserted: operations.length, skipped: false, hash };
  }

  async deregister(serviceId: string): Promise<void> {
    // deleteService 会同时清掉 operations 表与 FTS 索引行，无需重建索引。
    store.deleteService(serviceId);
  }

  listServices() {
    return store.listServices();
  }

  getOperation(id: string) {
    return store.getOperation(id);
  }

  /**
   * 注册/刷新 services.yaml 里声明的所有服务，并清理 DB 中已不在配置里的服务。
   *
   * 语义：以 services.yaml 为唯一事实来源——
   *   - 配置里有的：注册/刷新
   *   - 配置里删掉的、或 enabled:false 的：从 DB 移除（含 operation 与 FTS 索引）
   *
   * 仅当配置文件存在时才做清理；文件不存在时不触动 DB（允许纯编程式注册）。
   * 启动时与定时刷新均可安全调用。
   */
  async discover(): Promise<RegisterResult[]> {
    const { descriptors, exists } = loadServiceDescriptors();
    const declaredIds = new Set(descriptors.map((d) => d.id));
    const results: RegisterResult[] = [];

    for (const { id, source, baseUrl, type } of descriptors) {
      try {
        const r = await this.register({ serviceId: id, source, baseUrl, type });
        results.push(r);
        logAudit({
          ts: Date.now(),
          sessionId: "system",
          operationId: `__registry__:${id}`,
          caller: "discover",
          paramsRedacted: "{}",
          statusCode: 0,
          durationMs: 0,
          outcome: "success",
        });
      } catch (err) {
        // 单个 spec 失败不中断其余服务。
        logAudit({
          ts: Date.now(),
          sessionId: "system",
          operationId: `__registry__:${id}`,
          caller: "discover",
          paramsRedacted: "{}",
          statusCode: 0,
          durationMs: 0,
          outcome: "upstream_error",
        });
        console.error(`[registry] 注册 "${id}" 失败（${source}）:`, (err as Error).message);
      }
    }

    // 清理：DB 中存在、但配置里已删除/禁用的服务。
    if (exists) {
      for (const svc of store.listServices()) {
        if (!declaredIds.has(svc.id)) {
          store.deleteService(svc.id); // 同时清 operation 表与 FTS 索引
          console.log(`[registry] 已移除未在配置中声明的服务: ${svc.id}`);
          logAudit({
            ts: Date.now(),
            sessionId: "system",
            operationId: `__registry__:${svc.id}`,
            caller: "discover",
            paramsRedacted: "{}",
            statusCode: 0,
            durationMs: 0,
            outcome: "denied",
          });
        }
      }
    }

    return results;
  }
}
