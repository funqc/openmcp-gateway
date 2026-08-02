/**
 * 集中化的类型化配置。从环境变量（dotenv）加载一次，以冻结单例暴露。
 *
 * 后端服务列表从独立的 YAML 配置文件加载（SERVICES_CONFIG 指向），
 * 见 loadServiceDescriptors()。认证凭据仍走环境变量（AUTH_<ID>_*），
 * 永不写进 yaml、永不返回给调用方。
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { parseYaml } from "@redocly/openapi-core";

export type SearchProvider = "bm25" | "embedding";

export interface ServiceAuthConfig {
  scheme: "bearer" | "basic" | "apikey" | "session" | "none";
  value?: string; // token / "user:pass" / api-key 值
  headerName?: string; // apikey 时用哪个 header（默认 X-API-Key）
  /**
   * 额外的 per-service 自定义 header（从 AUTH_<ID>_HEADERS 加载，JSON 对象）。
   * 典型用途：Bangumi 要求每个请求带合规 User-Agent，否则封禁。
   * 与认证同类管理（都影响请求 header、per-service 配置）。
   */
  headers?: Record<string, string>;
  /**
   * session 方案专用：登录用户名（AUTH_<ID>_USERNAME）。
   * 网关运行时用 username/password 调 loginPath 换会话 cookie，缓存复用。
   */
  username?: string;
  /** session 方案专用：登录密码（AUTH_<ID>_PASSWORD）。 */
  password?: string;
  /** session 方案专用：登录接口路径，拼在 baseUrl 后（AUTH_<ID>_LOGIN_PATH）。 */
  loginPath?: string;
  /** session 方案专用：要从 Set-Cookie 取的 cookie 名（AUTH_<ID>_COOKIE_NAME）。 */
  cookieName?: string;
}

/** services.yaml 里每个服务的声明。 */
export interface ServiceDescriptor {
  /** 服务 id（slug），全局唯一，如 "files"。 */
  id: string;
  /**
   * 服务文档来源。
   *   - openapi（默认）：HTTP(S) URL 或本地文件路径，指向 OpenAPI 文档。
   *   - graphql：HTTP(S) URL，指向 GraphQL 端点（通常形如 https://host/graphql），
   *     网关会对其做 introspection 来发现 operation。
   */
  source: string;
  /** 可选：覆盖 spec 里声明的 baseUrl（spec 缺 server 或想改写时用）。 */
  baseUrl?: string;
  /** 可选：该服务默认是否启用（缺省 true）。 */
  enabled?: boolean;
  /** 可选：服务类型。"openapi"（默认）或 "graphql"。 */
  type?: "openapi" | "graphql";
  /**
   * 可选：该服务访问上游时走的 http(s) 代理 URL，如 "http://127.0.0.1:7890"。
   * 设置后，执行 operation、拉取 spec、GraphQL introspection 三处对该
   * 服务的所有请求都经此代理。未设置则直连。
   */
  proxy?: string;
}

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  searchProvider: SearchProvider;
  embeddingModel: string;
  policyPath: string;
  redactFields: string[];
  /** services.yaml 配置文件路径。 */
  servicesConfig: string;
  /** 认证凭据，key 为大写服务 id。 */
  auth: Record<string, ServiceAuthConfig>;
  /**
   * 网关 /mcp 端点的访问鉴权 key（静态 API Key）。
   * 未配置（空）时不鉴权——仅适合本机 127.0.0.1 部署。
   * 公网/内网暴露时【必须】配置。
   */
  gatewayApiKey: string;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 解析 AUTH_<ID>_HEADERS 环境变量（JSON 对象，如 {"User-Agent":"..."}）。
 * 解析失败或非对象时 warn 并返回 undefined（不影响启动）。
 */
function parseExtraHeaders(raw: string | undefined, serviceId: string): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(`[config] AUTH_${serviceId}_HEADERS 不是 JSON 对象，已忽略`);
      return undefined;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") headers[k] = v;
    }
    return Object.keys(headers).length ? headers : undefined;
  } catch (err) {
    console.warn(`[config] AUTH_${serviceId}_HEADERS 解析失败:`, (err as Error).message);
    return undefined;
  }
}

function loadAuth(): Record<string, ServiceAuthConfig> {
  const out: Record<string, ServiceAuthConfig> = {};
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^AUTH_(.+)_SCHEME$/);
    if (!m) continue;
    const serviceId = m[1];
    const scheme = (process.env[key] || "none").toLowerCase() as ServiceAuthConfig["scheme"];
    const value = process.env[`AUTH_${serviceId}_VALUE`];
    const headerName = process.env[`AUTH_${serviceId}_HEADER`];
    const headers = parseExtraHeaders(process.env[`AUTH_${serviceId}_HEADERS`], serviceId);
    const username = process.env[`AUTH_${serviceId}_USERNAME`];
    const password = process.env[`AUTH_${serviceId}_PASSWORD`];
    const loginPath = process.env[`AUTH_${serviceId}_LOGIN_PATH`];
    const cookieName = process.env[`AUTH_${serviceId}_COOKIE_NAME`];
    out[serviceId.toLowerCase()] = {
      scheme,
      value,
      headerName: headerName || (scheme === "apikey" ? "X-API-Key" : undefined),
      headers,
      username,
      password,
      loginPath,
      cookieName,
    };
  }
  return out;
}

function build(): Config {
  return {
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? "127.0.0.1",
    dbPath: process.env.DB_PATH ?? "./data/registry.db",
    searchProvider: (process.env.SEARCH_PROVIDER ?? "bm25") as SearchProvider,
    embeddingModel: process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2",
    policyPath: process.env.POLICY_PATH ?? "./data/policy.json",
    redactFields: parseList(process.env.REDACT_FIELDS).map((f) => f.toLowerCase()),
    servicesConfig: process.env.SERVICES_CONFIG ?? "./data/services.yaml",
    auth: loadAuth(),
    gatewayApiKey: process.env.GATEWAY_API_KEY ?? "",
  };
}

export const config: Config = Object.freeze(build());

export function getAuthForService(serviceId: string): ServiceAuthConfig {
  // loadAuth 以小写 serviceId 为 key 存储，这里统一用小写查找。
  return config.auth[serviceId.toLowerCase()] ?? { scheme: "none" as const };
}

/**
 * 从 services.yaml 加载服务声明列表。
 *
 * 文件不存在时返回 { descriptors: [], exists: false }（网关仍可启动，
 * 只是没有自动注册的服务，也不会清理 DB；可后续通过 registry.register() 编程式注册）。
 *
 * enabled:false 的服务会被过滤掉（不出现在 descriptors 里），
 * 调用方可用 exists 判断是否应做"以配置为准"的清理。
 */
export function loadServiceDescriptors(): { descriptors: ServiceDescriptor[]; exists: boolean } {
  const path = config.servicesConfig;
  if (!existsSync(path)) return { descriptors: [], exists: false };

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    console.warn(`[config] 解析 ${path} 失败:`, (err as Error).message);
    return { descriptors: [], exists: true };
  }

  const doc = parsed as { services?: ServiceDescriptor[] } | null;
  const list = doc?.services ?? [];
  if (!Array.isArray(list)) {
    console.warn(`[config] ${path} 的 "services" 不是数组，已忽略`);
    return { descriptors: [], exists: true };
  }

  const descriptors = list.filter((s) => {
    if (!s?.id || !s?.source) {
      console.warn(`[config] 跳过无效服务声明（缺 id 或 source）: ${JSON.stringify(s)}`);
      return false;
    }
    // 校验 proxy：必须是 http(s)://，否则忽略并降级为直连（不阻断启动）。
    if (s.proxy !== undefined && s.proxy !== "" && !/^https?:\/\//i.test(s.proxy)) {
      console.warn(`[config] 服务 "${s.id}" 的 proxy 不是 http(s) URL，已忽略: ${s.proxy}`);
      s.proxy = undefined;
    }
    return s.enabled !== false;
  });
  return { descriptors, exists: true };
}
