/**
 * MCP server 工厂。创建一个 McpServer 并注册恰好两个工具：
 *
 *   search_api  —— 在已注册的 OpenAPI 目录中语义检索。
 *   execute_api —— 按 id 服务端驱动地执行一个 operation。
 *
 * 两个工具都返回 structuredContent（按 outputSchema 校验）和
 * 人类/LLM 可读的 text 块，以最大化客户端兼容性。
 *
 * 服务清单会在创建 server 时从 DB 读取，动态注入到工具描述中，
 * 这样 Agent 调 tools/list 就能知道网关里注册了哪些服务、能搜什么。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { searchInput, searchOutput } from "./schemas/search.js";
import { executeInput, executeOutput } from "./schemas/execute.js";
import { getRegistry } from "./services.js";
import * as store from "./store/operation-store.js";
import { execute } from "./execute/executor.js";
import type { HttpMethod } from "./types.js";

export interface ServerDeps {
  /** When null (e.g. CLI use), elicitation is unavailable. */
  sessionId: string | null;
  caller: string | null;
}

/**
 * 构建已注册服务的清单文本，注入到工具描述里，让 Agent 知道能搜什么。
 * 格式：每个服务一行，含 id、名称、operation 数量、baseUrl。
 */
function buildServiceCatalog(): string {
  const services = store.listServices();
  if (!services.length) return "（当前无已注册服务）";
  const lines = services.map((s) => {
    const opCount = store.countOperationsByService(s.id);
    return `  - ${s.id}：${s.name}（${opCount} 个接口）@ ${s.baseUrl}`;
  });
  return lines.join("\n");
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: "openmcp-gateway", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );

  const catalog = buildServiceCatalog();

  // ---- search_api ----
  server.registerTool(
    "search_api",
    {
      title: "搜索 API",
      description:
        "用自然语言在已注册的 OpenAPI 接口目录中检索，返回最匹配的接口（含参数、风险等级、可直接使用的调用示例）。\n" +
        "先用本工具发现该调哪个接口，再用 execute_api 执行。\n\n" +
        "当前已注册的服务：\n" +
        catalog +
        "\n\n用自然语言描述你的意图即可，例如「搜索漫画」「列出所有库」「获取阅读进度」。",
      inputSchema: searchInput,
      outputSchema: searchOutput,
    },
    async (input): Promise<CallToolResult> => {
      await getRegistry();
      const { getSearch } = await import("./services.js");
      const backend = await getSearch();

      const methodFilter = (input.method_filter ?? []) as HttpMethod[];
      const scored = await backend.search({
        query: input.query,
        serviceId: input.service_id,
        limit: input.limit,
        methodFilter: methodFilter.length ? methodFilter : undefined,
        tags: input.tags,
      });

      // 用完整的 operation 元数据充实每个命中结果，供 Agent 决策。
      const results = scored
        .map((s) => {
          const op = store.getOperation(s.operationId);
          if (!op) return null;
          const req = [...((op.paramsSchema as { required?: string[] }).required ?? [])];
          if (op.bodyRequired) req.push("body");
          return {
            operation_id: op.id,
            service_id: op.serviceId,
            method: op.method,
            path: op.path,
            summary: op.summary,
            description: op.description,
            tags: op.tags,
            risk_level: op.riskLevel,
            required_params: req,
            body_required: !!op.bodySchema,
            example: op.example,
            score: Math.round(s.score * 1000) / 1000,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      const structuredContent = { total: results.length, results };
      return {
        structuredContent,
        content: [
          {
            type: "text",
            text:
              `为「${input.query}」找到 ${results.length} 个接口。\n\n` +
              results
                .map(
                  (r) =>
                    `• ${r.operation_id}  [${r.method} ${r.path}]  风险:${r.risk_level}  匹配度:${r.score}\n` +
                    `  ${r.summary ?? ""}\n` +
                    `  必填参数: ${r.required_params.join(", ") || "（无）"}\n` +
                    `  示例:\n${indent(r.example, "    ")}`,
                )
                .join("\n\n") +
              (results.length === 0
                ? "无匹配。尝试换个说法，或用更宽泛的查询。"
                : ""),
          },
        ],
      };
    },
  );

  // ---- execute_api ----
  server.registerTool(
    "execute_api",
    {
      title: "执行 API",
      description:
        "按 operation_id 执行一个已注册的 API 接口。网关自动解析 URL、HTTP 方法、认证，校验参数，" +
        "发起调用，脱敏响应中的敏感字段，返回结果。\n" +
        "对于 elevated/dangerous（高风险）操作，需先与用户确认，再传 confirm:true（否则网关会发起交互确认）。\n\n" +
        "可执行的服务：\n" +
        catalog,
      inputSchema: executeInput,
      outputSchema: executeOutput,
    },
    async (input): Promise<CallToolResult> => {
      const result = await execute(
        input.operation_id,
        input.params as Record<string, unknown> | undefined,
        input.confirm,
        {
          sessionId: deps.sessionId,
          caller: deps.caller,
          mcpServer: server,
        },
      );
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  return server;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

// Re-export for convenience.
export { z };
