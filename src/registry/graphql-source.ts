/**
 * GraphQL ingestion: introspect a `/graphql` endpoint and emit one
 * OperationRecord per root Query/Mutation field.
 *
 * Design: GraphQL root fields are isomorphic to REST operations — each becomes
 * an OperationRecord where `method` is GET (Query) or POST (Mutation) purely
 * for risk-classification/display, `path` is always `/graphql`, and
 * `graphqlQuery` carries the auto-generated document the executor sends.
 *
 * Filtering: subscription root type and `__`-prefixed (introspection/meta)
 * fields/types are excluded by design — the gateway's request/response model
 * can't carry subscriptions, and meta fields aren't callable operations.
 *
 * Zero new dependencies: introspection uses the built-in `fetch`; documents are
 * generated as plain text (we never parse user-supplied GraphQL).
 */
import { createHash } from "node:crypto";
import type { HttpMethod, OperationRecord, RiskLevel } from "../types.js";
import type { ServiceAuthConfig } from "../config.js";
import { classifyRisk } from "./risk-classifier.js";

/**
 * Convert a ServiceAuthConfig (from env AUTH_<ID>_*) into the headers a
 * GraphQL introspection/execution request must carry. Mirrors the mapping in
 * execute/auth.ts so introspection and runtime calls authenticate identically.
 */
export function authHeadersForService(auth: ServiceAuthConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  switch (auth.scheme) {
    case "bearer":
      if (auth.value) headers["Authorization"] = `Bearer ${auth.value}`;
      break;
    case "basic":
      if (auth.value) headers["Authorization"] = `Basic ${Buffer.from(auth.value).toString("base64")}`;
      break;
    case "apikey":
      if (auth.value) headers[auth.headerName ?? "X-API-Key"] = auth.value;
      break;
    case "none":
    default:
      break;
  }
  return headers;
}

// ---- Minimal introspection type model ----

interface IntroArg {
  name: string;
  description?: string | null;
  type: IntroTypeRef;
  defaultValue?: string | null;
}
interface IntroField {
  name: string;
  description?: string | null;
  type: IntroTypeRef;
  args?: IntroArg[];
  isDeprecated?: boolean;
}
interface IntroType {
  kind: "OBJECT" | "INPUT_OBJECT" | "SCALAR" | "ENUM" | "INTERFACE" | "UNION" | "LIST" | "NON_NULL";
  name?: string;
  description?: string | null;
  fields?: IntroField[]; // OBJECT
  inputFields?: IntroArg[]; // INPUT_OBJECT
  enumValues?: { name: string; description?: string | null }[]; // ENUM
  interfaces?: { name?: string | null }[];
  possibleTypes?: { name?: string | null }[]; // INTERFACE/UNION
}
interface IntroTypeRef {
  kind: IntroType["kind"];
  name?: string; // set for named leaf types
  ofType?: IntroTypeRef | null; // set for NON_NULL / LIST wrappers
}
interface IntroSchema {
  queryType: { name: string };
  mutationType?: { name: string } | null;
  subscriptionType?: { name: string } | null;
  types: IntroType[];
}

/** The standard GraphQL introspection query (subset we need). */
const INTROSPECTION_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        args {
          name
          description
          type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
          defaultValue
        }
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
      inputFields {
        name
        description
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
        defaultValue
      }
      enumValues { name description }
      interfaces { name }
      possibleTypes { name }
    }
  }
}`;

/** Peel NON_NULL/LIST wrappers to reach the named type, if any. */
function unwrap(ref: IntroTypeRef | null | undefined): IntroTypeRef | null {
  let cur: IntroTypeRef | null | undefined = ref;
  while (cur && (cur.kind === "NON_NULL" || cur.kind === "LIST") && cur.ofType) cur = cur.ofType;
  return cur ?? null;
}

/** Whether the (possibly-wrapped) ref is non-null. */
function isNonNull(ref: IntroTypeRef | null | undefined): boolean {
  return !!ref && ref.kind === "NON_NULL";
}

// GraphQL scalar → JSON Schema type mapping (for the params schema we expose).
const SCALAR_MAP: Record<string, "string" | "number" | "integer" | "boolean"> = {
  String: "string",
  ID: "string",
  Int: "integer",
  Float: "number",
  Boolean: "boolean",
};

export interface GraphqlSourceResult {
  operations: OperationRecord[];
  infoTitle: string;
  hash: string;
}

export interface GraphqlSourceOptions {
  serviceId: string;
  /** The GraphQL endpoint URL (e.g. https://tower.local/graphql). */
  endpoint: string;
  /** Auth headers to attach to the introspection request (server-held creds). */
  authHeaders: Record<string, string>;
  /** Per-operationId risk overrides (same semantics as the OpenAPI path). */
  riskOverrides?: Record<string, "safe" | "elevated" | "dangerous">;
}

/**
 * Introspect a GraphQL endpoint and build OperationRecords for every root
 * Query/Mutation field. Throws a clear error if introspection is disabled or
 * the endpoint is unreachable.
 */
export async function ingestGraphql(opts: GraphqlSourceOptions): Promise<GraphqlSourceResult> {
  const schema = await introspect(opts.endpoint, opts.authHeaders);

  // Hash the canonicalized schema so unchanged schemas short-circuit re-registration.
  const hash = sha256(JSON.stringify(schema));
  const infoTitle = `GraphQL @ ${hostnameOf(opts.endpoint)}`;

  const typeByName = new Map<string, IntroType>();
  for (const t of schema.types) if (t.name) typeByName.set(t.name, t);

  const operations: OperationRecord[] = [];

  const queryRoot = schema.queryType?.name ? typeByName.get(schema.queryType.name) : undefined;
  const mutationRoot = schema.mutationType?.name ? typeByName.get(schema.mutationType.name) : undefined;
  // subscriptionType deliberately ignored (long-lived; incompatible with the
  // gateway's request/response execution model).

  for (const f of filterFields(queryRoot?.fields)) {
    operations.push(buildOperation(opts.serviceId, f, "GET", typeByName, opts.riskOverrides));
  }
  for (const f of filterFields(mutationRoot?.fields)) {
    operations.push(buildOperation(opts.serviceId, f, "POST", typeByName, opts.riskOverrides));
  }

  return { operations, infoTitle, hash };
}

/** Root fields we expose, skipping `__`-prefixed meta fields. */
function filterFields(fields?: IntroField[] | null): IntroField[] {
  return (fields ?? []).filter((f) => !f.name.startsWith("__"));
}

function buildOperation(
  serviceId: string,
  field: IntroField,
  method: HttpMethod,
  typeByName: Map<string, IntroType>,
  riskOverrides?: Record<string, RiskLevel>,
): OperationRecord {
  const operationId = `${serviceId}_${field.name}`;
  const args = field.args ?? [];
  const paramsSchema = buildParamsSchema(args, typeByName);
  const graphqlQuery = buildDocument(field, method === "POST" ? "mutation" : "query", typeByName);

  const description = field.description ?? undefined;
  const risk: RiskLevel =
    riskOverrides?.[operationId] ??
    classifyRisk(method, `/${field.name}`, field.name, description, []);

  return {
    id: operationId,
    serviceId,
    method,
    path: "/graphql",
    summary: field.name,
    description,
    tags: [method === "POST" ? "mutation" : "query"],
    paramsSchema,
    bodySchema: null,
    bodyRequired: false,
    responseHint: describeReturnType(field.type),
    riskLevel: risk,
    example: makeExample(serviceId, method, field, paramsSchema),
    graphqlQuery,
  };
}

// ---- params schema (args → JSON Schema draft-07) ----

function buildParamsSchema(args: IntroArg[], typeByName: Map<string, IntroType>): object {
  const props: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const arg of args) {
    props[arg.name] = refToJsonSchema(arg.type, typeByName);
    if (arg.description) props[arg.name].description = arg.description;
    if (isNonNull(arg.type) && arg.defaultValue == null) required.push(arg.name);
  }
  return { type: "object", properties: props, required, additionalProperties: true };
}

/**
 * Convert a GraphQL type reference to a JSON Schema fragment. Input object
 * types are inlined recursively (introspection already expanded them as
 * `inputFields`, so there are no `$ref` cycles to break here).
 */
function refToJsonSchema(ref: IntroTypeRef, typeByName: Map<string, IntroType>): Record<string, unknown> {
  // NON_NULL wrapper: descend and mark the inner schema required at the call
  // site (handled by callers via the required array); here we just unwrap.
  if (ref.kind === "NON_NULL" && ref.ofType) return refToJsonSchema(ref.ofType, typeByName);
  if (ref.kind === "LIST" && ref.ofType) {
    return { type: "array", items: refToJsonSchema(ref.ofType, typeByName) };
  }
  const named = ref.name;
  if (named && SCALAR_MAP[named]) return { type: SCALAR_MAP[named] };
  if (named) {
    const t = typeByName.get(named);
    if (t?.kind === "ENUM") {
      const vals = (t.enumValues ?? []).map((v) => v.name);
      return { type: "string", enum: vals.length ? vals : undefined };
    }
    if (t?.kind === "INPUT_OBJECT") {
      const props: Record<string, Record<string, unknown>> = {};
      const req: string[] = [];
      for (const f of t.inputFields ?? []) {
        props[f.name] = refToJsonSchema(f.type, typeByName);
        if (f.description) props[f.name].description = f.description;
        if (isNonNull(f.type) && f.defaultValue == null) req.push(f.name);
      }
      return { type: "object", properties: props, required: req, additionalProperties: true };
    }
    // Unknown named type (interface/union/object used as an input — rare).
    return { type: "object", additionalProperties: true };
  }
  return { type: "string" };
}

// ---- document generation ----

/**
 * Build an executable GraphQL document for a root field:
 *   - declares one `$var` per arg
 *   - passes them as field arguments
 *   - selects a bounded selection set (scalars + one level of object scalars)
 *     so responses stay small but structured.
 */
function buildDocument(field: IntroField, opKind: "query" | "mutation", typeByName: Map<string, IntroType>): string {
  const args = field.args ?? [];
  const varDecls = args.map((a) => `$${a.name}: ${typeRefToString(a.type)}`).join(", ");
  const argPass = args.map((a) => `${a.name}: $${a.name}`).join(", ");
  const selection = selectionSetFor(field.type, typeByName, 0);

  const header = `${opKind}${varDecls ? `(${varDecls})` : ""} {`;
  const call = argPass ? `  ${field.name}(${argPass})` : `  ${field.name}`;
  const body = selection ? `${call} {\n${selection}\n  }` : call;
  return `${header}\n${body}\n}`;
}

/** Render a GraphQL type ref back to its SDL string (e.g. `[String!]!`). */
function typeRefToString(ref: IntroTypeRef): string {
  if (ref.kind === "NON_NULL" && ref.ofType) return `${typeRefToString(ref.ofType)}!`;
  if (ref.kind === "LIST" && ref.ofType) return `[${typeRefToString(ref.ofType)}]`;
  return ref.name ?? "String";
}

const MAX_SELECTION_DEPTH = 2;

/**
 * Produce an indented selection set for the field's return type. Scalars/Enums
 * return "" (empty — caller treats as scalar leaf). Objects list their scalar
 * fields plus, at depth < MAX, one level into object subfields.
 */
function selectionSetFor(ref: IntroTypeRef, typeByName: Map<string, IntroType>, depth: number): string {
  const named = unwrap(ref);
  const name = named?.name;
  if (!name) return "";
  const t = typeByName.get(name);
  if (!t) return "";
  if (t.kind === "SCALAR" || t.kind === "ENUM") return ""; // leaf

  if (t.kind === "OBJECT" || t.kind === "INTERFACE") {
    const lines: string[] = [];
    const fields = (t.fields ?? []).filter((f) => !f.name.startsWith("__"));
    // Always include __typename so the agent can tell concrete types apart.
    lines.push("__typename");
    for (const f of fields) {
      const fNamed = unwrap(f.type);
      const isLeaf = !fNamed?.name || SCALAR_MAP[fNamed.name] || typeByName.get(fNamed.name)?.kind === "ENUM";
      if (isLeaf) {
        lines.push(f.name);
      } else if (depth + 1 < MAX_SELECTION_DEPTH) {
        const sub = selectionSetFor(f.type, typeByName, depth + 1);
        lines.push(sub ? `${f.name} {\n${indent(sub)}\n}` : f.name);
      }
      // Deeper than MAX_SELECTION_DEPTH: omit (keeps payloads bounded).
    }
    return dedupePreserveOrder(lines).join("\n");
  }

  if (t.kind === "UNION") {
    // Select __typename plus a fragment per possible concrete type.
    const lines = ["__typename"];
    for (const p of t.possibleTypes ?? []) {
      if (!p.name) continue;
      const pt = typeByName.get(p.name);
      if (!pt) continue;
      const sub = selectionSetFor({ kind: "OBJECT", name: p.name }, typeByName, depth + 1);
      lines.push(`... on ${p.name} ${sub ? "{\n" + indent(sub) + "\n}" : "{}"}`);
    }
    return lines.join("\n");
  }

  return "";
}

function describeReturnType(ref: IntroTypeRef): string {
  return `Returns: ${typeRefToString(ref)}`;
}

// ---- example text (mirrors the OpenAPI example format) ----

function makeExample(serviceId: string, method: HttpMethod, field: IntroField, paramsSchema: object): string {
  const props = (paramsSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const sample: Record<string, unknown> = {};
  for (const [k, sch] of Object.entries(props)) sample[k] = sampleFor(sch as Record<string, unknown>);
  const lines: string[] = [`# ${method} ${serviceId}/graphql`];
  lines.push(`operation_id: ${serviceId}_${field.name}`);
  lines.push(`summary: ${field.description ?? field.name}`);
  lines.push("");
  lines.push("params:");
  lines.push(JSON.stringify(sample, null, 2));
  return lines.join("\n");
}

function sampleFor(sch: Record<string, unknown> | undefined): unknown {
  if (!sch) return "value";
  switch (sch.type as string) {
    case "string":
      return "value";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return false;
    case "array":
      return [sampleFor(sch.items as Record<string, unknown>)];
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (sch.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [k, v] of Object.entries(props)) out[k] = sampleFor(v);
      return out;
    }
    default:
      return null;
  }
}

// ---- introspection transport ----

async function introspect(endpoint: string, authHeaders: Record<string, string>): Promise<IntroSchema> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...authHeaders },
      body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    });
  } catch (err) {
    throw new Error(`GraphQL introspection failed (cannot reach ${endpoint}): ${(err as Error).message}`);
  }
  if (!res.ok) {
    // Surface the upstream body so the cause is visible (e.g. Unraid returns
    // INTROSPECTION_DISABLED with a 400 — without the body the user only sees
    // a bare status code and has to guess).
    let detail = "";
    try {
      detail = (await res.text()).trim().slice(0, 300);
    } catch {
      /* ignore */
    }
    const hint =
      /INTROSPECTION_DISABLED/i.test(detail)
        ? " Introspection is disabled on this server. For Unraid, enable developer mode: run `unraid-api developer --sandbox true` on the server (or Settings → Management Access → Developer Options), then restart the gateway."
        : "";
    throw new Error(
      `GraphQL introspection failed: ${endpoint} returned HTTP ${res.status}.${detail ? ` Body: ${detail}` : ""}${hint}`,
    );
  }
  const payload = (await res.json()) as { data?: { __schema?: IntroSchema }; errors?: { message: string }[] };
  if (payload.errors?.length) {
    throw new Error(`GraphQL introspection returned errors: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  const schema = payload.data?.__schema;
  if (!schema) {
    throw new Error(
      `GraphQL introspection returned no __schema (is introspection disabled on ${endpoint}?)`,
    );
  }
  return schema;
}

// ---- small utils ----

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function indent(text: string, by = "  "): string {
  return text
    .split("\n")
    .map((l) => by + l)
    .join("\n");
}

function dedupePreserveOrder(xs: string[]): string[] {
  return [...new Set(xs)];
}
