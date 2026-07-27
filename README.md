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
- **双通路架构（MCP 或 CLI，二选一）** —— 对外提供两条互相独立、互不引用的通路，用户按需选其一：**MCP**（`search_api` + `execute_api` 工具，给 LLM/Agent 用）或 **CLI**（`gateway-cli` 二进制 + REST 端点，给脚本/终端用）。两者底层共用同一个 `execute()` 管道，治理（鉴权/策略/审计/脱敏/风险确认）完全一致。配套 `skills/openmcp-gateway/SKILL.md` 教会 Agent 用 CLI（自身不引用 MCP），`gateway-cli update` 可从 git 仓库 self-update。

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

## CLI 通路（脚本/终端直调）

对于**批量、可固化、零 token**的工作流，不必让 Agent 一轮轮经 LLM 调 `execute_api`——网关提供一条**与 MCP 完全独立的 CLI 通路**：`gateway-cli` 二进制 + 一组 REST 端点，让任意脚本/终端直接打到同一个 `execute()` 管道。

> **双通路原则**：MCP（`search_api`/`execute_api` 工具）与 CLI（`gateway-cli` + REST）互相独立、互不引用，底层共用 `execute()`，治理（鉴权/策略/审计/脱敏/风险确认）完全一致。审计里 `caller` 分别为 `http:exec`、MCP 会话 id 等，便于区分。不要把 CLI 经 MCP 调用，也不要在 MCP 工具描述里引用 CLI。

### gateway-cli 命令行

零依赖单文件脚本（仅 Node 20+ 内置能力，拷过去即用）。`npm link` 后全局可用，或直接 `node cli/gateway-cli.mjs`：

```bash
# 配置（写入 .env 或 shell profile）
export OPENMCP_GATEWAY_URL=http://127.0.0.1:3001
export OPENMCP_GATEWAY_KEY=<GATEWAY_API_KEY>        # 服务端 GATEWAY_API_KEY；未配置服务端鉴权时可留空
export OPENMCP_GATEWAY_REPO=<仓库地址>               # self-update 源（可选）

# 核心工作流：先搜索，再执行
gateway-cli services                       # 列出已注册服务
gateway-cli ops [service_id]               # 列出 operation
gateway-cli search "搜索漫画"              # 语义检索，找 operation_id
gateway-cli exec <operation_id> \
    --param key=value [--confirm] [--json] # 执行（值自动按 JSON 解析）

# 浏览与维护
gateway-cli audit 20                       # 最近 20 条审计
gateway-cli version                        # 版本与配置
gateway-cli update [--check]               # 从 git 仓库 self-update
gateway-cli install-skill                  # 装 skills/openmcp-gateway 到 ~/.zcode/skills
```

**退出码**（脚本可凭此判断成败）：`0` 成功 / `1` 用法错误 / `2` 参数校验失败 / `3` 需确认(高风险) / `4` 被拒绝 / `5` 未找到 / `6` 上游错误 / `7` 网络错误。

详见 `skills/openmcp-gateway/SKILL.md`（`gateway-cli install-skill` 可自动安装到 Agent skills 目录）。

### REST 端点（CLI 底层）

`gateway-cli` 走的是以下 REST 端点，任意能发 HTTP 的程序都可直调（与 `/mcp` 共用 `GATEWAY_API_KEY`）：

```
GET  /services                            服务清单
GET  /ops?service_id=<id>                 operation 清单（可按服务过滤）
GET  /search?q=<自然语言>&limit=N          语义检索
POST /exec/<operation_id>                 执行
GET  /audit?limit=N                       最近 N 条审计（参数已脱敏）
```

`POST /exec`：

```
POST /exec/<operation_id>
Header: Authorization: Bearer <GATEWAY_API_KEY>   （或 X-API-Key，见「访问鉴权」）
Body:   { "params": { ... }, "confirm": true|false }
```

### 何时用 CLI 而非 MCP

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

> **提示**：用 `gateway-cli search "..."`（或 `search_api`、`npx tsx scripts/inspect.ts search "..."`）查出目标 `operation_id`，再用 `gateway-cli exec` 或 `POST /exec` 批量调用。

## 把多个 API 组合成 Workflow（自定义场景 Skill）

`openmcp-gateway` 这个 skill 保持**原子化**——它只教「先 search、再 exec」两个动作，故意不内置任何具体业务编排。当某个场景需要**把多个 API 串起来**（跨服务、多步骤、带分支判断）时，**不要去改 gateway skill**，而是新建一个独立的「场景 skill」，在里面通过 `gateway-cli`（或直接打 REST）引用网关能力。

### 分层原则

```
┌─────────────────────────────────────────────┐
│  你的场景 skill（如 media-organize）         │  ← 你写的：业务编排、固定参数、分支逻辑
│   scripts/*.sh 调 gateway-cli exec ...      │
└──────────────────┬──────────────────────────┘
                   │ gateway-cli（search / exec）
                   ▼
┌─────────────────────────────────────────────┐
│  openmcp-gateway skill + gateway-cli        │  ← 原子能力：检索 + 执行，不变
└──────────────────┬──────────────────────────┘
                   │ REST /exec、/search
                   ▼
┌─────────────────────────────────────────────┐
│  网关 → 后端服务（seerr / emby / kavita...） │
└─────────────────────────────────────────────┘
```

- **gateway skill 是地基**：只提供 search/exec 原语，所有场景共用。
- **场景 skill 是上层**：固化「调哪个 operation_id、传什么参数、什么顺序、怎么判断结果」，把网关当库来调。
- 场景 skill 与 gateway skill **松耦合**：换 operation_id 只需改场景 skill，不动网关。

### 例子：`media-organize` ——「请求影片 → 等下载 → 标记已看」

目标：给一部电影发起请求，确认它已被下载，再把 Emby 里的对应条目标为已看。这是一个跨 seerr + emby 的三步 workflow。

**步骤 1：先用 gateway-cli 摸清要用哪几个 operation_id**

```bash
gateway-cli search "请求一部电影" --service seerr --limit 3
gateway-cli search "查询某请求的状态" --service seerr --limit 3
gateway-cli search "标记某剧集为已看" --service emby --limit 3
# 记下三个 operation_id，例如：
#   seerr_post__request            （发起请求，dangerous，需 --confirm）
#   seerr_get__request__requestId  （查请求状态）
#   emby_post__items__id__played   （标已看，elevated，需 --confirm）
```

**步骤 2：创建场景 skill 目录**

```bash
mkdir -p ~/.zcode/skills/media-organize/scripts
```

**步骤 3：写一个编排脚本**（`~/.zcode/skills/media-organize/scripts/request-and-mark.sh`）

```bash
#!/usr/bin/env bash
# 用法: request-and-mark.sh "<电影名>" "<tmdbId>"
# 依赖: gateway-cli 已安装且 OPENMCP_GATEWAY_URL/KEY 已配置
set -euo pipefail

TITLE="$1"; TMDB_ID="$2"
g() { gateway-cli exec "$@" --json; }   # 统一带 --json 方便解析

# 1) 发起请求（dangerous，必须 --confirm；这里假设人工已确认）
REQUEST_ID=$(g seerr_post__request \
    --param 'body={"mediaType":"movie","mediaId":'"$TMDB_ID"'}' \
    --confirm \
  | jq -r '.data.id')

echo "✓ 已请求「$TITLE」(requestId=$REQUEST_ID)，等待下载完成..."

# 2) 轮询请求状态直到 available（简化：最多等 10 分钟）
for i in $(seq 1 20); do
  STATUS=$(g seerr_get__request__requestId --param requestId="$REQUEST_ID" | jq -r '.data.status')
  echo "  [$i] status=$STATUS"
  [ "$STATUS" = "available" ] && break
  sleep 30
done

# 3) 在 Emby 里标记已看（elevated，需 --confirm）
ITEM_ID=$(g emby_get__items --param search="$TITLE" | jq -r '.data.Items[0].Id')
g emby_post__items__id__played --param itemId="$ITEM_ID" --confirm >/dev/null
echo "✓ 「$TITLE」已在 Emby 标记为已看"
```

```bash
chmod +x ~/.zcode/skills/media-organize/scripts/request-and-mark.sh
```

**步骤 4：写场景 skill 的 SKILL.md**（`~/.zcode/skills/media-organize/SKILL.md`）

```markdown
---
name: media-organize
description: 影片请求+下载+标记已看的固定 workflow。当用户说「帮我要这部电影并标记已看」「请求某某然后标看完」时触发。底层通过 gateway-cli 调用 seerr/emby，依赖 openmcp-gateway skill 提供的网关能力。
---

# media-organize

把「请求影片 → 等下载 → 标记已看」固化成一条命令。

## 前置
- 已安装 openmcp-gateway skill，gateway-cli 可用，网关已启动。

## 用法
\`\`\`bash
bash ~/.zcode/skills/media-organize/scripts/request-and-mark.sh "电影名" "<tmdbId>"
\`\`\`

工作流见脚本注释。如需改用别的服务（如把 emby 换成 jellyfin），改脚本里的 operation_id 即可，不用动网关。
```

就这样——网关 skill 一行没改，所有业务知识都封在这个场景 skill 里。换 operation_id、加步骤、加错误重试，全在场景 skill 这一层做。

### 何时该新建场景 skill（而不是直接敲 gateway-cli）

- 同一组操作要**反复跑**（每周整理、批量入库、定时同步）。
- 步骤之间有**数据依赖**（上一步的返回值喂给下一步）。
- 想让 **Agent/同事一键触发**一个完整流程，而不是手敲三条命令。
- 流程稳定后想**版本管理**（脚本进 git，可 review、可回滚）。

反之，临时一次性调用、或在对话里探索性试 API，直接 `gateway-cli search` + `gateway-cli exec` 即可，不必建 skill。

> **与 MCP 通路的关系**：如果你更偏好让 LLM 在对话里编排，也可以不写场景 skill，直接用 MCP 的 `search_api`/`execute_api` 让 Agent 即兴组合。两条路互不引用，按场景选其一即可。

## 项目结构

```
src/
├── index.ts            # 入口：启动 → 发现注册 → 提供服务
├── config.ts           # 类型化的环境变量配置
├── server.ts           # MCP Server 工厂 —— 注册 search_api + execute_api
├── transport.ts        # Streamable-HTTP /mcp（有状态会话）+ 挂载 REST 路由
├── exec-route.ts       # REST 执行入口 POST /exec/:operationId
├── search-route.ts     # REST 检索入口 GET /search（CLI 通路）
├── catalog-route.ts    # REST 目录入口 GET /services、/ops、/audit（CLI 通路）
├── services.ts         # 共享的 Registry + Search 容器
├── types.ts            # 领域类型
├── registry/           # OpenAPI 摄取：解析 → 解引用 → 提取 → 存储
├── store/              # SQLite（better-sqlite3）+ FTS5
├── search/             # 可插拔的 OperationSearch（默认 BM25，可选向量嵌入）+ format.ts（命中充实）
├── execute/            # 7 步执行流水线（认证、校验、组装、调用、脱敏）
├── governance/         # 策略、审计、风险确认、脱敏
└── schemas/            # Zod 工具 IO 契约
cli/
└── gateway-cli.mjs     # CLI 通路二进制（零依赖单文件，含 self-update + install-skill）
skills/
└── openmcp-gateway/SKILL.md  # 配套 skill：教 Agent 用 gateway-cli
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
