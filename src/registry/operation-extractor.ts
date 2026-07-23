/**
 * Walk a dereferenced OpenAPI document and emit one OperationRecord per
 * operation, with resolved parameter + requestBody JSON Schemas, a risk
 * classification, and a ready-to-use example snippet.
 */
import type { HttpMethod, OperationRecord, RiskLevel } from "../types.js";
import { classifyRisk } from "./risk-classifier.js";

const OPENAPI_VERBS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

type JsonSchema = Record<string, unknown>;
type OpenApiParameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  deprecated?: boolean;
  explode?: boolean;
  style?: string;
};
type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    description?: string;
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema; example?: unknown; examples?: Record<string, { value: unknown }> }>;
  };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: JsonSchema }> }>;
  deprecated?: boolean;
};

/** Build a draft-07 JSON Schema describing the accepted params object (path+query+header). */
function buildParamsSchema(parameters: OpenApiParameter[] | undefined): JsonSchema {
  const props: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const p of parameters ?? []) {
    if (p.in === "cookie") continue; // cookies not supported via params
    // Disambiguate name conflicts between locations by namespacing header params.
    const key = p.in === "header" ? `header:${p.name}` : p.name;
    const sch: JsonSchema = { ...(p.schema ?? { type: "string" }) };
    if (p.description) sch.description = p.description;
    props[key] = sch;
    if (p.required) required.push(key);
  }
  return { type: "object", properties: props, required, additionalProperties: true };
}

function deriveBody(requestBody: OpenApiOperation["requestBody"]): { schema: JsonSchema | null; required: boolean } {
  const content = requestBody?.content;
  if (!content) return { schema: null, required: false };
  // Prefer application/json, else the first media type's schema.
  const json = content["application/json"];
  const entry = json ?? Object.values(content)[0];
  return { schema: entry?.schema ?? null, required: requestBody?.required === true };
}

function summarizeResponse(operation: OpenApiOperation): string | undefined {
  const responses = operation.responses;
  if (!responses) return undefined;
  const ok = responses["200"] ?? responses["201"] ?? responses["2XX"] ?? responses["default"];
  if (!ok) return undefined;
  const json = ok.content?.["application/json"] ?? Object.values(ok.content ?? {})[0];
  const sch = json?.schema as JsonSchema | undefined;
  if (!sch) return ok.description ?? "No schema";
  if (sch.$ref) return `Returns: ${String(sch.$ref).replace(/^.*\//, "")}`;
  const t = sch.type ?? "object";
  if (t === "array" && typeof sch.items === "object") {
    const items = sch.items as JsonSchema;
    return `Returns: array of ${String(items.$ref ?? items.type ?? "object").toString().replace(/^.*\//, "")}`;
  }
  return `Returns: ${t}`;
}

function makeExample(
  serviceId: string,
  method: HttpMethod,
  path: string,
  operation: OpenApiOperation,
  paramsSchema: JsonSchema,
  bodySchema: JsonSchema | null,
): string {
  const props = (paramsSchema.properties ?? {}) as Record<string, JsonSchema>;
  const pathParams: Record<string, unknown> = {};
  const queryParams: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  for (const [key, sch] of Object.entries(props)) {
    const sample = sampleFor(sch);
    if (key.startsWith("header:")) headers[key.slice("header:".length)] = String(sample);
    else if (path.includes(`{${key}}`)) pathParams[key] = sample;
    else queryParams[key] = sample;
  }
  let resolvedPath = path;
  for (const [k, v] of Object.entries(pathParams)) resolvedPath = resolvedPath.replace(`{${k}}`, encodeURIComponent(String(v)));
  const qs = Object.keys(queryParams).length
    ? "?" + new URLSearchParams(Object.fromEntries(Object.entries(queryParams).map(([k, v]) => [k, String(v)]))).toString()
    : "";
  const bodySample = bodySchema ? sampleFor(bodySchema) : null;
  const lines: string[] = [`# ${method} ${serviceId}${resolvedPath}${qs}`];
  lines.push(`operation_id: ${operation.operationId ?? "(none)"}`);
  if (operation.summary) lines.push(`summary: ${operation.summary}`);
  lines.push("");
  lines.push("params:");
  const merged: Record<string, unknown> = { ...pathParams, ...queryParams, ...headers };
  if (bodySample) merged.body = bodySample;
  lines.push(JSON.stringify(merged, null, 2));
  return lines.join("\n");
}

function sampleFor(sch: JsonSchema | undefined): unknown {
  if (!sch) return "value";
  if (Array.isArray(sch.example)) return sch.example;
  if ("example" in sch) return sch.example;
  if ("default" in sch) return sch.default;
  if (sch.enum && Array.isArray(sch.enum)) return sch.enum[0];
  switch (sch.type) {
    case "string":
      return sch.format === "uuid" ? "00000000-0000-0000-0000-000000000000"
        : sch.format === "date-time" ? "2026-01-01T00:00:00Z"
        : sch.format === "date" ? "2026-01-01"
        : "string";
    case "integer":
    case "number":
      return typeof sch.minimum === "number" ? sch.minimum : 1;
    case "boolean":
      return false;
    case "array":
      return [sampleFor((sch.items as JsonSchema) ?? {})];
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (sch.properties ?? {}) as Record<string, JsonSchema>;
      for (const [k, v] of Object.entries(props)) out[k] = sampleFor(v);
      return out;
    }
    default:
      return null;
  }
}

export interface ExtractionResult {
  operations: OperationRecord[];
  infoTitle: string;
  servers: { url: string }[];
  openapiVersion: string;
}

export function extractOperations(
  serviceId: string,
  doc: Record<string, unknown>,
  riskOverrides?: Record<string, RiskLevel>,
): ExtractionResult {
  const root = doc as unknown as {
    openapi?: string;
    info?: { title?: string };
    servers?: { url: string }[];
    paths?: Record<string, Record<string, OpenApiOperation>>;
  };
  const paths = root.paths ?? {};
  const operations: OperationRecord[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const verb of OPENAPI_VERBS) {
      const operation = pathItem[verb] as OpenApiOperation | undefined;
      if (!operation) continue;
      // operationId is required for the registry; synthesize if missing.
      const operationId =
        operation.operationId ??
        `${serviceId}_${verb}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const method = verb.toUpperCase() as HttpMethod;
      const paramsSchema = buildParamsSchema(operation.parameters);
      const { schema: bodySchema, required: bodyRequired } = deriveBody(operation.requestBody);
      const responseHint = summarizeResponse(operation);
      const risk: RiskLevel = riskOverrides?.[operationId] ??
        classifyRisk(method, path, operation.summary, operation.description, operation.tags);
      const example = makeExample(
        serviceId,
        method,
        path,
        operation,
        paramsSchema,
        bodySchema,
      );
      operations.push({
        id: operationId,
        serviceId,
        method,
        path,
        summary: operation.summary,
        description: operation.description,
        tags: operation.tags ?? [],
        paramsSchema,
        bodySchema,
        bodyRequired,
        responseHint,
        riskLevel: risk,
        example,
      });
    }
  }

  return {
    operations,
    infoTitle: root.info?.title ?? serviceId,
    servers: root.servers ?? [],
    openapiVersion: root.openapi ?? "unknown",
  };
}
