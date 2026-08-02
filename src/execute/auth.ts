/**
 * AuthResolver: maps a registered service's auth scheme to the HTTP headers
 * that should be attached to the upstream call.
 *
 * Credentials are sourced from environment (config.auth) — never from the
 * caller, and never returned in tool output. The resolver is the *only*
 * place credentials touch request headers.
 *
 * Supported schemes:
 *   - bearer  : `Authorization: Bearer <value>`
 *   - basic   : `Authorization: Basic <base64(value)>`  (value = "user:pass")
 *   - apikey  : `<headerName|X-API-Key>: <value>`
 *   - session : 用 username/password 调 loginPath 换会话 cookie，
 *               注入 `Cookie: <cookieName>=<sid>`，缓存复用到接近过期再重登。
 *   - none    : 不注入
 *
 * 自定义 per-service header（AUTH_<ID>_HEADERS）始终最后合并、覆盖同名 header。
 */
import { request } from "undici";
import { getAuthForService, type ServiceAuthConfig } from "../config.js";
import { getDispatcher } from "./dispatcher.js";
import type { ServiceRecord } from "../types.js";

export interface ResolvedAuth {
  headers: Record<string, string>;
}

export async function resolveAuthHeaders(service: ServiceRecord): Promise<ResolvedAuth> {
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
    case "session": {
      const cookie = await getSessionCookie(service, cfg);
      if (cookie) headers["Cookie"] = cookie;
      break;
    }
    case "none":
    default:
      break;
  }
  // Merge per-service custom headers (from AUTH_<ID>_HEADERS), e.g. Bangumi
  // requires a compliant User-Agent. Applied last so they win over any same-named
  // header above; they do not overlap with Authorization/X-*-Key scheme headers.
  if (cfg.headers) Object.assign(headers, cfg.headers);
  return { headers };
}

// ---------------------------------------------------------------------------
// session scheme: 登录换 cookie + 进程内缓存
// ---------------------------------------------------------------------------

interface CachedSession {
  /** 完整的 Cookie header 值，如 "QBT_SID_8080=xxx"。 */
  value: string;
  /** 过期 epoch 毫秒；到点视为失效、重新登录。 */
  expiresAt: number;
}

/** serviceId(小写) → 缓存的会话。进程级、重启即清空。 */
const sessionCache = new Map<string, CachedSession>();

/** 进行中的登录 promise，避免并发请求同时登录同一服务。 */
const inflight = new Map<string, Promise<CachedSession>>();

/** 登录 cookie 解析不出 expires 时的兜底有效期。 */
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h，与 qBittorrent 默认会话一致
/** 提前这么多毫秒视为过期，避免取到 cookie、发请求时恰好失效。 */
const EXPIRY_SKEW_MS = 30_000;

/**
 * 取该服务当前有效的会话 Cookie header 值。
 * 缓存命中且未过期 → 直接返回；否则触发一次登录（并发去重）。
 * 登录失败抛错，由 executor 映射为上游错误（退出码 6/7）。
 */
async function getSessionCookie(service: ServiceRecord, cfg: ServiceAuthConfig): Promise<string | undefined> {
  if (!cfg.username || !cfg.password || !cfg.loginPath || !cfg.cookieName) {
    // 配置不全：静默跳过（不注入 Cookie），上游多半返回 401，错误信息对用户更直观。
    return undefined;
  }
  const key = service.id.toLowerCase();
  const now = Date.now();
  const hit = sessionCache.get(key);
  if (hit && hit.expiresAt - EXPIRY_SKEW_MS > now) {
    return hit.value;
  }
  // 缓存缺失/将过期：登录。同 service 并发只发一次实际请求。
  let p = inflight.get(key);
  if (!p) {
    p = doLogin(service, cfg).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const session = await p;
  sessionCache.set(key, session);
  return session.value;
}

/**
 * 用 username/password POST 到 loginPath，解析 Set-Cookie 取 cookieName。
 * 走 service 的 proxy dispatcher，与执行 operation 同链路。
 */
async function doLogin(service: ServiceRecord, cfg: ServiceAuthConfig): Promise<CachedSession> {
  const url = joinUrl(service.baseUrl, cfg.loginPath!);
  const body = `username=${encodeURIComponent(cfg.username!)}&password=${encodeURIComponent(cfg.password!)}`;
  let res;
  try {
    res = await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      dispatcher: getDispatcher(service.proxyUrl),
    });
  } catch (err) {
    // 网络层失败（DNS/连接/代理）—— 不含凭据，可直接抛。
    throw new Error(`session login 请求失败 (${service.id}): ${(err as Error).message}`);
  }

  // qBittorrent 登录成功返回 200/204；多数失败返回 401/403。
  if (res.statusCode !== 200 && res.statusCode !== 204) {
    // 主动消费 body 以释放 socket。
    try { await res.body.text(); } catch { /* ignore */ }
    throw new Error(`session login 被拒 (${service.id}): HTTP ${res.statusCode}`);
  }

  // Set-Cookie 可能是数组（多个 cookie）或单个字符串。
  const raw = res.headers["set-cookie"];
  const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  try { await res.body.text(); } catch { /* ignore */ }

  const matched = setCookies.find((c) => parseCookieName(c) === cfg.cookieName);
  if (!matched) {
    throw new Error(
      `session login 未在 Set-Cookie 中找到 ${cfg.cookieName} (${service.id})`
    );
  }
  const cookieValue = extractCookieValue(matched);
  const expiresAt = parseExpires(matched) ?? Date.now() + DEFAULT_TTL_MS;
  return { value: `${cfg.cookieName}=${cookieValue}`, expiresAt };
}

/** 拼 baseUrl 与 loginPath，处理斜杠边界。 */
function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path; // loginPath 已是绝对 URL
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** 从 "NAME=val; Path=/; ..." 里取 "NAME"。 */
function parseCookieName(setCookie: string): string {
  return setCookie.split("=", 1)[0].trim();
}

/** 从 "NAME=val; Path=/; ..." 里取 "val"（到第一个分号前）。 */
function extractCookieValue(setCookie: string): string {
  const first = setCookie.split(";", 1)[0].trim(); // "NAME=val"
  const eq = first.indexOf("=");
  return eq >= 0 ? first.slice(eq + 1) : "";
}

/**
 * 解析 Set-Cookie 里的 Expires=（HttpOnly cookie 常见）。
 * 解析失败返回 undefined，由调用方兜底默认 TTL。
 */
function parseExpires(setCookie: string): number | undefined {
  const m = /expires=([^;]+)/i.exec(setCookie);
  if (!m) return undefined;
  const t = Date.parse(m[1].trim());
  return Number.isNaN(t) ? undefined : t;
}
