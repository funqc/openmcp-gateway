/**
 * Risk-confirmation helper.
 *
 * For elevated/dangerous operations, the executor calls requestConfirmation()
 * which uses MCP elicitation to ask the human in-band. If the client does not
 * advertise the elicitation capability, we surface a typed
 * `confirmation_required` result so the *agent* can ask the user and re-call
 * execute_api with confirm:true.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OperationRecord } from "../types.js";

export type ConfirmOutcome = "confirmed" | "declined" | "not_supported";

export interface ConfirmContext {
  mcpServer: McpServer | null;
  operation: OperationRecord;
}

export async function requestConfirmation(ctx: ConfirmContext): Promise<ConfirmOutcome> {
  const { mcpServer, operation } = ctx;

  // No server handle (e.g. called from a non-MCP context) → ask caller to confirm out-of-band.
  if (!mcpServer) return "not_supported";

  const summary =
    operation.summary ?? `${operation.method} ${operation.path}`;
  const message =
    `Confirm execution of a ${operation.riskLevel.toUpperCase()} operation.\n\n` +
    `Operation: ${operation.id}\n` +
    `${operation.method} ${operation.path}\n` +
    `Summary: ${summary}\n\n` +
    `Proceed?`;

  try {
    const result = await (mcpServer as unknown as {
      server: {
        elicitInput: (req: unknown) => Promise<{
          action: "accept" | "decline" | "cancel";
          content?: Record<string, unknown>;
        }>;
      };
    }).server.elicitInput({
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", title: "Confirm", default: false },
        },
        required: ["confirm"],
      },
    });

    if (result.action === "accept" && result.content?.confirm === true) return "confirmed";
    return "declined";
  } catch (err) {
    // Capability not supported by the client, or elicitation disabled.
    return "not_supported";
  }
}
