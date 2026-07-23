/**
 * Zod shapes for the `execute_api` tool — input and structured output.
 */
import { z } from "zod";

export const executeInput = {
  operation_id: z
    .string()
    .min(1)
    .describe("The operationId returned by search_api."),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Business parameters for the call (path, query, header, and body values merged). " +
        "Path params use their declared name, e.g. { fileId: 'abc' } for /files/{fileId}.",
    ),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Set to true to skip the interactive confirmation step for elevated/dangerous operations, " +
        "after the human has approved.",
    ),
};

export const executeOutputSchema = z.object({
  ok: z.boolean(),
  status: z.enum([
    "success",
    "confirmation_required",
    "validation_error",
    "upstream_error",
    "denied",
    "not_found",
  ]),
  operation_id: z.string(),
  status_code: z.number().int().optional(),
  risk_level: z.enum(["safe", "elevated", "dangerous"]).optional(),
  summary: z.string().optional(),
  required_params: z.array(z.string()).optional(),
  message: z.string().optional(),
  details: z.array(z.string()).optional(),
  data: z.unknown().optional(),
});

export const executeOutput = {
  ok: z.boolean(),
  status: z.enum([
    "success",
    "confirmation_required",
    "validation_error",
    "upstream_error",
    "denied",
    "not_found",
  ]),
  operation_id: z.string(),
  status_code: z.number().int().optional(),
  risk_level: z.enum(["safe", "elevated", "dangerous"]).optional(),
  summary: z.string().optional(),
  required_params: z.array(z.string()).optional(),
  message: z.string().optional(),
  details: z.array(z.string()).optional(),
  data: z.unknown().optional(),
};

export type ExecuteOutput = z.infer<typeof executeOutputSchema>;
