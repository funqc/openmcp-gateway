/**
 * OpenAPI ingestion: load → validate → dereference → produce a normalized doc
 * that the operation-extractor can walk trivially (no $ref left).
 *
 * Uses @redocly/openapi-core v2:
 *   createConfig({})            → a default Redocly config
 *   bundleFromString({...})     → validate + bundle + dereference in one call
 *
 * The bundled result's `.bundle.parsed` is the dereferenced document.
 */
import { readFileSync } from "node:fs";
import {
  bundleFromString,
  createConfig,
  parseYaml,
  type BundleResult,
  type Document,
  type Config,
} from "@redocly/openapi-core";

export interface ParsedSpec {
  /** Dereferenced OpenAPI document (no $ref). */
  doc: Record<string, unknown>;
  openapiVersion: string;
  infoTitle: string;
  servers: { url: string }[];
}

let _config: Config | null = null;
async function getConfig(): Promise<Config> {
  if (!_config) _config = await createConfig({});
  return _config;
}

/** Load a raw OpenAPI document from a file path, URL, or inline object. */
export async function loadSpec(source: string | object): Promise<{ raw: string; absoluteRef: string }> {
  if (typeof source !== "string") {
    return { raw: JSON.stringify(source), absoluteRef: "inline.json" };
  }
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { headers: { accept: "application/json, application/yaml, */*" } });
    if (!res.ok) throw new Error(`Failed to fetch OpenAPI from ${source}: ${res.status}`);
    return { raw: await res.text(), absoluteRef: source };
  }
  return { raw: readFileSync(source, "utf8"), absoluteRef: source };
}

/**
 * Break recursive `$ref` cycles in an OpenAPI document so that a full
 * dereference (inlining every `$ref`) terminates instead of overflowing the
 * stack. This is necessary because dereference semantics require every `$ref`
 * to be replaced by its target — which is impossible to do finitely when the
 * reference graph has a cycle (e.g. `MediaInfo → MediaRequest → MediaInfo`).
 *
 * Approach: build the local `#/components/schemas/...` reference graph, find
 * back-edges via DFS, and rewrite each back-edge `$ref` into a safe placeholder
 * schema. The result is an acyclic graph that Redocly can fully inline, while
 * keeping the "no `$ref` left" contract the downstream extractor relies on.
 *
 * Non-local refs (URLs, etc.) are left untouched.
 */
const CYCLIC_REF_PLACEHOLDER: Record<string, unknown> = {
  description: "[cyclic reference omitted]",
  $comment: "openmcp-gateway: this $ref forms a reference cycle and was replaced to allow dereferencing.",
};

function breakCyclicRefs(doc: unknown): { doc: unknown; brokenCycles: number } {
  const root = doc as Record<string, unknown> | null;
  const components = root?.components as { schemas?: Record<string, unknown> } | undefined;
  const schemas = components?.schemas;
  if (!schemas || typeof schemas !== "object") return { doc, brokenCycles: 0 };

  // Collect every local schema $ref target used anywhere under a given node,
  // bounded by `maxDepth` to stay cheap (cycles are short; we only need the
  // immediate neighborhood to spot back-edges).
  const LOCAL_REF = /^#\/components\/schemas\/(.+)$/;
  function localRefsIn(node: unknown, maxDepth: number, depth = 0): Set<string> {
    const out = new Set<string>();
    if (depth > maxDepth) return out;
    if (Array.isArray(node)) {
      for (const it of node) for (const r of localRefsIn(it, maxDepth, depth + 1)) out.add(r);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "$ref" && typeof v === "string") {
          const m = LOCAL_REF.exec(v);
          if (m) out.add(m[1]);
        } else {
          for (const r of localRefsIn(v, maxDepth, depth + 1)) out.add(r);
        }
      }
    }
    return out;
  }

  // Tarjan's SCC over the schema reference graph: any schema that can reach
  // itself belongs to a strongly-connected component → all of its self-loops
  // and intra-SCC edges are back-edges that must be broken.
  const graph = new Map<string, Set<string>>();
  for (const name of Object.keys(schemas)) {
    graph.set(name, localRefsIn(schemas[name], 4));
  }
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idxMap = new Map<string, number>();
  const lowMap = new Map<string, number>();
  const sccMembers = new Set<string>();
  function strongconnect(v: string): void {
    idxMap.set(v, index);
    lowMap.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idxMap.has(w)) {
        strongconnect(w);
        lowMap.set(v, Math.min(lowMap.get(v)!, lowMap.get(w)!));
      } else if (onStack.has(w)) {
        lowMap.set(v, Math.min(lowMap.get(v)!, idxMap.get(w)!));
      }
    }
    if (lowMap.get(v) === idxMap.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      // A component is cyclic if it has >1 member, OR the single member
      // references itself.
      if (comp.length > 1 || (comp.length === 1 && (graph.get(comp[0]) ?? new Set()).has(comp[0]))) {
        for (const m of comp) sccMembers.add(m);
      }
    }
  }
  for (const name of Object.keys(schemas)) {
    if (!idxMap.has(name)) {
      try {
        strongconnect(name);
      } catch {
        // Guard against pathological input / recursion limits.
      }
    }
  }

  if (sccMembers.size === 0) return { doc, brokenCycles: 0 };

  // Rewrite: for each schema that is part of a cycle, replace any `$ref` that
  // points at another cycle member (or itself) with the placeholder.
  let broken = 0;
  function rewriteNode(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(rewriteNode);
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      // A bare {$ref: cycle target} → placeholder.
      if (Object.keys(obj).length === 1 && typeof obj.$ref === "string") {
        const m = LOCAL_REF.exec(obj.$ref);
        if (m && sccMembers.has(m[1])) {
          broken++;
          return { ...CYCLIC_REF_PLACEHOLDER };
        }
      }
      // $ref nested alongside siblings (or inside allOf/anyOf/oneOf): drop just
      // the offending $ref entry.
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "$ref" && typeof v === "string") {
          const m = LOCAL_REF.exec(v);
          if (m && sccMembers.has(m[1])) {
            broken++;
            continue; // omit this $ref
          }
        }
        out[k] = rewriteNode(v);
      }
      return out;
    }
    return node;
  }

  for (const name of sccMembers) {
    schemas[name] = rewriteNode(schemas[name]);
  }
  return { doc: root, brokenCycles: broken };
}

/**
 * Validate + bundle (dereference) an OpenAPI document string.
 * Throws on validation errors with a human-readable list.
 */
export async function parseAndValidate(raw: string, absoluteRef: string): Promise<ParsedSpec> {
  // Pre-parse to neutralize recursive $ref cycles before dereferencing —
  // otherwise Redocly's `dereference: true` overflows the stack on cyclic
  // schemas (e.g. Seerr's MediaInfo ⇄ MediaRequest).
  let sourceForBundle = raw;
  let brokenCycles = 0;
  try {
    const parsed = await parseYaml(raw);
    if (parsed && typeof parsed === "object") {
      const res = breakCyclicRefs(parsed);
      brokenCycles = res.brokenCycles;
      if (brokenCycles > 0) sourceForBundle = JSON.stringify(res.doc);
    }
  } catch {
    // If pre-parsing fails for any reason, fall back to the original string —
    // Redocly will report the real validation problem.
  }

  const config = await getConfig();
  const result: BundleResult = await bundleFromString({
    source: sourceForBundle,
    absoluteRef,
    config,
    dereference: true,
  });

  if (result.problems && result.problems.length) {
    const errors = result.problems.filter((p) => p.severity === "error");
    if (errors.length) {
      const msgs = errors.map((e) => `  - [${e.location ?? "?"}] ${e.message}`).join("\n");
      throw new Error(`OpenAPI validation failed:\n${msgs}`);
    }
  }

  const doc = (result.bundle as Document).parsed as Record<string, unknown>;
  const openapiVersion = String(doc.openapi ?? doc.swagger ?? "unknown");
  const info = (doc.info as { title?: string } | undefined) ?? {};
  const servers = ((doc.servers as { url: string }[] | undefined) ?? []).map((s) => ({ url: s.url }));

  return { doc, openapiVersion, infoTitle: info.title ?? "Untitled", servers };
}

/** Resolve the effective base URL: first server entry, or empty if none. */
export function resolveBaseUrl(servers: { url: string }[]): string {
  if (!servers.length) return "";
  let url = servers[0].url.replace(/\/$/, "");
  url = url.replace(/\{[^}]+\}/g, "localhost");
  return url;
}

// parseYaml is re-exported for callers that need to parse YAML independently.
export { parseYaml };
