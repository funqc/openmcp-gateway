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
import { extractOperations, OPERATION_SCHEMA_VERSION } from "./operation-extractor.js";
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
  /**
   * Optional http(s) proxy URL for all upstream access to this service
   * (execute, spec fetch, introspection). Empty/undefined = direct.
   */
  proxyUrl?: string;
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
  // Spec is fetched direct (no proxy): proxy is reserved for runtime execution
  // against the service's real API, and the spec often lives on a different host.
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
      schemaVersion: OPERATION_SCHEMA_VERSION,
      proxyUrl: opts.proxyUrl ?? "",
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
    proxyUrl: opts.proxyUrl,
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
      schemaVersion: OPERATION_SCHEMA_VERSION,
      proxyUrl: opts.proxyUrl ?? "",
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

    // 去重：哈希未变、baseUrl 未变、proxyUrl 未变、且提取逻辑版本号也不低于
    // 当前值时才跳过。schemaVersion 变了（如本次加 service 前缀）即使 spec hash
    // 相同也强制重提，保证存量 DB 升级到最新提取逻辑。
    // proxyUrl 纳入比较：改了 services.yaml 的 proxy 后，重启就能更新到 DB
    // （否则 execute 会用老的空 proxyUrl 直连，该走代理的服务会超时）。
    const existing = store.getService(opts.serviceId);
    const baseUrlUnchanged = !service.baseUrl || existing?.baseUrl === service.baseUrl;
    const proxyUrlUnchanged = existing?.proxyUrl === service.proxyUrl;
    const schemaUpToDate = !existing || existing.schemaVersion >= OPERATION_SCHEMA_VERSION;
    if (existing && existing.specHash === hash && baseUrlUnchanged && proxyUrlUnchanged && schemaUpToDate) {
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
    const total = descriptors.length;
    let idx = 0;
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    const discoverStart = Date.now();

    for (const { id, source, baseUrl, type, proxy } of descriptors) {
      idx++;
      const t0 = Date.now();
      try {
        const r = await this.register({ serviceId: id, source, baseUrl, type, proxyUrl: proxy });
        results.push(r);
        const elapsed = Date.now() - t0;
        // 每个服务注册完立刻打一行进度（不再等全部跑完），避免长时间静默。
        if (r.skipped) {
          skipped++;
          console.log(`[registry] (${idx}/${total}) ${id} … up-to-date (hash ${r.hash.slice(0, 8)})，用时 ${elapsed}ms`);
        } else {
          succeeded++;
          console.log(`[registry] (${idx}/${total}) ${id} … 注册了 ${r.inserted} 个 operation (hash ${r.hash.slice(0, 8)})，用时 ${elapsed}ms`);
        }
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
        failed++;
        const elapsed = Date.now() - t0;
        // 单个 spec 失败不中断其余服务。
        console.error(`[registry] (${idx}/${total}) ${id} … 注册失败（${source}），用时 ${elapsed}ms:`, (err as Error).message);
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
      }
    }

    // 收尾汇总。
    const totalElapsed = ((Date.now() - discoverStart) / 1000).toFixed(1);
    console.log(
      `[registry] 发现完成：${total} 个服务，成功 ${succeeded}，跳过 ${skipped}（已是最新），失败 ${failed}，总用时 ${totalElapsed}s`,
    );

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
