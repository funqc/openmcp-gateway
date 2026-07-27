/**
 * 搜索命中的「充实（enrichment）」格式化逻辑。
 *
 * MCP 工具（search_api）与 REST 端点（GET /search）都需要把 ScoredOperation
 * 折叠成对调用方有用的元数据块。抽到这里共享，避免两处实现漂移。
 */
import type { HttpMethod, RiskLevel, ScoredOperation } from "../types.js";
import * as store from "../store/operation-store.js";

/**
 * 单条搜索结果的对外形状（与 search_api 的 structuredContent.results 对齐）。
 */
export interface SearchHit {
  operation_id: string;
  service_id: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  risk_level: RiskLevel;
  required_params: string[];
  body_required: boolean;
  example: string;
  score: number;
}

/**
 * 把底层命中的 operationId 列表折叠成充实后的搜索结果。
 *
 * 已从注册中心删除的 operation（search 索引尚未同步）会被静默过滤。
 * `score` 四舍五入到 3 位小数，便于展示。
 */
export function enrichSearchHits(scored: ScoredOperation[]): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const s of scored) {
    const op = store.getOperation(s.operationId);
    if (!op) continue;
    const req = [...((op.paramsSchema as { required?: string[] }).required ?? [])];
    if (op.bodyRequired) req.push("body");
    hits.push({
      operation_id: op.id,
      service_id: op.serviceId,
      method: op.method,
      path: op.path,
      summary: op.summary,
      description: op.description,
      tags: op.tags,
      risk_level: op.riskLevel,
      required_params: req,
      body_required: !!op.bodySchema,
      example: op.example,
      score: Math.round(s.score * 1000) / 1000,
    });
  }
  return hits;
}
