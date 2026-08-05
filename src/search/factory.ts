/**
 * Search factory: pick a backend by SEARCH_PROVIDER config.
 *
 *   bm25      → SQLite FTS5 (default, zero infra)
 *   embedding → @huggingface/transformers local ONNX embeddings + cosine
 *
 * Both implement the same OperationSearch interface, so the rest of the
 * system is agnostic to the backend. Hybrid (BM25 candidates → embedding
 * rerank) is a roadmap item behind this same seam.
 */
import { config } from "../config.js";
import type { OperationSearch } from "./types.js";
import { Bm25Search } from "./bm25-search.js";

export async function createSearch(): Promise<OperationSearch> {
  switch (config.searchProvider) {
    case "embedding": {
      // embedding 后端要加载 ONNX 模型，可能耗时十几秒——先打一行告诉用户在干嘛。
      // eslint-disable-next-line no-console
      console.log(`[search] 加载搜索后端 (embedding: ${config.embeddingModel})…`);
      return await createEmbeddingSearch();
    }
    case "bm25":
    default:
      // eslint-disable-next-line no-console
      console.log("[search] 加载搜索后端 (bm25)…");
      return new Bm25Search();
  }
}

/**
 * Lazy import of @huggingface/transformers (optional dependency).
 * Falls back to BM25 with a warning if the package isn't installed.
 */
async function createEmbeddingSearch(): Promise<OperationSearch> {
  try {
    const mod = await import("@huggingface/transformers");
    const { EmbeddingSearch } = await import("./embedding-search.js");
    return new EmbeddingSearch(mod, config.embeddingModel);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[search] SEARCH_PROVIDER=embedding but @huggingface/transformers is not installed; " +
        "falling back to BM25. Install with: npm i @huggingface/transformers",
    );
    return new Bm25Search();
  }
}
