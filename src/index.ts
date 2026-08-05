/**
 * Entrypoint: boot the gateway.
 *
 *   1. Open the SQLite store (migrations run on import of store/db.js)
 *   2. Build the search backend + registry
 *   3. Discover + register all configured services (boot-time ingestion)
 *   4. Start the Streamable-HTTP MCP server on /mcp
 */
import { config, loadServiceDescriptors } from "./config.js";
import { createApp, closeApp } from "./transport.js";
import { getRegistry } from "./services.js";

async function main(): Promise<void> {
  const serviceCount = loadServiceDescriptors().descriptors.length;
  // 启动 banner：第一时间告诉用户在干嘛，避免随后几十秒静默（embedding 模型加载 +
  // 逐个 fetch spec 都需要时间）。createSearch() 内部会再打一行搜索后端日志。
  // eslint-disable-next-line no-console
  console.log(
    `[openmcp-gateway] 启动中… (host=${config.host}:${config.port}, search=${config.searchProvider}, services=${serviceCount})`,
  );

  // getRegistry() 会首次构造 Registry 并初始化搜索后端（embedding 模式加载 ONNX 模型，
  // 可能耗时十几秒，期间已有「加载搜索后端…」日志提示）。
  const registry = await getRegistry();

  // Boot-time discovery：discover() 内部会逐条打印每个服务的注册进度 + 收尾汇总，
  // 这里不再额外打印，避免重复。
  await registry.discover();

  const app = createApp();
  const httpServer = app.listen(config.port, config.host, () => {
    const base = `http://${config.host}:${config.port}`;
    console.log(`[openmcp-gateway] 已启动，对外提供两条独立通路：`);
    console.log(`[openmcp-gateway]   • MCP  通路：  ${base}/mcp                        （search_api + execute_api 工具）`);
    console.log(`[openmcp-gateway]   • CLI  通路（REST，与 MCP 共用同一 API Key）：`);
    console.log(`[openmcp-gateway]       GET  ${base}/search?q=<自然语言>      语义检索`);
    console.log(`[openmcp-gateway]       GET  ${base}/services                   服务清单`);
    console.log(`[openmcp-gateway]       GET  ${base}/ops?service_id=<id>        operation 清单`);
    console.log(`[openmcp-gateway]       POST ${base}/exec/<operation_id>        执行 operation`);
    console.log(`[openmcp-gateway]       GET  ${base}/audit?limit=N              最近 N 条审计`);
    console.log(`[openmcp-gateway]   health：${base}/health`);
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
