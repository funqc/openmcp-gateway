/**
 * Zod shapes for the `search_api` tool — input and structured output.
 */
import { z } from "zod";

export const searchInput = {
  query: z
    .string()
    .min(1)
    .describe("Natural-language description of what the caller wants to do."),
  service_id: z
    .string()
    .optional()
    .describe("Restrict search to a single registered service id."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of results to return (1–50)."),
  method_filter: z
    .array(z.string())
    .optional()
    .describe("Optional allow-list of HTTP methods, e.g. ['GET','POST']."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Optional tag filters; a result matches if it has any of these tags."),
};

export const searchResultItem = z.object({
  operation_id: z.string(),
  service_id: z.string(),
  method: z.string(),
  path: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  risk_level: z.enum(["safe", "elevated", "dangerous"]),
  required_params: z.array(z.string()).default([]),
  body_required: z.boolean(),
  example: z.string(),
  score: z.number().min(0).max(1),
});

export const searchOutputSchema = z.object({
  total: z.number().int(),
  results: z.array(searchResultItem),
});

export const searchOutput = {
  total: z.number().int(),
  results: z.array(searchResultItem),
};

export type SearchResultItem = z.infer<typeof searchResultItem>;
export type SearchOutput = z.infer<typeof searchOutputSchema>;
