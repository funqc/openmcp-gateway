# OpenMCP Gateway —— 架构设计

一个统一的 **OpenAPI Registry MCP Gateway**：将每个后端服务的 OpenAPI 文档注册到一个统一的 API Registry，仅对外暴露 **两个 MCP 工具**（`search_api`、`execute_api`），而非每个端点一个工具。

> 设计理念：**两个工具 + 可检索的注册中心** 优于 **N 个自动生成的工具**。工具越少 → 上下文窗口越小 → Agent 工具选择越准 → 维护负担越低。新增服务只需注册一份 spec，零代码。

---

## 1. 为什么不采用"一个端点一个工具"？

传统"OpenAPI → MCP 工具"方案会为每个 Operation 生成一个 MCP 工具。在规模较大时，这有明显问题：

| 问题 | 影响 |
|---------|--------|
| 工具爆炸 | 100 个端点 → 100 个工具，工具目录会占满 LLM 的上下文窗口。 |
| 选择准确率下降 | 工具名称相近时，Agent 容易选错。 |
| 强耦合 | spec 每次变更都会扰动工具表面，客户端必须重新同步。 |
| 缺乏治理切入点 | 没有自然的位置插入认证、脱敏、审计、风险控制。 |

本网关将工具表面收敛为 **两个稳定的工具**，并把"调用哪个端点？"的决策转化为 Agent 在调用时执行的 **语义检索**——这恰好是 Agent 推理能力最强的地方。

---

## 2. 系统总览

```
                    ┌─────────────────────────────────────────────┐
   MCP 客户端 ──HTTP(/mcp)──▶  OpenMCP Gateway（本仓库）
   (Agent / IDE)              │                                             │
                              │   ┌─────────────┐    ┌──────────────┐       │
                              │   │  search_api │    │  execute_api │       │
                              │   └──────┬──────┘    └──────┬───────┘       │
                              │          │                  │               │
                              │   ┌──────▼──────────────────▼───────┐      │
                              │   │         Registry / Search        │      │
                              │   │  (OpenAPI 摄取 + BM25/向量索引)   │      │
                              │   └──────┬──────────────────┬───────┘      │
                              │          │                  │               │
                              │   ┌──────▼─────┐   ┌────────▼────────┐    │
                              │   │  SQLite +  │   │  执行流水线       │    │
                              │   │   FTS5     │   │ (校验→调用)       │    │
                              │   └────────────┘   └────────┬────────┘    │
                              │                             │              │
                              └─────────────────────────────┼──────────────┘
                                                            │ HTTPS
                                   ┌────────────────────────┼─────────────┐
                                   ▼                        ▼              ▼
                            NAS 服务 A               NAS 服务 B       NAS 服务 C
                            (已注册 OpenAPI)         (已注册 OpenAPI) (已注册 OpenAPI)
```

**边界划分：**
- 网关独占凭据、校验、脱敏与审计，客户端永远看不到这些。
- 后端服务是 *被动* 的 OpenAPI 提供方，无需感知 MCP。
- 注册中心是唯一事实来源，检索与执行都从它读取。

---

## 3. 模块地图

```
src/
├── index.ts            入口：启动 → 发现注册 → 提供 /mcp 服务
├── config.ts           类型化的环境变量配置（端口、DB、检索后端、认证）
├── server.ts           McpServer 工厂 —— 注册两个工具
├── transport.ts        Streamable-HTTP 传输，/mcp 上的有状态会话
├── services.ts         Registry + OperationSearch 的共享容器
├── types.ts            领域类型（ServiceRecord、OperationRecord …）
│
├── registry/           OpenAPI 摄取流水线
│   ├── registry.ts       对外 API：register(source) → 校验 → 解引用 → 存储
│   ├── parser.ts         @redocly/openapi-core 校验 + bundle（解引用）
│   ├── operation-extractor.ts  遍历 paths → 解析后的 op 记录 + schema + 示例
│   └── risk-classifier.ts      基于 Method + 关键词的启发式风险分级
│
├── store/              持久化（better-sqlite3）
│   ├── db.ts            连接 + 迁移 + FTS5
│   └── operation-store.ts  services + operations 的 CRUD
│
├── search/             可插拔检索
│   ├── types.ts         OperationSearch 接口
│   ├── bm25-search.ts   默认：SQLite FTS5，OR + 前缀匹配
│   ├── embedding-search.ts  可选：@huggingface/transformers + 余弦相似
│   └── factory.ts       按 SEARCH_PROVIDER 选择后端
│
├── execute/            执行流水线
│   ├── executor.ts      编排 7 个步骤（见 §6）
│   ├── auth.ts          AuthResolver：按服务注入凭据
│   ├── validator.ts     ajv 编译解析后的 schema；校验 params + body
│   ├── request-builder.ts  为 undici 组装 path/query/header/body
│   └── masker.ts        （在 governance/ 下）响应字段脱敏
│
├── governance/         横切关注点
│   ├── policy.ts        服务启用/拒绝、脱敏规则、风险覆盖
│   ├── audit.ts         追加写入的 audit_log 表
│   ├── confirm.ts       危险操作的 MCP elicitation 封装
│   └── masker.ts        递归字段脱敏（黑名单 + 路径规则）
│
└── schemas/            Zod IO 契约
    ├── search.ts         search_api 输入/输出结构
    └── execute.ts        execute_api 输入/输出结构
```

---

## 4. 数据模型（SQLite）

```sql
services(
  id            TEXT PRIMARY KEY,        -- slug，如 "files"
  name          TEXT NOT NULL,
  base_url      TEXT NOT NULL,           -- 解析后的 server URL
  spec_version  TEXT,                    -- 3.0.3 / 3.1.0
  spec_hash     TEXT NOT NULL,           -- 源 spec 的 sha256（去重用）
  auth_scheme   TEXT NOT NULL,           -- bearer | basic | apikey | none
  registered_at INTEGER NOT NULL
)

operations(
  id            TEXT PRIMARY KEY,        -- operationId（全局唯一）
  service_id    TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  summary       TEXT,
  description   TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  params_schema TEXT NOT NULL,           -- 解析后的 JSON Schema（path+query+header）
  body_schema   TEXT,                    -- 解析后的 requestBody schema（或 null）
  body_required INTEGER NOT NULL DEFAULT 0,
  response_hint TEXT,
  risk_level    TEXT NOT NULL,           -- safe | elevated | dangerous
  example       TEXT NOT NULL            -- 给 Agent 用的即用型片段
)

operations_fts(                          -- 用于 BM25 检索的 FTS5 镜像
  operation_id UNINDEXED,
  service_id   UNINDEXED,
  text,                                   -- operationId+method+path+summary+desc+tags
  tokenize = 'porter unicode61'
)

audit_log(                               -- 追加写入，每次 execute_api 一行
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts, session_id, operation_id, caller,
  params_redacted TEXT,                   -- 脱敏后的参数
  status_code, duration_ms, outcome       -- success | client_error | upstream_error | denied
)
```

**为什么选 SQLite？** 索引查找、事务化注册、内置 FTS5 关键词检索，且能轻松嵌入单一部署产物。表结构足够小，未来迁移到 `node:sqlite`（Node 22+）或 Postgres 只是机械工作。

---

## 5. OpenAPI 摄取流水线

`registry.register({ serviceId, source })`，其中 `source` 是 **文件路径**、**URL** 或 **内联对象**：

```
load(source)
  → 原始字符串 + sha256 哈希
  → 去重：若该 serviceId 的哈希未变，直接返回（无操作）        ◀── 幂等刷新
  → @redocly bundleFromString({ dereference: true })           ◀── 校验 + 内联所有 $ref
  → extractOperations()：遍历 paths × verbs
       对每个 op：
         operationId  （缺失则合成）
         paramsSchema （解析后的 draft-07：path+query+header 参数）
         bodySchema   （解析后的 requestBody schema，或 null）
         bodyRequired （requestBody.required）
         riskLevel    （启发式 + 策略覆盖）
         example      （示例 params + body，可直接给 Agent 看）
  → 事务化 upsert（删除该服务旧 op，插入新 op）
  → search.index(operations)                                 ◀── 重建索引
```

**发现机制：** `discover()` 在启动时遍历 `services.yaml`（由 `SERVICES_CONFIG` 指向）里声明的所有服务并逐个注册；可安全地在定时器上运行。单个 spec 失败会被记录日志，但不会中断其他服务的注册。

---

## 6. 执行流水线（7 步）

`execute_api` 接收 `{ operation_id, params?, confirm? }`，执行：

```
1. 解析 RESOLVE       从存储中按 id 取 operation              → 404? → { status: not_found }
2. 策略闸 POLICY GATE decideOperation(service, op)           → 被拒? → 审计 'denied'，返回
3. 校验 VALIDATE      ajv 校验 params + body                  → 失败? → { status: validation_error }
                       （schema 按 operation_id 编译一次并缓存）
4. 风险闸 RISK GATE   若 risk ∈ {elevated, dangerous} 且 !confirm：
                       elicitInput(人类确认)                   → 拒绝? → 审计，返回
                       客户端不支持 elicitation?               → { status: confirmation_required }
                                                                （Agent 自行询问用户后用 confirm:true 重调）
5. 组装 BUILD         params → path / query / header / body
                       解析 base_url + 注入认证（服务端，永不返回）
6. 调用 INVOKE        undici.request（共享 Agent，连接池）
7. 脱敏 + 审计        按策略 mask(响应)
                       写审计行（参数脱敏后存储）
                       返回 { ok, status_code, data: <脱敏后> }
```

**核心不变量：** 凭据只存在于第 5 步。它们来自 `AUTH_<ID>_SCHEME` / `AUTH_<ID>_VALUE` 环境变量，注入到请求头，且永远不会出现在工具输出、审计日志或错误信息中。

### 风险分级

`risk-classifier.ts` 给出默认级别：

| 级别 | 触发条件 |
|-------|---------|
| `dangerous` | `DELETE`，或 summary/description/tags 命中关键词（`delete`、`purge`、`wipe`、`reset`、`revoke`、`shutdown`、`factory` …） |
| `elevated` | `POST` / `PUT` / `PATCH`（会修改状态但非明显破坏性） |
| `safe` | `GET` / `HEAD` 读操作 |

策略中的 `riskOverrides`（按 operationId）优先级高于启发式。

---

## 7. 检索 —— 可插拔后端

```ts
interface OperationSearch {
  index(ops: SearchableOperation[]): Promise<void>;
  search(q: SearchQuery): Promise<ScoredOperation[]>;   // score ∈ [0,1]
}
```

`factory.ts` 按 `SEARCH_PROVIDER` 选择：

| 后端 | 适用场景 | 实现方式 |
|---------|------|-----|
| **`bm25`**（默认） | 任何场景；零基础设施 | SQLite FTS5，`porter unicode61` 分词。查询被分词、去停用词，转为带前缀的 `OR` 词项，使词汇不匹配时仍能命中。原始 bm25 距离通过 `score = raw/(raw+K)` 校准到 `[0,1]`，避免单结果时分数被人为置零。 |
| **`embedding`** | 需要更好的语义召回，本地运行 | `@huggingface/transformers`（ONNX）对每个 op 的文本求嵌入向量；在内存 `Float32Array[]` 上做余弦相似。百级 op 完全够用，无需向量数据库。 |
| `vector-db` *（路线图）* | 1 万+ op | 在同一接口下接入 Qdrant。 |

结构化过滤（`service_id`、`method_filter`、`tags`）在排序之后应用，因为 FTS 无法直接表达这些条件。

**路线图：** 混合检索 —— BM25 候选 → 向量重排 —— 作为同一接口的第四种实现接入。

---

## 8. 两个工具的契约

### `search_api`

```jsonc
// 输入
{ "query": "delete a file permanently",
  "service_id"?: "files",
  "limit"?: 10,                // 1–50
  "method_filter"?: ["GET"],
  "tags"?: ["files"] }

// 输出（structuredContent）
{ "total": 3,
  "results": [{
    "operation_id": "deleteFile",
    "service_id": "files",
    "method": "DELETE", "path": "/files/{fileId}",
    "summary": "Delete a file permanently",
    "tags": ["files"],
    "risk_level": "dangerous",
    "required_params": ["fileId"],
    "body_required": false,
    "example": "# DELETE files/files/string\nparams:\n{ \"fileId\": \"string\" }",
    "score": 0.654
  }, …] }
```

Agent 在一次往返中就能拿到 **决策与执行所需的全部信息** —— 参数、风险、可直接复制的示例。常见场景无需二次查询。

### `execute_api`

```jsonc
// 输入
{ "operation_id": "deleteFile",
  "params": { "fileId": "f-2" },        // path/query/header/body 合并
  "confirm"?: true }                     // 人类确认后跳过 elicitation

// 输出 —— 以下之一：
{ "ok": true,  "status": "success",            "operation_id":…, "status_code":200, "data": <脱敏后> }
{ "ok": false, "status": "confirmation_required", "operation_id":…, "risk_level":"dangerous", "required_params":[…] }
{ "ok": false, "status": "validation_error",    "operation_id":…, "details": ["body: request body is required"] }
{ "ok": false, "status": "denied" | "upstream_error" | "not_found", … }
```

---

## 9. 治理

- **策略**（`data/policy.json`，可选）：按服务的 `enabled` / `allow` / `deny`，`redactFields`，`maskingRules`（点分路径 + `*.field` 通配），`riskOverrides`。
- **脱敏**（`governance/masker.ts`）：按字段名黑名单和路径规则递归脱敏，同时作用于 **工具响应** 和 **审计存储的参数**。
- **审计**（`audit_log`）：每次 Execute 追加写入、非阻塞。取证的事实来源。
- **风险确认**（`governance/confirm.ts`）：封装 MCP `elicitInput`（`form` 模式）。当客户端不支持该能力时，优雅降级为结构化的 `confirmation_required` 结果，由 Agent 自行询问用户后用 `confirm:true` 重调。

---

## 10. 传输

**Streamable HTTP**，单一 `/mcp` 路由（POST/GET/DELETE），有状态会话模型（每个 `mcp-session-id` 对应一个 `McpServer` + `StreamableHTTPServerTransport`）。

有状态是 **必需的**——风险确认的 elicitation 需要它（无状态变体无法完成 `elicitInput` 往返）。注册中心/检索的状态通过 `services.ts` 容器跨会话共享；每个会话只重新创建 MCP 工具处理器。

---

## 11. 如何验证

```bash
npm install
cp .env.example .env
npm run test:e2e          # 进程内：注册中心 → 检索 → 执行 → 脱敏 → 审计（自带内联上游，独立可跑）
cp data/services.example.yaml data/services.yaml   # 编辑成你的 NAS 服务
npm start                 # 网关（端口 3001）
# 然后参考 README.md 中的 curl 冒烟测试
```

e2e 测试套件断言：注册、BM25 排序（delete→deleteFile）、安全读执行、参数校验（含必填 body）、风险闸（无 `confirm` 时 `confirmation_required`，有时成功）、响应脱敏（`access_token` → `[REDACTED]`）、审计完整性。

---

## 12. 路线图

相关接口预留已就位，以下扩展无需重新设计：

- **混合检索** —— BM25 候选 → 向量重排（`OperationSearch` 的新实现）。
- **向量数据库** —— 面向 1 万+ op 目录的 Qdrant 后端。
- **LLM 重排** —— 把最终排序委托给模型。
- **跨服务工作流编排** —— 多步 Execute 计划。
- **多租户认证** —— 按调用方的策略 + 凭据保险库。
- **SDK v2 迁移** —— 待稳定后迁移到 `@modelcontextprotocol/server`（高层 API 不变，主要是 import 路径变更）。
- **策略热加载** —— `reloadPolicy()` 已实现；接入文件监听 / 管理端点即可。

---

## 13. 关键设计决策（理由）

| 决策 | 理由 |
|----------|-----|
| 两个工具，而非 N 个 | 最小化上下文、最大化选择准确率；"调用哪个端点"变成 LLM 擅长的检索问题。 |
| 以 `operation_id` 作为执行句柄 | 刷新后稳定（不像与路径绑定的工具名）；在注册中心内全局唯一。 |
| 摄取时即解引用 | 每个 op 都有完全解析的 schema → Ajv 校验简单快速；调用时无需解析 `$ref`。 |
| 服务端注入认证 | 客户端不接触凭据；网关是信任边界。 |
| 默认 BM25 | 零新基础设施，查询词汇与 spec 文本重叠时效果极佳；可插拔接口使升级无破坏性。 |
| 用 elicitation 做风险确认 | MCP 一等公民能力；不可用时降级方案干净。 |
| SQLite + FTS5 | 单文件、事务、关键词检索、易部署——MVP 规模下的正确选择。 |
