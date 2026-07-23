/**
 * 启动脚本：拉起一个内联 mock 上游 + 注册内联 spec，打印注册摘要。
 * 用于验证注册中心流水线（解析 → 解引用 → 提取 → 存储 → 建索引），不启动 HTTP 服务。
 * 独立可跑，不依赖 data/services.yaml 或任何外部后端。
 */
import { getRegistry } from "../src/services.js";
import { listServices } from "../src/store/operation-store.js";
import { closeDb } from "../src/store/db.js";
import { DEMO_SPEC, startMockUpstream } from "./lib/test-fixture.js";

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
