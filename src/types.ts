/**
 * Shared domain types used across registry / store / search / execute.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export type RiskLevel = "safe" | "elevated" | "dangerous";

/** A registered backend service (one per OpenAPI doc). */
export interface ServiceRecord {
  id: string;
  name: string;
  baseUrl: string;
  specVersion: string;
  specHash: string;
  authScheme: "bearer" | "basic" | "apikey" | "none";
  registeredAt: number;
}

/** A single OpenAPI operation, fully resolved ($ref-free). */
export interface OperationRecord {
  id: string; // operationId (globally unique)
  serviceId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  /** Resolved JSON Schema (draft-07) covering path + query + header params. */
  paramsSchema: object;
  /** Resolved JSON Schema for the request body, or null if the op has no body. */
  bodySchema: object | null;
  /** Whether the request body is required (OpenAPI requestBody.required). */
  bodyRequired: boolean;
  /** Human-readable 2xx response summary, for display to the agent. */
  responseHint?: string;
  riskLevel: RiskLevel;
  /** A ready-to-use curl/JSON example for the agent. */
  example: string;
}

/** The minimal subset the search backend needs to index. */
export interface SearchableOperation {
  operationId: string;
  serviceId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
}

export interface ScoredOperation {
  operationId: string;
  serviceId: string;
  /** Normalized relevance in [0,1]. */
  score: number;
}

export interface SearchQuery {
  query: string;
  serviceId?: string;
  limit: number;
  methodFilter?: HttpMethod[];
  tags?: string[];
}
