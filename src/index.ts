/**
 * Entrypoint: boot the gateway.
 *
 *   1. Open the SQLite store (migrations run on import of store/db.js)
 *   2. Build the search backend + registry
 *   3. Discover + register all configured services (boot-time ingestion)
 *   4. Start the Streamable-HTTP MCP server on /mcp
 */
import { config } from "./config.js";
import { createApp, closeApp } from "./transport.js";
import { getRegistry } from "./services.js";

async function main(): Promise<void> {
  const registry = await getRegistry();

  // Boot-time discovery (register demo services if configured).
  const results = await registry.discover();
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`[registry] ${r.serviceId}: ${r.skipped ? "up-to-date" : `registered ${r.inserted} operations`} (hash ${r.hash.slice(0, 8)})`);
  }

  const app = createApp();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`[openmcp-gateway] MCP endpoint:  http://${config.host}:${config.port}/mcp`);
    console.log(`[openmcp-gateway] health:        http://${config.host}:${config.port}/health`);
    console.log(`[openmcp-gateway] search backend: ${config.searchProvider}`);
    if (config.gatewayApiKey) {
      console.log(`[openmcp-gateway] 访问鉴权:      已启用（API Key）`);
    } else if (config.host !== "127.0.0.1" && config.host !== "localhost") {
      console.warn(`[openmcp-gateway] ⚠️  警告: HOST=${config.host} 但未配置 GATEWAY_API_KEY，/mcp 无鉴权暴露！`);
    } else {
      console.log(`[openmcp-gateway] 访问鉴权:      未启用（仅本机）`);
    }
  });

  const shutdown = async () => {
    await closeApp(app);
    httpServer.close(() => process.exit(0));
    // Force-exit after 3s if close hangs.
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[openmcp-gateway] fatal:", err);
  process.exit(1);
});
