/**
 * Embedding-based search backend (optional).
 *
 * Uses @huggingface/transformers to compute local ONNX embeddings for every
 * operation's text projection, then ranks queries by cosine similarity.
 * At MVP scale (hundreds of operations) this is an in-memory Float32Array[]
 * with linear cosine — no vector DB needed.
 *
 * This module is only loaded when SEARCH_PROVIDER=embedding AND the optional
 * dependency is installed. It is intentionally a thin, swappable implementation.
 */
import type { OperationSearch } from "./types.js";
import type { SearchableOperation, SearchQuery, ScoredOperation } from "../types.js";

type TransformersModule = {
  pipeline: (task: string, model: string, opts?: unknown) => Promise<FeaturePipeline>;
};
type FeaturePipeline = {
  (text: string | string[], opts?: { pooling?: string; normalize?: boolean }): Promise<{
    data: Float32Array | number[];
    dims: number[];
  }>;
};

function searchText(op: SearchableOperation): string {
  return [op.operationId, op.method, op.path, op.summary ?? "", op.description ?? "", op.tags.join(" ")]
    .filter(Boolean)
    .join(" ");
}

export class EmbeddingSearch implements OperationSearch {
  private vectors: { operationId: string; serviceId: string; vec: Float32Array; meta: SearchableOperation }[] = [];
  private pipe: FeaturePipeline | null = null;
  private dim = 0;

  constructor(private readonly transformers: TransformersModule, private readonly model: string) {}

  private async getPipeline(): Promise<FeaturePipeline> {
    if (!this.pipe) {
      this.pipe = await this.transformers.pipeline("feature-extraction", this.model);
    }
    return this.pipe;
  }

  private async embed(text: string): Promise<Float32Array> {
    const pipe = await this.getPipeline();
    const out = await pipe(text, { pooling: "mean", normalize: true });
    const data = out.data as Float32Array;
    if (!this.dim) this.dim = out.dims.reduce((a, b) => a * b, 1);
    return Float32Array.from(data);
  }

  async index(ops: SearchableOperation[]): Promise<void> {
    // 增量更新：只替换传入 ops 涉及的服务的向量，不清空全部。
    const serviceIds = new Set(ops.map((o) => o.serviceId));
    this.vectors = this.vectors.filter((v) => !serviceIds.has(v.serviceId));
    for (const op of ops) {
      const vec = await this.embed(searchText(op));
      this.vectors.push({ operationId: op.operationId, serviceId: op.serviceId, vec, meta: op });
    }
  }

  async search(q: SearchQuery): Promise<ScoredOperation[]> {
    if (!this.vectors.length) return [];
    const qv = await this.embed(q.query);
    const methodSet = q.methodFilter ? new Set(q.methodFilter.map((m) => m.toUpperCase())) : null;
    const tagSet = q.tags?.length ? new Set(q.tags.map((t) => t.toLowerCase())) : null;

    const scored = this.vectors
      .filter((v) => {
        if (q.serviceId && v.serviceId !== q.serviceId) return false;
        if (methodSet && !methodSet.has(v.meta.method.toUpperCase())) return false;
        if (tagSet && !v.meta.tags.some((t) => tagSet!.has(t.toLowerCase()))) return false;
        return true;
      })
      .map((v) => ({ operationId: v.operationId, serviceId: v.serviceId, score: cosine(qv, v.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, q.limit);

    // Scores are cosine of normalized vectors → already in [0,1].
    return scored;
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  // Vectors are normalized; dot == cosine. Clamp for safety.
  return Math.max(0, Math.min(1, dot));
}
