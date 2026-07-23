/**
 * 注册中心探查 CLI —— 不启动 HTTP，直接对 SQLite 查询/检索/试执行。
 *
 * 用法：
 *   npx tsx scripts/inspect.ts services              # 列出已注册服务
 *   npx tsx scripts/inspect.ts ops [serviceId]       # 列出 operation（可按服务过滤）
 *   npx tsx scripts/inspect.ts search "<自然语言>"    # 语义检索
 *   npx tsx scripts/inspect.ts audit [N]             # 最近 N 条审计
 *
 * 需要：网关至少启动过一次（DB 里已有注册数据）。
 */
import { closeDb, db } from "../src/store/db.js";
import { listServices } from "../src/store/operation-store.js";
import { getSearch } from "../src/services.js";
import { recentAudit } from "../src/governance/audit.js";

const [, , cmd, ...rest] = process.argv;

async function main() {
  switch (cmd) {
    case "services": {
      const svcs = listServices();
      if (!svcs.length) { console.log("（无已注册服务）"); break; }
      for (const s of svcs) {
        const n = (db.prepare("SELECT COUNT(*) c FROM operations WHERE service_id=?").get(s.id) as { c: number }).c;
        console.log(`  ${s.id} — ${s.name}`);
        console.log(`      baseUrl: ${s.baseUrl}`);
        console.log(`      auth: ${s.authScheme}  |  spec: ${s.specVersion}  |  operations: ${n}`);
      }
      break;
    }
    case "ops": {
      const filter = rest[0];
      const rows = filter
        ? (db.prepare("SELECT id, method, path, summary, risk_level FROM operations WHERE service_id=? ORDER BY path").all(filter) as any[])
        : (db.prepare("SELECT id, service_id, method, path, summary, risk_level FROM operations ORDER BY service_id, path").all() as any[]);
      if (!rows.length) { console.log(filter ? `（服务 ${filter} 无 operation）` : "（无 operation）"); break; }
      for (const r of rows) {
        const svc = r.service_id ?? filter;
        console.log(`  [${r.risk_level.padEnd(9)}] ${r.method.padEnd(6)} ${svc}${r.path}  →  ${r.id}`);
        if (r.summary) console.log(`              ${r.summary}`);
      }
      console.log(`\n共 ${rows.length} 个`);
      break;
    }
    case "search": {
      const query = rest.join(" ");
      if (!query) { console.log("用法: inspect.ts search <自然语言查询>"); break; }
      const s = await getSearch();
      const hits = await s.search({ query, limit: 15 });
      if (!hits.length) { console.log("（无匹配）"); break; }
      for (const h of hits) {
        const op = (db.prepare("SELECT method, path, summary, risk_level FROM operations WHERE id=?").get(h.operationId) as any);
        console.log(`  ${(h.score ?? 0).toFixed(3)}  [${op?.risk_level ?? "?"}] ${op?.method ?? "?"} ${h.serviceId}${op?.path ?? ""}  →  ${h.operationId}`);
        if (op?.summary) console.log(`          ${op.summary}`);
      }
      break;
    }
    case "audit": {
      const n = Number(rest[0] ?? 20);
      for (const a of recentAudit(n)) {
        console.log(`  ${new Date(a.ts).toISOString()}  ${a.outcome.padEnd(12)} ${a.operation_id}  [${a.status_code ?? "-"}]  ${a.duration_ms}ms`);
      }
      break;
    }
    default:
      console.log("用法:");
      console.log("  npx tsx scripts/inspect.ts services");
      console.log("  npx tsx scripts/inspect.ts ops [serviceId]");
      console.log("  npx tsx scripts/inspect.ts search \"<自然语言>\"");
      console.log("  npx tsx scripts/inspect.ts audit [N]");
  }
  closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
