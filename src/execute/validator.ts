/**
 * Runtime parameter validation against resolved JSON Schemas.
 *
 * Schemas are compiled by Ajv once per operationId and cached. The input
 * `params` object from execute_api is validated against the params schema;
 * if the operation has a body schema, `params.body` is validated separately.
 */
import { Ajv, type ValidateFunction } from "ajv";
import * as ajvFormats from "ajv-formats";
import type { OperationRecord } from "../types.js";

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true });
const addFormats = (ajvFormats as unknown as { default: (a: unknown) => unknown }).default;
addFormats(ajv);

interface Compiled {
  params: ValidateFunction;
  body: ValidateFunction | null;
}

const cache = new Map<string, Compiled>();

function getCompiled(op: OperationRecord): Compiled {
  let c = cache.get(op.id);
  if (!c) {
    c = {
      params: ajv.compile(op.paramsSchema as object),
      body: op.bodySchema ? ajv.compile(op.bodySchema) : null,
    };
    cache.set(op.id, c);
  }
  return c;
}

export interface ValidationResult {
  ok: boolean;
  /** Human-readable error list (empty when ok). */
  errors: string[];
  /** The params object after coercion (numbers parsed from strings, etc.). */
  coercedParams: Record<string, unknown>;
  /** The validated body, or undefined. */
  body: unknown;
}

export function validateParams(
  op: OperationRecord,
  params: Record<string, unknown> | undefined,
): ValidationResult {
  const input: Record<string, unknown> = { ...(params ?? {}) };
  const body = input.body;
  // Body is validated separately, so remove it from the params validation.
  if ("body" in input) delete input.body;

  const compiled = getCompiled(op);
  const errors: string[] = [];

  const paramsOk = compiled.params(input);
  if (!paramsOk) {
    errors.push(...(compiled.params.errors ?? []).map(formatAjvError));
  }

  if (compiled.body) {
    if (op.bodyRequired && body === undefined) {
      // The operation declares a required request body but none was supplied.
      errors.push("body: request body is required for this operation");
    } else if (body !== undefined) {
      const bodyOk = compiled.body(body);
      if (!bodyOk) {
        errors.push(...(compiled.body.errors ?? []).map((e) => `body: ${formatAjvError(e)}`));
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    coercedParams: input,
    body,
  };
}

function formatAjvError(e: { instancePath?: string; message?: string; params?: unknown }): string {
  const path = e.instancePath || "(root)";
  return `${path}: ${e.message ?? "invalid"}${e.params ? ` ${JSON.stringify(e.params)}` : ""}`;
}

/** Test/diagnostic hook: clear the compiled-schema cache. */
export function clearValidatorCache(): void {
  cache.clear();
}
