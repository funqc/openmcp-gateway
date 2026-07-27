/**
 * REST 目录入口（只读）：GET /services、GET /ops、GET /audit
 *
 * CLI 通路用这三个端点浏览网关里有什么、回看执行审计，方便脚本/终端。
 * 与 /search、/exec 同一套鉴权（mcpAuth / GATEWAY_API_KEY）。
 *
 *   GET /services                  → 服务清单（id、name、baseUrl、operation 数）
 *   GET /ops?service_id=<id>       → operation 清单（可按服务过滤）
 *   GET /audit?limit=<N>           → 最近 N 条执行审计（参数已脱敏）
 *
 * 数据源与 scripts/inspect.ts 一致：直接查 store + SQLite，不启动 MCP。
 */
import type { Express, Request, RequestHandler, Response } from "express";
import * as store from "./store/operation-store.js";
import { db } from "./store/db.js";
import { recentAudit } from "./governance/audit.js";
import type { HttpMethod, RiskLevel } from "./types.js";

interface OpListRow {
  id: string;
  service_id: string;
  method: string;
  path: string;
  summary: string | null;
  risk_level: string;
  tags: string;
}

export function mountCatalogRoute(app: Express, auth: RequestHandler): void {
  // GET /services —— 已注册服务清单，每个含 operation 数。
  app.get("/services", auth, (_req: Request, res: Response) => {
    try {
      const services = store.listServices();
      const out = services.map((s) => ({
        id: s.id,
        name: s.name,
        base_url: s.baseUrl,
        spec_version: s.specVersion,
        auth_scheme: s.authScheme,
        operations: store.countOperationsByService(s.id),
      }));
      res.json({ total: out.length, services: out });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, message: `Internal error: ${(err as Error).message}` });
      }
    }
  });

  // GET /ops?service_id=<id> —— operation 清单（可按服务过滤）。
  app.get("/ops", auth, (req: Request, res: Response) => {
    try {
      const serviceId = req.query.service_id ? String(req.query.service_id) : undefined;
      const rows = serviceId
        ? (db
            .prepare(
              "SELECT id, service_id, method, path, summary, risk_level, tags FROM operations WHERE service_id=? ORDER BY path",
            )
            .all(serviceId) as OpListRow[])
        : (db
            .prepare(
              "SELECT id, service_id, method, path, summary, risk_level, tags FROM operations ORDER BY service_id, path",
            )
            .all() as OpListRow[]);

      const out = rows.map((r) => ({
        operation_id: r.id,
        service_id: r.service_id,
        method: r.method as HttpMethod,
        path: r.path,
        summary: r.summary ?? undefined,
        risk_level: r.risk_level as RiskLevel,
        tags: safeParseTags(r.tags),
      }));
      res.json({ total: out.length, operations: out });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, message: `Internal error: ${(err as Error).message}` });
      }
    }
  });

  // GET /audit?limit=<N> —— 最近 N 条执行审计（参数已脱敏）。默认 20，上限 200。
  app.get("/audit", auth, (req: Request, res: Response) => {
    try {
      let limit = 20;
      if (req.query.limit !== undefined) {
        const parsed = Number(req.query.limit);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
          res
            .status(400)
            .json({ ok: false, message: "Query parameter 'limit' must be an integer in 1..200." });
          return;
        }
        limit = parsed;
      }
      const rows = recentAudit(limit);
      const out = rows.map((r) => ({
        ts: r.ts,
        iso: new Date(r.ts).toISOString(),
        session_id: r.session_id,
        operation_id: r.operation_id,
        caller: r.caller,
        status_code: r.status_code,
        duration_ms: r.duration_ms,
        outcome: r.outcome,
      }));
      res.json({ total: out.length, audit: out });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, message: `Internal error: ${(err as Error).message}` });
      }
    }
  });
}

function safeParseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
