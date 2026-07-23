/**
 * Default search backend: SQLite FTS5 with porter+unicode61 tokenization.
 *
 * Zero new infrastructure — FTS5 ships with better-sqlite3. Provides a
 * BM25-ranked keyword index over the operation's text projection
 * (operationId, method, path, summary, description, tags).
 *
 * Post-FTS, results are filtered by service/method/tags and their raw
 * bm25 score is min-max normalized into [0,1].
 */
import { db } from "../store/db.js";
import type { OperationSearch } from "./types.js";
import type { SearchableOperation, SearchQuery, ScoredOperation } from "../types.js";

function searchText(op: SearchableOperation): string {
  return [op.operationId, op.method, op.path, op.summary ?? "", op.description ?? "", op.tags.join(" ")]
    .filter(Boolean)
    .join(" \n ");
}

export class Bm25Search implements OperationSearch {
  async index(ops: SearchableOperation[]): Promise<void> {
    // 增量更新：只替换传入 ops 涉及的服务的 FTS 行，不清空全表。
    // 这样刷新服务 A 的索引不会丢失服务 B 的索引行。
    const serviceIds = [...new Set(ops.map((o) => o.serviceId))];
    if (!serviceIds.length) return;

    const tx = db.transaction((rows: SearchableOperation[]) => {
      // 删除这些服务的旧 FTS 行（ops 为空的服务也会被清掉 → 用于 deregister）。
      const delStmt = db.prepare("DELETE FROM operations_fts WHERE service_id = ?");
      for (const sid of serviceIds) delStmt.run(sid);
      // 插入新行。
      const insStmt = db.prepare(
        "INSERT INTO operations_fts (operation_id, service_id, text) VALUES (?, ?, ?)",
      );
      for (const op of rows) insStmt.run(op.operationId, op.serviceId, searchText(op));
    });
    tx(ops);
  }

  async search(q: SearchQuery): Promise<ScoredOperation[]> {
    const ftsQuery = sanitizeFts(q.query);
    if (!ftsQuery) return [];

    // bm25(table) returns a *distance* (lower = better); we negate to get a score.
    const rows = db
      .prepare(
        `SELECT operation_id AS operationId, service_id AS serviceId,
                -bm25(operations_fts) AS score
         FROM operations_fts
         WHERE operations_fts MATCH ?
         ORDER BY score DESC
         LIMIT ?`,
      )
      .all(ftsQuery, Math.max(q.limit * 5, q.limit)) as {
        operationId: string;
        serviceId: string;
        score: number;
      }[];

    // Apply structural filters that FTS can't express directly.
    const methodSet = q.methodFilter ? new Set(q.methodFilter.map((m) => m.toUpperCase())) : null;
    const tagSet = q.tags?.length ? new Set(q.tags.map((t) => t.toLowerCase())) : null;

    // We need method/path/tags to filter — join against the operations table.
    const enriched = rows.length
      ? (db
          .prepare(
            `SELECT id, service_id, method, tags FROM operations WHERE id IN (${rows
              .map(() => "?")
              .join(",")})`,
          )
          .all(...rows.map((r) => r.operationId)) as {
          id: string;
          service_id: string;
          method: string;
          tags: string;
        }[])
      : [];
    const meta = new Map(enriched.map((e) => [e.id, e]));

    let filtered = rows.filter((r) => {
      const m = meta.get(r.operationId);
      if (!m) return false;
      if (q.serviceId && m.service_id !== q.serviceId) return false;
      if (methodSet && !methodSet.has(m.method.toUpperCase())) return false;
      if (tagSet) {
        const opTags = (JSON.parse(m.tags) as string[]).map((t) => t.toLowerCase());
        if (!opTags.some((t) => tagSet!.has(t))) return false;
      }
      return true;
    });

    // Calibrate raw bm25 scores (unbounded positive) into [0,1] via a saturating
    // transform: score = raw / (raw + K). This gives a meaningful non-zero score
    // even for a single result, unlike min-max normalization.
    const K = 2;
    filtered = filtered.map((r) => ({ ...r, score: r.score / (r.score + K) }));

    return filtered.slice(0, q.limit).map((r) => ({
      operationId: r.operationId,
      serviceId: r.serviceId,
      score: r.score,
    }));
  }
}

/**
 * Convert a natural-language query into an FTS5 MATCH expression with OR
 * semantics + prefix matching, so partial/vocabulary-mismatched queries still
 * match. FTS5 default is AND, which over-restricts agent queries.
 *
 *   "delete a file permanently" → "delete*" OR "a*" OR "file*" OR "permanently*"
 *
 * Stopwords are dropped to reduce noise.
 */
const STOPWORDS = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "how", "do", "i", "is", "are", "my", "me"]);

function sanitizeFts(q: string): string {
  const tokens = q
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  if (!tokens.length) return "";
  // Each token becomes a quoted prefix term; joined with OR.
  const terms = tokens.map((t) => `"${t}"*`);
  return terms.join(" OR ");
}
