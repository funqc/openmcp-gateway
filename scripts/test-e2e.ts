/**
 * 端到端测试：拉起一个内联 mock 上游 + 注册内联 spec，
 * 直接对网关内部服务测试 search_api + execute_api（无需 HTTP），
 * 覆盖脱敏、风险闸、审计等路径。
 *
 * 独立可跑：npm run test:e2e
 */
import { getRegistry, getSearch } from "../src/services.js";
import * as store from "../src/store/operation-store.js";
import { execute } from "../src/execute/executor.js";
import { closeDb } from "../src/store/db.js";
import { recentAudit } from "../src/governance/audit.js";
import { DEMO_SPEC, startMockUpstream } from "./lib/test-fixture.js";

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
    const deleteOp = hits.find((h) => h.operationId === "deleteFile");
    assert(!!deleteOp, "结果中包含 deleteFile");
    if (deleteOp) console.log(`    score=${deleteOp.score.toFixed(3)}`);

    // 3. EXECUTE —— 安全读。
    console.log("\n— execute_api: listFiles (safe GET)");
    const listRes = await execute("listFiles", { limit: 10 }, undefined, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(listRes.ok === true && listRes.status === "success", "listFiles 成功");
    assert(Array.isArray((listRes.data as { items?: unknown[] })?.items), "返回了文件列表");

    // 4. EXECUTE —— 校验错误（createFile 缺 body）。
    console.log("\n— execute_api: createFile (validation_error — 缺 body)");
    const badRes = await execute("createFile", undefined, undefined, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(badRes.status === "validation_error", "createFile 缺 body → validation_error");

    // 5. EXECUTE —— 危险操作未确认 → confirmation_required。
    console.log("\n— execute_api: deleteFile (dangerous, 未 confirm → confirmation_required)");
    const gateRes = await execute("deleteFile", { fileId: "f-1" }, undefined, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(gateRes.status === "confirmation_required", "deleteFile 未 confirm → confirmation_required");

    // 6. EXECUTE —— 危险操作确认后执行。先建一个新文件，保证可重复运行。
    console.log("\n— execute_api: deleteFile (confirm:true → 执行)");
    const created = await execute("createFile", { body: { path: `/tmp/e2e-${Date.now()}.txt`, contents: "hello" } }, true, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(created.ok === true, "createFile 成功（为删除做准备）");
    const targetId = (created.data as { id?: string })?.id ?? "f-1";
    const delRes = await execute("deleteFile", { fileId: targetId }, true, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(delRes.ok === true, `deleteFile confirm 后成功 (id=${targetId})`);

    // 7. MASKING —— resetShareAccess 响应中 access_token 应被脱敏。
    console.log("\n— execute_api: resetShareAccess (响应脱敏)");
    const shareRes = await execute("resetShareAccess", { shareId: "s-1" }, true, { sessionId: "test", caller: "e2e", mcpServer: null });
    assert(shareRes.ok === true, "resetShareAccess 成功");
    const token = (shareRes.data as { access_token?: string } | undefined)?.access_token;
    assert(token === "[REDACTED]", `响应中 access_token 已脱敏 (实际: ${token})`);

    // 8. AUDIT —— 每次调用都有记录，参数已脱敏。
    console.log("\n— audit log");
    const audit = recentAudit(50);
    assert(audit.length >= 5, "审计日志捕获了调用");
    assert(audit.every((a) => typeof a.params_redacted === "string"), "所有审计行的 params 均为 JSON 字符串");
    const ops = new Set(audit.map((a) => a.operation_id));
    assert(ops.has("deleteFile") && ops.has("listFiles"), "审计覆盖了多个 operation");

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
