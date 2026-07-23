/**
 * 测试夹具：一份内联的 OpenAPI spec + 一个内联的 mock 上游 HTTP 服务。
 *
 * 让 e2e / bootstrap 脚本可以独立运行，不依赖任何外部后端，也不依赖
 * data/services.yaml。脚本启动时拉起这个上游、注册内联 spec，结束自动关闭。
 */

/** 内联的演示用 OpenAPI 3.0 spec（NAS 文件服务）。 */
export const DEMO_SPEC: object = {
  openapi: "3.0.3",
  info: { title: "Test NAS Files", version: "1.0.0" },
  servers: [], // baseUrl 由注册时显式传入
  tags: [{ name: "files" }, { name: "shares" }],
  paths: {
    "/files": {
      get: {
        operationId: "listFiles",
        summary: "List files in a directory",
        tags: ["files"],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
        ],
        responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/File" } } } } } } } },
      },
      post: {
        operationId: "createFile",
        summary: "Upload or create a file",
        tags: ["files"],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/FileCreate" } } } },
        responses: { 201: { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/File" } } } } },
      },
    },
    "/files/{fileId}": {
      get: {
        operationId: "getFile",
        summary: "Get file metadata",
        tags: ["files"],
        parameters: [{ name: "fileId", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/File" } } } } },
      },
      delete: {
        operationId: "deleteFile",
        summary: "Delete a file permanently",
        tags: ["files"],
        parameters: [{ name: "fileId", in: "path", required: true, schema: { type: "string" } }],
        responses: { 204: { description: "Deleted" } },
      },
    },
    "/shares/{shareId}/access": {
      put: {
        operationId: "resetShareAccess",
        summary: "Reset access tokens for a share",
        tags: ["shares"],
        parameters: [{ name: "shareId", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Share" } } } } },
      },
    },
  },
  components: {
    schemas: {
      File: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" }, size: { type: "integer" } } },
      FileCreate: { type: "object", required: ["path", "contents"], properties: { path: { type: "string" }, contents: { type: "string" } } },
      Share: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" }, access_token: { type: "string" } } },
    },
  },
};

/** 内存状态，供上游响应使用。 */
interface DemoFile { id: string; name: string; size: number }
const files = new Map<string, DemoFile>([
  ["f-1", { id: "f-1", name: "readme.md", size: 1234 }],
  ["f-2", { id: "f-2", name: "invoice.pdf", size: 98765 }],
]);

/**
 * 启动一个内联的 mock 上游 HTTP 服务，返回 { baseUrl, close }。
 * 用完务必调用 close()。监听随机端口，互不干扰。
 */
export async function startMockUpstream(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const p = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => {
        const json = JSON.stringify(obj);
        res.writeHead(code, { "content-type": "application/json" });
        res.end(json);
      };
      if (p === "/files" && method === "GET") return send(200, { items: [...files.values()] });
      if (p === "/files" && method === "POST") {
        const b = JSON.parse(body || "{}");
        const id = "f-" + (files.size + 1);
        const f = { id, name: (b.path ?? "").split("/").pop() ?? "untitled", size: Buffer.byteLength(b.contents ?? "") };
        files.set(id, f);
        return send(201, f);
      }
      const m = p.match(/^\/files\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (method === "GET") return files.has(id) ? send(200, files.get(id)) : send(404, { error: "not found" });
        if (method === "DELETE") { if (!files.has(id)) return send(404, { error: "not found" }); files.delete(id); res.writeHead(204); return res.end(); }
      }
      const sm = p.match(/^\/shares\/([^/]+)\/access$/);
      if (sm && method === "PUT") {
        const id = decodeURIComponent(sm[1]);
        return send(200, { id, name: id, access_token: "regenerated-secret-token" });
      }
      send(404, { error: `no route ${method} ${p}` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
