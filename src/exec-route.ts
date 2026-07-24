/**
 * REST 执行入口：POST /exec/:operationId
 *
 * 这是 execute() 的「无 MCP 皮肤」对外暴露——让 Python/Shell 等任意脚本
 * 绕过 LLM 直接调用网关执行已注册的 operation，用于批量、可固化、
 * 零 token 的工作流场景。治理（鉴权/策略/审计/脱敏/风险确认）与
 * execute_api 完全一致，因为底层就是同一个 execute()。
 *
 * 入参：URL param `operationId`；JSON body `{ params?: object, confirm?: boolean }`。
 * 鉴权：复用 mcpAuth，与 /mcp 共享 GATEWAY_API_KEY。
 *
 * 状态码映射（语义状态码，脚本可凭 HTTP 状态码判断成败）：
 *   success → 200, confirmation_required → 412, validation_error → 400,
 *   denied → 403, not_found → 404, upstream_error → 502。
 * 响应体始终是完整 ExecuteOutput JSON（即便 4xx/5xx 也带 message/details）。
 */
import type { Express, Request, RequestHandler, Response } from "express";
import { execute } from "./execute/executor.js";
import type { ExecuteOutput } from "./schemas/execute.js";

/** 把 ExecuteOutput 的 status 映射为 HTTP 状态码。 */
function statusToHttp(s: ExecuteOutput["status"]): number {
  switch (s) {
    case "success":
      return 200;
    case "confirmation_required":
      return 412;
    case "validation_error":
      return 400;
    case "denied":
      return 403;
    case "not_found":
      return 404;
    case "upstream_error":
      return 502;
    default:
      return 502;
  }
}

/**
 * 把 REST 入口挂到 app 上。需在 createApp() 内调用。
 * auth 由调用方传入（避免与 transport.ts 形成循环 import）。
 */
export function mountExecRoute(app: Express, auth: RequestHandler): void {
  app.post("/exec/:operationId", auth, async (req: Request, res: Response) => {
    const operationId = String(req.params.operationId);
    try {
      // body 由全局 express.json() 解析；允许空 body（默认无参数）。
      const body = req.body ?? {};
      if (typeof body !== "object" || Array.isArray(body)) {
        res.status(400).json({
          ok: false,
          status: "validation_error",
          operation_id: operationId,
          message: "Request body must be a JSON object { params?, confirm? }.",
        });
        return;
      }

      const params = (body as { params?: unknown }).params;
      if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
        res.status(400).json({
          ok: false,
          status: "validation_error",
          operation_id: operationId,
          message: "Field 'params' must be a JSON object.",
        });
        return;
      }
      const confirm = (body as { confirm?: unknown }).confirm === true;

      const result = await execute(
        operationId,
        params as Record<string, unknown> | undefined,
        confirm,
        // REST 场景无会话、无 MCP server；caller 标记来源便于审计区分。
        { sessionId: null, caller: "http:exec", mcpServer: null },
      );

      res.status(statusToHttp(result.status)).json(result);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          status: "upstream_error",
          operation_id: operationId,
          message: `Internal error: ${(err as Error).message}`,
        });
      }
    }
  });
}
