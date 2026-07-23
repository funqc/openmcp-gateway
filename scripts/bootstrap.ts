/**
 * 启动脚本：拉起一个内联 mock 上游 + 注册内联 spec，打印注册摘要。
 * 用于验证注册中心流水线（解析 → 解引用 → 提取 → 存储 → 建索引），不启动 HTTP 服务。
 * 独立可跑，不依赖 data/services.yaml 或任何外部后端。
 *
 * 重要：本脚本必须用隔离 DB，绝不污染生产库 data/registry.db。在加载任何
 * src 模块（它们会读取 config.dbPath）之前，先把 DB_PATH 指向临时文件。
 * 显式设了 DB_PATH 的调用方（如 DB_PATH=... npm run bootstrap）予以尊重。
 * 用动态 import 确保 src 在 DB_PATH 确定后才加载。
 */
process.env.DB_PATH = process.env.DB_PATH ?? "./data/bootstrap-registry.db";
import { DEMO_SPEC, startMockUpstream } from "./lib/test-fixture.js";
const { getRegistry } = await import("../src/services.js");
const { listServices } = await import("../src/store/operation-store.js");
const { closeDb } = await import("../src/store/db.js");

async function main(): Promise<void> {
  const upstream = await startMockUpstream();
  try {
    const registry = await getRegistry();
    const r = await registry.register({
      serviceId: "files",
      source: DEMO_SPEC,
      baseUrl: upstream.baseUrl,
    });
    console.log(`files: ${r.skipped ? "已是最新" : `注册了 ${r.inserted} 个 operation`} (hash ${r.hash.slice(0, 8)})`);
    console.log("\n已注册服务：");
    for (const s of listServices()) {
      console.log(`  ${s.id} — ${s.name} (${s.specVersion}) @ ${s.baseUrl} [auth:${s.authScheme}]`);
    }
  } finally {
    await upstream.close();
    closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
