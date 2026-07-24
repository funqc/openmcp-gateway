# OpenMCP Gateway

一个统一的 **OpenAPI Registry MCP Gateway**。与传统"每个 API 端点一对一暴露为 MCP Tool"的方案不同（这会淹没 Agent 的上下文、降低工具选择准确率），本网关将所有后端服务的 OpenAPI 文档注册到一个统一的 **API Registry**，仅对外暴露 **两个工具**：

| 工具 | 用途 |
|------|------|
| `search_api` | 在所有已注册的 OpenAPI Operation 中进行语义检索，返回最匹配的结果（含参数、风险等级、可直接使用的调用示例）。 |
| `execute_api` | 仅凭 `operation_id` 和业务参数调用某个 Operation。网关自动完成 URL、Method、认证、参数校验、请求组装、实际调用、响应脱敏与审计。 |

> **核心理念：两个工具 + 可检索的注册中心 > N 个工具。** 上下文开销更低、Agent 工具选择更准、新增服务**零代码**接入。

## 功能特性

- **只有两个工具，而非 N 个** —— Agent 先搜索、再执行，避免每个端点都生成一个 Tool 的爆炸问题。
- **OpenAPI 自动发现与注册** —— 启动时放入一份 spec（文件 / URL / 内联对象），网关自动校验、解引用（dereference）、建索引；基于 `sha256` 去重，无变更时跳过刷新。
- **可插拔的语义检索** —— 默认 **基于 SQLite FTS5 的 BM25**（零外部依赖）；通过统一接口可切换到 **本地向量嵌入**（`@huggingface/transformers`）或未来的向量数据库。
- **服务端驱动的执行** —— URL / Method / 认证 / 参数 / Body 全部在服务端组装，Agent 永远不接触凭据。
- **危险操作风险控制** —— elevated / dangerous 级别的操作需通过 MCP **elicitation** 确认（不支持该能力的客户端会收到结构化的 `confirmation_required` 结果）。
- **响应脱敏** —— 敏感字段（`password`、`token`、`access_token` 等）在工具输出与审计日志中均被脱敏。
- **调用审计** —— 每次 `execute_api` 调用都追加写入审计日志（参数已脱敏）。
- **统一治理** —— 通过策略文件实现按服务的启用/禁用、允许/拒绝清单、脱敏规则、按 Operation 的风险等级覆盖。
- **脚本化直调入口（REST `/exec`）** —— 除 MCP 外，同时暴露 `POST /exec/<operation_id>`，供 Python/Shell 等脚本绕过 LLM 直接调用，适合批量、可固化、零 token 的工作流；治理与 `execute_api` 完全一致。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置（默认值即可运行测试）
cp .env.example .env

# 3. 运行端到端测试（自带内联上游，无需任何外部服务）
npm run test:e2e
```

### 接入你的 NAS 服务

所有后端服务在一个 YAML 文件里集中声明。复制示例、改成你的服务：

```bash
cp data/services.example.yaml data/services.yaml
```

编辑 `data/services.yaml`，填入你的 NAS 服务：

```yaml
services:
  - id: files
    source: http://nas-1.local:5000/openapi.json   # OpenAPI 文档 URL
    # baseUrl: http://nas-1.local:5000             # 可选：覆盖 spec 里的 server
    # enabled: false                                # 可选：临时禁用

  - id: photos
    source: https://nas-2.local:8443/api/openapi.json

  - id: downloads
    source: ./data/services/downloads-openapi.json  # 也支持本地文件
    baseUrl: http://nas-3.local:8080
```

> 凭据【不要】写进 yaml——用 `.env` 的 `AUTH_<ID>_SCHEME` / `AUTH_<ID>_VALUE`（见下）。

### 运行网关

```bash
npm start
# → MCP endpoint: http://127.0.0.1:3001/mcp
# 启动时自动拉取 services.yaml 里所有服务的 OpenAPI、校验、解引用、建索引
```

### 服务连通性自检

新增 / 改完服务后,不用启动网关也能一键探测所有上游是否可达、认证是否有效：

```bash
npm run ping              # 测 services.yaml 里所有 enabled 的服务
npm run ping -- emby      # 只测指定服务（可带多个 id）
```

每个服务测两项：

| 探测项 | 含义 |
|--------|------|
| **spec** | 拉取 `source`（OpenAPI 文档 / GraphQL introspection）——就是网关 `discover()` 干的事 |
| **business** | 带认证请求一个轻量 GET（如 `/System/Info/Public`、`/health`）;401/403 会标 ❌ |

凭据完全复用网关运行时（读 `services.yaml` + `.env` 的 `AUTH_<ID>_*`）,不重复硬编码。退出码反映成败（全过 `0`、否则 `1`）,便于接入 CI。示例输出：

```
▌ emby  [openapi]
  source:  https://emby.<YOUR_DOMAIN>:18443/openapi
  baseUrl: https://emby.<YOUR_DOMAIN>:18443
  auth:    X-Emby-Token
  ✅ spec      200  1912ms  { "openapi": "3.0.1", ... }
  ✅ business  200  20ms    {"ServerName":"Remote","Version":"4.9.5.0",...}
           ↳ https://emby.<YOUR_DOMAIN>:18443/System/Info/Public
```

> 💡 business 探测的健康端点按 hostname 兜底（emby/jellyfin → `/System/Info/Public`、seerr → `/status`、其它 → `/health`）。端点选错导致的 404 不代表服务不可用——只要 spec 探测通过,网关注册就不会受影响。

用 curl 冒烟测试 MCP 协议（Streamable HTTP）：

```bash
# initialize → 拿到 session id
curl -s -D /tmp/h -X POST http://127.0.0.1:3001/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"cli","version":"1"}}}'
SID=$(grep -i 'mcp-session-id' /tmp/h | tr -d '\r' | awk '{print $2}')

# 搜索
curl -s -X POST http://127.0.0.1:3001/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_api","arguments":{"query":"delete a file"}}}'

# 执行
curl -s -X POST http://127.0.0.1:3001/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"execute_api","arguments":{"operation_id":"listFiles","params":{"limit":5}}}}'
```

## 脚本化调用（REST `/exec`）

对于**批量、可固化、零 token**的工作流，不必让 Agent 一轮轮经 LLM 调 `execute_api`——网关同时暴露一个 REST 入口，让任意脚本直接打到同一个 `execute()`：

```
POST /exec/<operation_id>
Header: X-API-Key: <GATEWAY_API_KEY>   （与 /mcp 共用，见「访问鉴权」）
Body:   { "params": { ... }, "confirm": true|false }
```

底层就是 `execute_api` 用的那个 `execute()`，所以鉴权、策略、参数校验、响应脱敏、审计、风险确认**完全一致**——审计里 `caller` 标为 `http:exec` 便于区分。REST 是无状态的（无需 MCP 会话），更适合脚本批处理。

### 何时用 `/exec` 而非 MCP

- **批量/重复任务**（对成百上千条数据执行同一组操作）。
- **想把 workflow 固化成代码**（版本控制、测试、复用）。
- **跨语言/跨机器**（Python、Shell、任何能发 HTTP 的程序）。

### 示例

```bash
# Shell：单条调用
curl -X POST http://127.0.0.1:3001/exec/listFiles \
     -H "X-API-Key: $GATEWAY_API_KEY" \
     -d '{"params":{"limit":10}}'

# 危险操作必须显式授权，否则返回 412 不执行
curl -X POST http://127.0.0.1:3001/exec/deleteFile \
     -H "X-API-Key: $GATEWAY_API_KEY" \
     -d '{"params":{"fileId":"f-1"}}'                    # → 412 Precondition Failed
curl -X POST http://127.0.0.1:3001/exec/deleteFile \
     -H "X-API-Key: $GATEWAY_API_KEY" \
     -d '{"params":{"fileId":"f-1"},"confirm":true}'     # → 200 OK
```

```python
# Python：批量 workflow（成百上千条，零 LLM token）
import requests

GW, KEY = "http://nas:3001", "xxx"
hdr = {"X-API-Key": KEY}

for item in items:
    r1 = requests.post(f"{GW}/exec/opA", json={"params": {"id": item}}, headers=hdr)
    if r1.status_code != 200:
        continue
    a_id = r1.json()["data"]["id"]
    requests.post(f"{GW}/exec/opB", json={"params": {"parent": a_id}}, headers=hdr)
```

### 响应与状态码

响应体始终是完整 `ExecuteOutput` JSON（即便 4xx/5xx 也带 `message`/`details`），脚本可凭 HTTP 状态码判断成败：

| `status` 字段 | HTTP | 含义 |
|---|---|---|
| `success` | 200 | 成功 |
| `confirmation_required` | 412 | 危险操作未 `confirm`，需带 `"confirm":true` 重试 |
| `validation_error` | 400 | 参数校验失败 |
| `denied` | 403 | 策略拒绝 / 上游 401-403 |
| `not_found` | 404 | `operation_id` 未知 |
| `upstream_error` | 502 | 上游 5xx / 网络错误 |

> **提示**：用 `search_api`（或 `npx tsx scripts/inspect.ts search "..."`）查出目标 `operation_id`，再用 `/exec` 批量调用。

## 项目结构

```
src/
├── index.ts            # 入口：启动 → 发现注册 → 提供服务
├── config.ts           # 类型化的环境变量配置
├── server.ts           # MCP Server 工厂 —— 注册 search_api + execute_api
├── transport.ts        # Streamable-HTTP /mcp（有状态会话）
├── services.ts         # 共享的 Registry + Search 容器
├── types.ts            # 领域类型
├── registry/           # OpenAPI 摄取：解析 → 解引用 → 提取 → 存储
├── store/              # SQLite（better-sqlite3）+ FTS5
├── search/             # 可插拔的 OperationSearch（默认 BM25，可选向量嵌入）
├── execute/            # 7 步执行流水线（认证、校验、组装、调用、脱敏）
├── governance/         # 策略、审计、风险确认、脱敏
└── schemas/            # Zod 工具 IO 契约
scripts/
├── bootstrap.ts        # 注册并打印摘要（自带内联上游，不启动 HTTP）
├── ping-service.ts     # 服务连通性自检：探测上游可达性 + 认证有效性（不启动 HTTP）
├── inspect.ts          # 直接查 SQLite：已注册服务 / operation / 检索 / 审计
├── test-e2e.ts         # 完整流水线测试（自带内联上游，独立可跑）
└── lib/test-fixture.ts # 测试夹具：内联 spec + 内联上游
data/
├── services.example.yaml  # 后端服务注册配置示例（复制为 services.yaml）
└── examples/              # OpenAPI spec 格式参考
```

## 配置说明

全部通过环境变量（见 `.env.example`）：

| 变量 | 默认值 | 含义 |
|-----|---------|---------|
| `PORT` | `3001` | 网关 HTTP 端口 |
| `DB_PATH` | `./data/registry.db` | SQLite 文件路径 |
| `SEARCH_PROVIDER` | `bm25` | `bm25` 或 `embedding` |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | ONNX 模型（仅 `embedding` 时生效） |
| `POLICY_PATH` | `./data/policy.json` | 治理策略文件（可选） |
| `REDACT_FIELDS` | `password,token,…` | 逗号分隔的递归脱敏字段列表 |
| `HOST` | `127.0.0.1` | 绑定地址；`0.0.0.0` 监听所有网卡（公网/内网暴露时务必配 `GATEWAY_API_KEY`） |
| `GATEWAY_API_KEY` | _(空)_ | `/mcp` 端点的访问鉴权 key。留空=不鉴权（仅本机安全） |
| `SERVICES_CONFIG` | `./data/services.yaml` | 后端服务注册配置（YAML） |
| `AUTH_<ID>_SCHEME` / `AUTH_<ID>_VALUE` | — | 按服务的凭据（永不返回给调用方） |

## 访问鉴权（公网/内网暴露时必读）

网关有**两层授权**，不要混淆：

```
Agent/客户端 ──①──▶ 网关 /mcp ──②──▶ 上游 NAS 服务
              GATEWAY_API_KEY      AUTH_<ID>_*
```

| 层面 | 配置 | 说明 |
|------|------|------|
| ① 访问网关 `/mcp` | `GATEWAY_API_KEY` | 控制**谁能连网关**。留空=任何人都能调 |
| ② 网关访问上游 NAS | `AUTH_<ID>_*` | 控制**网关怎么认证到 NAS**。凭据仅存内存 |

### 公网/内网部署的安全配置

```bash
# 1. 生成一个随机 key
openssl rand -hex 32

# 2. 写进 .env
GATEWAY_API_KEY=<上面生成的 key>
HOST=0.0.0.0          # 或你的内网/公网 IP
```

客户端访问时带上 key（两种方式均可）：

```bash
# 方式 A：Authorization header
curl -H "Authorization: Bearer <你的key>" http://your-host:3001/mcp ...

# 方式 B：X-API-Key header
curl -H "X-API-Key: <你的key>" http://your-host:3001/mcp ...
```

不带 key 或 key 错误 → `401 Unauthorized`。`/health` 不需要鉴权（健康检查用）。

> **⚠️ 重要：** 网关持有所有 NAS 的凭据（`AUTH_<ID>_*`）。如果 `/mcp` 不鉴权就暴露到公网，等于**任何人都能通过网关白嫖你的 NAS**。公网部署**必须**配 `GATEWAY_API_KEY`。

## 新增 / 管理服务

在 `data/services.yaml` 里加一条声明即可，**零代码**：

```yaml
services:
  - id: <新服务id>
    source: <OpenAPI 文档的 URL 或本地路径>
```

下次启动（或调用 `registry.discover()`）时，网关会自动校验、解引用、提取 Operation、分类风险并建索引。基于 `sha256` 去重，spec 未变则跳过刷新；已有的 `operation_id` 保持稳定。

也可编程式注册：`registry.register({ serviceId, source, baseUrl })`。

## Docker 部署

生产环境用 Docker Compose 部署，三步完成。

### 1. 准备配置

```bash
# 服务配置（编辑成你的 NAS 服务）
cp data/services.example.yaml data/services.yaml

# 环境变量（填 GATEWAY_API_KEY、AUTH_* 等）
cp .env.example .env
# 生成网关访问 key
openssl rand -hex 32   # 把输出填进 .env 的 GATEWAY_API_KEY
```

确认 `.env` 里至少配了：
- `GATEWAY_API_KEY` —— `/mcp` 访问鉴权（公网部署**必须**）
- `AUTH_<ID>_*` —— 各 NAS 服务的认证凭据

### 2. 构建并启动

```bash
docker compose up -d --build
```

查看日志确认服务注册成功：

```bash
docker compose logs -f
# 应看到: [registry] kavita: registered 504 operations ...
#        [openmcp-gateway] 访问鉴权: 已启用（API Key）
```

### 3. 验证

```bash
# 健康检查（无需 key）
curl http://localhost:3001/health

# MCP 调用（需带 key）
curl -H "Authorization: Bearer <你的key>" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -X POST http://localhost:3001/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}'
```

### 常用运维命令

```bash
docker compose up -d          # 启动（后台）
docker compose down           # 停止
docker compose restart        # 重启（改完 services.yaml 后刷新服务）
docker compose logs -f        # 跟踪日志
docker compose up -d --build  # 代码变更后重新构建并启动
```

### 数据持久化

- `./data/` 挂载到容器 `/app/data`，包含 `registry.db`（SQLite）、`services.yaml`、`policy.json`
- 升级镜像不丢数据（数据在宿主机卷上）
- 备份只需备份 `./data/` 目录

### HTTPS / 反向代理

容器只暴露 HTTP（端口 3001）。公网部署需在外部用反向代理终结 HTTPS：

```
Agent ──HTTPS──▶ nginx/Caddy/Cloudflare Tunnel ──HTTP──▶ 容器:3001
```

nginx 示例（MCP 用 Streamable HTTP，需支持 SSE 长连接）：

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;          # SSE 必须关闭缓冲
    proxy_read_timeout 300s;      # 长连接超时
}
```

### 宿主机端口冲突

默认占用宿主机 3001。如需改，编辑 `docker-compose.yml`：

```yaml
ports:
  - "8080:3001"   # 宿主机 8080 → 容器 3001
```

## 架构设计

完整设计见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**：数据模型、执行流水线、检索后端、治理策略与路线图。

## 技术栈

TypeScript（ESM, Node ≥ 22）· `@modelcontextprotocol/sdk` v1 · `@redocly/openapi-core` ·
`ajv` + `ajv-formats` · `undici` · `better-sqlite3`（FTS5）· `express` · `zod`。
