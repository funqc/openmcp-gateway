/**
 * REST 检索入口：GET /search
 *
 * CLI 通路的「发现」步骤——脚本/终端用自然语言在已注册接口目录中检索，
 * 拿到 operation_id 后再 POST /exec/<operation_id> 执行。
 *
 * 与 search_api（MCP 工具）共享底层 search backend 与 enrichSearchHits()
 * 充实逻辑，返回结构 { total, results: [...] } 与 search_api 的
 * structuredContent 完全对齐。
 *
 * 鉴权：复用 mcpAuth（与 /mcp、/exec 同一把 GATEWAY_API_KEY）。
 *
 * 查询参数：
 *   q          —— 自然语言查询（必填，非空）。
 *   service_id —— 可选，限定服务。
 *   limit      —— 可选，1–50，默认 10。
 *   method     —— 可选，逗号分隔的 HTTP 方法白名单，如 GET,POST。
 *   tags       —— 可选，逗号分隔的 tag 白名单。
 */
import type { Express, Request, RequestHandler, Response } from "express";
import { getSearch } from "./services.js";
import { enrichSearchHits } from "./search/format.js";
import type { HttpMethod } from "./types.js";

const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export function mountSearchRoute(app: Express, auth: RequestHandler): void {
  app.get("/search", auth, async (req: Request, res: Response) => {
    try {
      const query = String(req.query.q ?? "").trim();
      if (!query) {
        res.status(400).json({
          ok: false,
          message: "Query parameter 'q' is required (non-empty).",
        });
        return;
      }

      const serviceId = req.query.service_id ? String(req.query.service_id) : undefined;

      let limit = 10;
      if (req.query.limit !== undefined) {
        const parsed = Number(req.query.limit);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
          res.status(400).json({
            ok: false,
            message: "Query parameter 'limit' must be an integer in 1..50.",
          });
          return;
        }
        limit = parsed;
      }

      const methodFilter = parseCsv(req.query.method)
        .map((m) => m.toUpperCase())
        .filter((m) => METHODS.has(m)) as HttpMethod[];

      const tags = parseCsv(req.query.tags);

      const backend = await getSearch();
      const scored = await backend.search({
        query,
        serviceId,
        limit,
        methodFilter: methodFilter.length ? methodFilter : undefined,
        tags: tags.length ? tags : undefined,
      });

      const results = enrichSearchHits(scored);
      res.json({ total: results.length, results });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          message: `Internal error: ${(err as Error).message}`,
        });
      }
    }
  });
}

function parseCsv(v: unknown): string[] {
  if (typeof v !== "string") return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
