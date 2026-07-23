/**
 * Application service container — a single place where the long-lived
 * collaborators (Registry, OperationSearch) are constructed and shared.
 *
 * The MCP server factory (server.ts) and the HTTP transport (transport.ts)
 * both pull from here so every session shares the same registry/search
 * state (the registry is the single source of truth, not per-session).
 */
import { createSearch } from "./search/factory.js";
import { Registry } from "./registry/registry.js";
import type { OperationSearch } from "./search/types.js";

let _search: OperationSearch | null = null;
let _registry: Registry | null = null;

export async function getSearch(): Promise<OperationSearch> {
  if (!_search) _search = await createSearch();
  return _search;
}

export async function getRegistry(): Promise<Registry> {
  if (!_registry) {
    _registry = new Registry(await getSearch());
  }
  return _registry;
}

/** Test/diagnostic: reset the container (does not touch the DB). */
export function resetServices(): void {
  _search = null;
  _registry = null;
}
