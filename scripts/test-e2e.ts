/**
 * 端到端测试：拉起一个内联 mock 上游 + 注册内联 spec，
 * 直接对网关内部服务测试 search_api + execute_api（无需 HTTP），
 * 覆盖脱敏、风险闸、审计等路径。
 *
 * 独立可跑：npm run test:e2e
 *
 * 重要：测试必须用隔离 DB，绝不污染生产库 data/registry.db（否则每次启动
 * discover() 都会因 demo 'files' 服务不在 services.yaml 而报「已移除」）。
 * 因为 src 模块在 import 时就读取 config（含 DB_PATH），必须在 import 任何
 * src 之前设好 DB_PATH——所以用动态 import 延迟到 env 设好之后。
 */
process.env.DB_PATH = process.env.DB_PATH ?? "./data/test-registry.db";

// 副作用模块（不依赖 config）可静态 import。
import { DEMO_SPEC, startMockUpstream } from "./lib/test-fixture.js";

// src 模块延迟到 DB_PATH 确定后再 import。
const { getRegistry, getSearch } = await import("../src/services.js");
const store = await import("../src/store/operation-store.js");
const { execute } = await import("../src/execute/executor.js");
const { closeDb } = await import("../src/store/db.js");
const { recentAudit } = await import("../src/governance/audit.js");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

async function main(): Promise<void> {
  const upstream = await startMockUpstream();
  try {
    // 1. 注册内联 spec。
    const registry = await getRegistry();
    await registry.register({ serviceId: "files", source: DEMO_SPEC, baseUrl: upstream.baseUrl });
    assert(registry.listServices().some((s) => s.id === "files"), "演示 'files' 服务已注册");

    // 2. SEARCH —— 自然语言意图。
    console.log("\n— search_api: 'how do I delete a file?'");
    const backend = await getSearch();
    const hits = await backend.search({ query: "delete a file permanently", limit: 5 });
    assert(hits.length > 0, "检索返回了结果");
    const deleteOp = hits.find((h) => h.operationId === "files_deleteFile");
    assert(!!deleteOp, "结果中包含 files_deleteFile");
    if (deleteOp) console.log(`    score=${deleteOp.score.toFixed(3)}`);

    // 3. EXECUTE —— 安全读。
    console.log("\n— execute_api: files_listFiles (safe GET)");
    const listRes = await execute("files_listFiles", { limit: 10 }, undefined, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(listRes.ok === true && listRes.status === "success", "files_listFiles 成功");
    assert(Array.isArray((listRes.data as { items?: unknown[] })?.items), "返回了文件列表");

    // 4. EXECUTE —— 校验错误（createFile 缺 body）。
    console.log("\n— execute_api: files_createFile (validation_error — 缺 body)");
    const badRes = await execute("files_createFile", undefined, undefined, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(badRes.status === "validation_error", "files_createFile 缺 body → validation_error");

    // 5. EXECUTE —— 危险操作未确认 → confirmation_required。
    console.log("\n— execute_api: files_deleteFile (dangerous, 未 confirm → confirmation_required)");
    const gateRes = await execute("files_deleteFile", { fileId: "f-1" }, undefined, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(gateRes.status === "confirmation_required", "files_deleteFile 未 confirm → confirmation_required");

    // 6. EXECUTE —— 危险操作确认后执行。先建一个新文件，保证可重复运行。
    console.log("\n— execute_api: files_deleteFile (confirm:true → 执行)");
    const created = await execute("files_createFile", { body: { path: `/tmp/e2e-${Date.now()}.txt`, contents: "hello" } }, true, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(created.ok === true, "files_createFile 成功（为删除做准备）");
    const targetId = (created.data as { id?: string })?.id ?? "f-1";
    const delRes = await execute("files_deleteFile", { fileId: targetId }, true, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(delRes.ok === true, `files_deleteFile confirm 后成功 (id=${targetId})`);

    // 7. MASKING —— resetShareAccess 响应中 access_token 应被脱敏。
    console.log("\n— execute_api: files_resetShareAccess (响应脱敏)");
    const shareRes = await execute("files_resetShareAccess", { shareId: "s-1" }, true, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(shareRes.ok === true, "files_resetShareAccess 成功");
    const token = (shareRes.data as { access_token?: string } | undefined)?.access_token;
    assert(token === "[REDACTED]", `响应中 access_token 已脱敏 (实际: ${token})`);

    // 8. AUDIT —— 每次调用都有记录，参数已脱敏。
    console.log("\n— audit log");
    const audit = recentAudit(50);
    assert(audit.length >= 5, "审计日志捕获了调用");
    assert(audit.every((a) => typeof a.params_redacted === "string"), "所有审计行的 params 均为 JSON 字符串");
    const ops = new Set(audit.map((a) => a.operation_id));
    assert(ops.has("files_deleteFile") && ops.has("files_listFiles"), "审计覆盖了多个 operation");

    // 9. 未知 operationId。
    console.log("\n— execute_api: 未知 operationId");
    const nf = await execute("doesNotExist", {}, undefined, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(nf.status === "not_found", "未知 op → not_found");

    console.log(`\n${failures === 0 ? "✅ 全部通过" : `❌ ${failures} 项失败`}`);
  } finally {
    await upstream.close();
    closeDb();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
