/**
 * Streamable-HTTP transport, wired on a single /mcp route (POST/GET/DELETE).
 *
 * Stateful session model: one McpServer + StreamableHTTPServerTransport per
 * session, keyed by mcp-session-id. This is required for elicitation (the
 * risk-confirmation flow) — the stateless variant does not support it.
 *
 * The registry/search state is shared across sessions via the services
 * container; only the per-session MCP tool handlers are recreated.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server.js";
import { config } from "./config.js";

interface SessionState {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

/**
 * /mcp 端点的静态 API Key 鉴权。
 * 客户端可通过 Authorization: Bearer <key> 或 X-API-Key: <key> 提供。
 * 未配置 GATEWAY_API_KEY 时不鉴权（仅适合本机部署）。
 */
function mcpAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.gatewayApiKey) {
    next();
    return;
  }
  const presented = extractKey(req);
  if (!presented || !safeEqual(presented, config.gatewayApiKey)) {
    res
      .status(401)
      .header("www-authenticate", 'Bearer realm="openmcp-gateway"')
      .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: invalid or missing API key." }, id: null });
    return;
  }
  next();
}

function extractKey(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string") return xKey.trim();
  return null;
}

/** 恒定时间比较，防止时序攻击。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  const sessions = new Map<string, SessionState>();

  function newSession(): SessionState {
    const server = createMcpServer({ sessionId: null, caller: null });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { server, transport });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };
    // Connect eagerly so the server is ready before the first request is handled.
    // The transport.handleRequest call below actually drives the exchange.
    return { server, transport };
  }

  // POST: main JSON-RPC endpoint.
  app.post("/mcp", mcpAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && isInitializeRequest(req.body)) {
        const { server, transport } = newSession();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      res
        .status(400)
        .json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session and not an initialize request." }, id: null });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error", data: (err as Error).message }, id: null });
      }
    }
  });

  // GET: SSE stream for server→client notifications (required by the spec for
  // the full streamable-HTTP feature set, including elicitation round-trips).
  app.get("/mcp", mcpAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session." }, id: null });
      return;
    }
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // DELETE: terminate a session.
  app.delete("/mcp", mcpAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session." }, id: null });
      return;
    }
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // Health check.
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Graceful shutdown hook.
  app.locals.closeAll = async () => {
    for (const [, s] of sessions) {
      try {
        await s.transport.close();
      } catch {
        /* ignore */
      }
    }
    sessions.clear();
  };

  return app;
}

export async function closeApp(app: express.Express): Promise<void> {
  const closer = app.locals.closeAll as (() => Promise<void>) | undefined;
  if (closer) await closer();
}
