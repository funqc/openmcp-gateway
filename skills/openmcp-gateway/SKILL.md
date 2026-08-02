---
name: openmcp-gateway
description: 通过 gateway-cli 命令行脚本化直调已注册的 NAS / 后端服务（Seerr、Emby、Kavita、Mealie、Immich、Prowlarr、Bangumi、文件系统、RSSHub 等）。当用户要批量/可固化/零 token 地调用某个服务的接口（搜索媒体、列出库、获取/更新进度、触发下载、查询资源等）时，使用本 skill。工作流是先 search 找到 operation_id，再 exec 执行；高风险操作需 --confirm。底层治理（鉴权/策略/审计/脱敏/风险确认）全部在网关侧统一完成，CLI 只负责发请求。
---

# openmcp-gateway · gateway-cli 用法

本网关把所有后端服务的 OpenAPI 文档注册到一个统一目录，对外只暴露「先检索、再执行」两个动作。本 skill 教你怎么用 `gateway-cli` 命令行完成这两个动作，从而脚本化、可固化、零 token 地调用任意已注册服务。

## ⚠️ 铁律：必须通过网关

**所有 API 调用必须经过 `gateway-cli`，禁止直接调用服务 API（curl、HTTP 请求等）。**

- ✅ `gateway-cli exec <operation_id> --param key=value --json`
- ❌ `curl -H "X-Api-Key: ..." https://xxx.<YOUR_DOMAIN>:18443/api/...`
- ❌ 任何绕过网关的直接 HTTP 调用

**理由**：网关统一管理认证、审计、限流、参数校验。直接调用绕过这些能力，审计日志缺失、凭证泄露风险增加。

## 前置条件

1. 网关已启动（默认 `http://127.0.0.1:3001`）。
2. 设置环境变量（写入 `.env` 或 shell profile）：

```bash
export OPENMCP_GATEWAY_URL=http://127.0.0.1:3001   # 网关地址
export OPENMCP_GATEWAY_KEY=<GATEWAY_API_KEY>        # 服务端 GATEWAY_API_KEY；未配置服务端鉴权时可留空
export OPENMCP_GATEWAY_REPO=https://github.com/<owner>/openmcp-gateway.git  # self-update 源（可选）
```

3. `gateway-cli` 在 PATH 中（`npm link` 或直接 `node cli/gateway-cli.mjs`）。

## 核心工作流：先搜索，再执行

所有调用都遵循 **search → exec** 两步：先用自然语言检索找到 `operation_id`，再执行。

### 步骤 1：发现要调哪个接口

```bash
# 看网关里注册了哪些服务
gateway-cli services

# 列出某服务的所有 operation（或全部）
gateway-cli ops seerr
gateway-cli ops                  # 全部服务

# 用自然语言语义检索（最常用）
gateway-cli search "搜索漫画"
gateway-cli search "列出所有库"
gateway-cli search "获取阅读进度"
gateway-cli search "重置分享链接" --limit 5
gateway-cli search "标记已看" --service emby    # 限定在某服务内检索
```

`search` 返回每个命中接口的 `operation_id`、HTTP 方法、路径、风险等级、必填参数、匹配度。

> **关于 operation_id 格式**：每个 id 自动带服务前缀（如 `filesystem_list_files_...`、`seerr_get__discover_trending`），保证跨服务全局唯一。`exec` 时直接用 `search` 返回的完整 id，不要手动拼接或截断。

> **优先用 `ops` 列全量，再用 `search` 补位**：当你已知要操作哪个服务时，`gateway-cli ops <service>` 会返回该服务**全部** operation 的完整清单（id / 方法 / 路径 / 风险 / 必填参数），比 `search` 的语义检索更全、更准——`search` 靠关键词匹配，可能漏掉命名不直观的接口。建议先 `ops <service>` 通览全貌、锁定目标，只有在不清楚该用哪个服务 / 不知道接口叫什么时才退回 `search`。

### 步骤 2：执行

```bash
gateway-cli exec <operation_id> [--param key=value]... [--confirm] [--json]
```

**`--param key=value`**：业务参数（path / query / header / body 合并）。值默认是字符串，但会自动按 JSON 解析——数字、布尔、对象、数组都能传。`<operation_id>` 一律先用 `search` 查到真实值再代入（每个服务/接口的 id 不同，不要照抄示例）：

```bash
# 无参 GET（用 search 查到的真实 operation_id）
gateway-cli exec <operation_id>

# 字符串参数
gateway-cli exec <operation_id> --param query="进击的巨人"

# 数字 + 对象参数（注意 shell 引号）
gateway-cli exec <operation_id> --param bookId=42 --param page=120
gateway-cli exec <operation_id> --param 'body={"hello":"world"}'
```

**`--confirm`**：elevated / dangerous（高风险）操作必须显式确认。不带 `--confirm` 调高风险操作会返回**退出码 3** + `confirmation_required`，提示你确认后重带 `--confirm` 再调：

```bash
gateway-cli exec <operation_id> --param k=v            # 高风险 → 退出码 3，需确认
gateway-cli exec <operation_id> --param k=v --confirm  # 确认后真正执行
```

**`--json`**：输出原始 JSON，方便脚本 `jq` 解析（适用于所有命令）：

```bash
gateway-cli exec <operation_id> --json | jq '.data'
```

## 退出码（脚本据此判断成败）

| 退出码 | 含义 |
|--------|------|
| 0 | 成功 |
| 1 | 用法错误 |
| 2 | 参数校验失败（params 不符 schema） |
| 3 | 需确认（高风险操作未带 `--confirm`） |
| 4 | 被策略拒绝 |
| 5 | operation_id 未找到 |
| 6 | 上游服务错误 |
| 7 | 网络错误（网关不可达） |

```bash
gateway-cli exec <operation_id> --param k=v
case $? in
  0)   echo "成功" ;;
  3)   echo "高风险，需 --confirm" ;;
  6|7) echo "失败，稍后重试" ;;
esac
```

## 审计与浏览

```bash
gateway-cli audit 20          # 最近 20 条调用审计（参数已脱敏）
gateway-cli services          # 服务清单
gateway-cli ops seerr         # 某 service 的 operation 清单
```

## 更新与维护

```bash
gateway-cli version           # 查看版本、网关地址、上次 self-update 的 commit
gateway-cli update --check    # 检查 git 仓库是否有新版本
gateway-cli update            # 拉取最新 cli/gateway-cli.mjs 覆盖自身，并提示 skill 更新
gateway-cli install-skill     # 把本 skill 拷到 ~/.zcode/skills/openmcp-gateway/
```

- `update` 从 `OPENMCP_GATEWAY_REPO` 拉，默认 `main` 分支，可用 `--branch <name>` 覆盖。
- skill（本文件）随仓库版本走；`update` 若发现 skill 有变更会提示重跑 `install-skill`。
- 更新完成后**当前进程仍是旧版**，新开终端或重新调用即生效。

## 完整示例：批量为某用户标记观影进度

```bash
# 1) 找到设置进度的接口
gateway-cli search "标记某剧集为已看" --json | jq -r '.results[0].operation_id'
# → markEpisodeWatched

# 2) 批量执行
for ep in 1 2 3 4 5; do
  gateway-cli exec markEpisodeWatched --param episodeId="$ep" --confirm --json \
    | jq -r ".status + \" ep=$ep\""
done
```

## 故障排查

- **网络错误（退出码 7）**：检查 `OPENMCP_GATEWAY_URL` 与网关是否启动（`curl $OPENMCP_GATEWAY_URL/health`）。
- **退出码 4（denied）**：operation 被策略文件 deny，或上游返回 401/403（凭据问题，检查服务端 `AUTH_<ID>_*`）。
- **参数校验失败（退出码 2）**：`--json` 输出里有 `details` 列出每个字段的问题。
- **`update` 失败**：确认 `OPENMCP_GATEWAY_REPO` 可访问、本地有 `git`、`git ls-remote` 能连上远端。
