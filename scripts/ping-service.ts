/**
 * Per-service 联通自检 CLI —— 不启动 HTTP、不依赖 DB，
 * 直接探测 services.yaml 里声明的每个服务是否可达、认证是否有效。
 *
 * 凭据来源与网关运行时完全一致：服务声明读 services.yaml，
 * 认证读 .env 的 AUTH_<ID>__*（均复用 config.ts 的加载逻辑）。
 *
 * 用法：
 *   npx tsx scripts/ping-service.ts              # 测所有 enabled 的服务
 *   npx tsx scripts/ping-service.ts emby         # 只测指定服务
 *   npx tsx scripts/ping-service.ts emby kavita  # 测多个
 *
 * 探测项（每个服务）：
 *   ① spec 可达性  —— 拉 source（OpenAPI 文档 / GraphQL introspection）
 *   ② 业务可达性  —— 带认证请求一个轻量 GET（OpenAPI）或 GraphQL ping
 *   ③ 认证有效性  —— ②的响应里是否出现 401/403
 */
import { Agent, request } from "undici";
import { loadServiceDescriptors, getAuthForService, type ServiceDescriptor } from "../src/config.js";

const TIMEOUT_MS = 10_000;

/** 共享连接池，跟 executor 保持一致的姿态。 */
const agent = new Agent({
  connect: { timeout: TIMEOUT_MS },
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS,
});

interface ProbeResult {
  ok: boolean;
  status?: number;
  durationMs: number;
  detail: string;
}

async function probe(url: string, headers: Record<string, string>): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await request(url, { method: "GET", headers, dispatcher: agent });
    const text = await res.body.text().catch(() => "");
    const durationMs = Date.now() - t0;
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    // 把响应体截断到一行便于展示；401/403 等也把上游提示带出来
    const snippet = text.replace(/\s+/g, " ").slice(0, 120);
    return {
      ok,
      status: res.statusCode,
      durationMs,
      detail: ok ? (snippet || "(空响应体)") : `HTTP ${res.statusCode} ${snippet}`,
    };
  } catch (err) {
    return { ok: false, durationMs: Date.now() - t0, detail: (err as Error).message };
  }
}

async function probeGraphql(
  url: string,
  headers: Record<string, string>
): Promise<ProbeResult> {
  // GraphQL：发一个 introspection 的 __typename 查询，既验证端点可达又验证认证
  const query = "{ __schema { queryType { name } } }";
  const t0 = Date.now();
  try {
    const res = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ query }),
      dispatcher: agent,
    });
    const text = await res.body.text().catch(() => "");
    const durationMs = Date.now() - t0;
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    const snippet = text.replace(/\s+/g, " ").slice(0, 120);
    return { ok, status: res.statusCode, durationMs, detail: ok ? (snippet || "(空响应体)") : `HTTP ${res.statusCode} ${snippet}` };
  } catch (err) {
    return { ok: false, durationMs: Date.now() - t0, detail: (err as Error).message };
  }
}

/** 把 ServiceAuthConfig 解析成实际请求头（与 execute/auth.ts 同语义，但这里不依赖 ServiceRecord）。 */
function authHeaders(id: string): Record<string, string> {
  const cfg = getAuthForService(id);
  const h: Record<string, string> = {};
  switch (cfg.scheme) {
    case "bearer":
      if (cfg.value) h["Authorization"] = `Bearer ${cfg.value}`;
      break;
    case "basic":
      if (cfg.value) h["Authorization"] = `Basic ${Buffer.from(cfg.value).toString("base64")}`;
      break;
    case "apikey":
      if (cfg.value) h[cfg.headerName ?? "X-API-Key"] = cfg.value;
      break;
    case "none":
    default:
      break;
  }
  return h;
}

/** 从 baseUrl 推一个"最可能公开/轻量"的健康端点。不同后端的约定有差异，按 host 兜底。 */
function pickHealthPath(baseUrl: string): string {
  // 常见 OpenAPI 服务都暴露 /System/Info/Public（emby）或 /health 或 /api/v1/status
  // 这里不穷举，只给一个最通用的兜底；具体服务可在 services.yaml 加 pingPath 覆盖（见下）。
  const u = new URL(baseUrl);
  const host = u.hostname.toLowerCase();
  if (host.includes("emby")) return "/System/Info/Public";
  if (host.includes("jellyfin")) return "/System/Info/Public";
  if (host.includes("seerr") || host.includes("jellyseerr")) return "/status";
  return "/health";
}

function mark(r: ProbeResult): string {
  return r.ok ? "✅" : "❌";
}

async function pingOne(svc: ServiceDescriptor): Promise<boolean> {
  const isGraphql = svc.type === "graphql";
  const auth = authHeaders(svc.id);
  const authLabel =
    Object.keys(auth).length > 0 ? Object.keys(auth).join(",") : "(无认证)";

  console.log(`\n▌ ${svc.id}  [${isGraphql ? "graphql" : "openapi"}]`);
  console.log(`  source:  ${svc.source}`);
  console.log(`  baseUrl: ${svc.baseUrl ?? "(取自 spec)"}`);
  console.log(`  auth:    ${authLabel}`);

  let allOk = true;

  // ① spec 可达性
  const specProbe = isGraphql
    ? await probeGraphql(svc.source, auth)
    : await probe(svc.source, {});
  console.log(`  ${mark(specProbe)} spec      ${specProbe.status ?? "--"}  ${specProbe.durationMs}ms  ${specProbe.detail}`);
  if (!specProbe.ok) allOk = false;

  // ② 业务可达性（OpenAPI 服务才做：带认证 ping 一个轻量 GET）
  if (!isGraphql && svc.baseUrl) {
    const health = `${svc.baseUrl.replace(/\/$/, "")}${pickHealthPath(svc.baseUrl)}`;
    const biz = await probe(health, auth);
    console.log(`  ${mark(biz)} business  ${biz.status ?? "--"}  ${biz.durationMs}ms  ${biz.detail}`);
    console.log(`           ↳ ${health}`);
    if (!biz.ok) allOk = false;
  }

  return allOk;
}

async function main() {
  const [, , ...ids] = process.argv;
  const { descriptors } = loadServiceDescriptors();

  if (!descriptors.length) {
    console.log("services.yaml 里没有 enabled 的服务（或文件缺失）。");
    process.exit(1);
  }

  const targets = ids.length
    ? descriptors.filter((s) => ids.includes(s.id))
    : descriptors;

  if (!targets.length) {
    console.log(`未找到匹配的服务。已声明: ${descriptors.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`探测 ${targets.length} 个服务（超时 ${TIMEOUT_MS / 1000}s/请求）`);

  let pass = 0;
  for (const svc of targets) {
    const ok = await pingOne(svc);
    if (ok) pass++;
  }

  console.log(`\n—— ${pass}/${targets.length} 个服务全部探测通过 ——`);
  await agent.close();
  process.exit(pass === targets.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
