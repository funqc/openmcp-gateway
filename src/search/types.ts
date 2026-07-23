/**
 * 可插拔检索接口。新的后端（BM25、向量嵌入、向量数据库）实现此接口，
 * 由 factory.ts 根据配置选择。
 *
 * 接口故意只索引 operation 的*可检索*投影（不含 schema），保持索引轻量。
 */
import type { SearchableOperation, SearchQuery, ScoredOperation } from "../types.js";

export interface OperationSearch {
  /**
   * 增量更新索引：用传入的 ops **替换**它们所属服务的索引行。
   *
   * 语义：取传入 ops 涉及的所有 serviceId，先删除这些服务的旧索引行，
   * 再插入新的。**不影响**未涉及的服务的索引。因此：
   *   - 首次注册某服务 → 仅新增该服务
   *   - 刷新某服务 → 仅替换该服务，其他服务不动
   *   - 注销某服务 → 传入空数组（见 registry.deregister）
   */
  index(ops: SearchableOperation[]): Promise<void>;

  /** 执行排序检索，返回至多 q.limit 条结果（已过滤、打分）。 */
  search(q: SearchQuery): Promise<ScoredOperation[]>;
}

export type { SearchableOperation, SearchQuery, ScoredOperation };
