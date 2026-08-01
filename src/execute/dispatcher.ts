/**
 * Per-service HTTP(S) proxy dispatcher.
 *
 * Services declared with a `proxy` URL route their upstream traffic through a
 * cached `undici.ProxyAgent`; services without one reuse a single shared direct
 * `Agent` (connection pool). The same resolver feeds all three upstream call
 * sites — execute, OpenAPI spec fetch, and GraphQL introspection — so a proxy
 * configured for a service applies uniformly to every request made to it.
 *
 * Only `http://` / `https://` proxies are supported (undici's ProxyAgent handles
 * both, plus CONNECT tunneling for https targets). No new dependencies: undici
 * is already a runtime dependency used by the executor.
 */
import { Agent, ProxyAgent } from "undici";

// Shared connection pool for all direct (non-proxied) upstream calls.
const directAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

// One ProxyAgent per proxy URL, reused across requests and services that share
// the same proxy. ProxyAgent owns its own connection pool to the proxy.
const proxyCache = new Map<string, ProxyAgent>();

/**
 * Resolve the dispatcher for a given proxy URL.
 * - Empty/undefined → the shared direct Agent.
 * - Otherwise → a cached ProxyAgent for that proxy URL.
 */
export function getDispatcher(proxyUrl?: string): Agent | ProxyAgent {
  if (!proxyUrl) return directAgent;
  let pa = proxyCache.get(proxyUrl);
  if (!pa) {
    pa = new ProxyAgent(proxyUrl);
    proxyCache.set(proxyUrl, pa);
  }
  return pa;
}
