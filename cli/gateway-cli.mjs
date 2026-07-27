#!/usr/bin/env node
/**
 * gateway-cli —— openmcp-gateway 的命令行客户端。
 *
 * 仅通过网关的 REST 端点（/services /ops /search /exec /audit）工作，
 * 用于脚本化、可固化、零 token 地调用已注册的后端服务。
 *
 * 设计：零运行时依赖的单文件脚本，仅用 Node 20+ 内置能力
 *      （fetch / fs / path / child_process / os）。拷过去即用。
 *
 * 配置（环境变量）：
 *   OPENMCP_GATEWAY_URL  网关地址（默认 http://127.0.0.1:3001）
 *   OPENMCP_GATEWAY_KEY  网关 API Key（对应服务端 GATEWAY_API_KEY；未配置服务端鉴权时可留空）
 *   OPENMCP_GATEWAY_REPO self-update 用的 git 仓库地址（HTTPS 或 git@github SSH 形式）
 *
 * 用法见 usage() 或 README。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- 版本号（self-update 用） ---------------------------------------------
// 仓库内 CLI 的版本。每次改本文件时递增。self-update 拉到的远端版本号若不同则提示更新。
const VERSION = "0.1.0";

// ---- 退出码（脚本可凭此判断成败） -----------------------------------------
const EXIT = {
  success: 0,
  usage: 1,
  validation_error: 2,
  confirmation_required: 3,
  denied: 4,
  not_found: 5,
  upstream_error: 6,
  network_error: 7,
};

// 把 ExecuteOutput.status 映射为退出码（对齐 exec-route.ts 的语义）。
function statusToExit(status) {
  switch (status) {
    case "success": return EXIT.success;
    case "validation_error": return EXIT.validation_error;
    case "confirmation_required": return EXIT.confirmation_required;
    case "denied": return EXIT.denied;
    case "not_found": return EXIT.not_found;
    case "upstream_error": return EXIT.upstream_error;
    default: return EXIT.upstream_error;
  }
}

// ---- 配置 -----------------------------------------------------------------
function cfg() {
  return {
    baseUrl: (process.env.OPENMCP_GATEWAY_URL || "http://127.0.0.1:3001").replace(/\/+$/, ""),
    apiKey: process.env.OPENMCP_GATEWAY_KEY || "",
    repo: process.env.OPENMCP_GATEWAY_REPO || "",
  };
}

function versionFilePath() {
  return join(homedir(), ".openmcp-gateway-cli-version");
}

// 当前运行的 CLI 文件所在目录（仓库内为 cli/，全局安装时为该包目录）。
function cliDir() {
  return dirname(fileURLToPath(import.meta.url));
}

// 找仓库根：从 cliDir 往上找 package.json（含 openmcp-gateway 字样）。
function findRepoRoot() {
  let dir = cliDir();
  for (let i = 0; i < 6; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const j = JSON.parse(readFileSync(pj, "utf8"));
        if (j.name === "openmcp-gateway") return dir;
      } catch { /* keep scanning */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---- HTTP 工具 ------------------------------------------------------------
async function http(pathname, { method = "GET", query, body, expectJson = true } = {}) {
  const { baseUrl, apiKey } = cfg();
  const url = new URL(baseUrl + pathname);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

  const headers = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const opts = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    die(`网络请求失败：${err.message}\n  URL: ${url}\n  请确认网关已启动且 OPENMCP_GATEWAY_URL 正确（当前：${baseUrl}）`, EXIT.network_error);
  }

  if (!expectJson) return { status: res.status, text: await res.text() };

  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { /* 保持 null */ }
  }
  return { status: res.status, json };
}

// ---- 输出工具 -------------------------------------------------------------
function die(msg, code = EXIT.usage) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(code);
}

// 简单的等宽表格打印（不依赖外部库）。
function printTable(rows, { headers } = {}) {
  if (!rows.length) return;
  const allRows = headers ? [headers, ...rows] : rows;
  const cols = allRows[0].length;
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...allRows.map((r) => strWidth(r[i]))));
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const fmt = (r) => "| " + r.map((c, i) => padRight(String(c ?? ""), widths[i])).join(" | ") + " |";
  process.stdout.write(sep + "\n");
  if (headers) {
    process.stdout.write(fmt(headers) + "\n");
    process.stdout.write(sep + "\n");
  }
  for (const r of rows) process.stdout.write(fmt(r) + "\n");
  process.stdout.write(sep + "\n");
}

// 中文等宽近似：CJK 字符算 2 列。
function strWidth(s) {
  let n = 0;
  for (const ch of String(s ?? "")) n += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return n;
}
function padRight(s, w) {
  return s + " ".repeat(Math.max(0, w - strWidth(s)));
}

function println(s = "") { process.stdout.write(s + "\n"); }

// ---- 参数解析 -------------------------------------------------------------
// 解析 [--flag value] [--flag] [--param k=v]...，返回 { flags, params, positional }。
function parseArgs(argv, { knownFlags = [], flagNeedsValue = [] } = {}) {
  const out = { flags: {}, params: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--param" || a === "-p") {
      const kv = argv[++i];
      if (!kv || !kv.includes("=")) die(`--param 需要形如 key=value（得到：${kv ?? "（无）"}）`);
      const eq = kv.indexOf("=");
      const k = kv.slice(0, eq);
      const v = parseValue(kv.slice(eq + 1));
      out.params[k] = v;
      continue;
    }
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (flagNeedsValue.includes(name)) {
        out.flags[name] = argv[++i];
      } else {
        out.flags[name] = true;
      }
      continue;
    }
    if (a.startsWith("-") && a.length === 2) {
      const name = a.slice(1);
      if (flagNeedsValue.includes(name)) {
        out.flags[name] = argv[++i];
      } else {
        out.flags[name] = true;
      }
      continue;
    }
    out.positional.push(a);
  }
  return out;
}

// --param 的值：先尝试 JSON.parse（支持数字/布尔/对象/数组），失败按字符串。
function parseValue(raw) {
  try { return JSON.parse(raw); } catch { return raw; }
}

// ============================================================================
// 子命令
// ============================================================================

// ---- version --------------------------------------------------------------
function cmdVersion() {
  const repo = findRepoRoot();
  let lastUpdated = "（未记录）";
  const vf = versionFilePath();
  if (existsSync(vf)) {
    try {
      const v = JSON.parse(readFileSync(vf, "utf8"));
      lastUpdated = `${v.sha ? v.sha.slice(0, 8) + " " : ""}(${v.date ?? "?"})`;
    } catch { /* ignore */ }
  }
  println(`gateway-cli v${VERSION}`);
  println(`  CLI 位置:     ${fileURLToPath(import.meta.url)}`);
  if (repo) println(`  仓库根:       ${repo}`);
  println(`  上次 self-update: ${lastUpdated}`);
  println(`  网关地址:     ${cfg().baseUrl}`);
  println(`  self-update 源: ${cfg().repo || "（未设置 OPENMCP_GATEWAY_REPO）"}`);
}

// ---- services -------------------------------------------------------------
async function cmdServices(args) {
  const { json: asJson } = args.flags;
  const { status, json } = await http("/services");
  if (status !== 200) die(`获取服务列表失败（HTTP ${status}）：${JSON.stringify(json)}`, EXIT.network_error);
  if (asJson) { println(JSON.stringify(json, null, 2)); return; }
  if (!json.services?.length) { println("（无已注册服务）"); return; }
  println(`已注册服务（${json.total} 个）：\n`);
  printTable(
    json.services.map((s) => [s.id, s.name ?? "", s.operations ?? 0, s.base_url ?? ""]),
    { headers: ["ID", "名称", "接口数", "Base URL"] },
  );
}

// ---- ops ------------------------------------------------------------------
async function cmdOps(args) {
  const { json: asJson } = args.flags;
  const serviceId = args.flags.service || args.positional[0];
  const { status, json } = await http("/ops", { query: { service_id: serviceId } });
  if (status !== 200) die(`获取 operation 列表失败（HTTP ${status}）：${JSON.stringify(json)}`, EXIT.network_error);
  if (asJson) { println(JSON.stringify(json, null, 2)); return; }
  if (!json.operations?.length) {
    println(serviceId ? `（服务 ${serviceId} 无 operation）` : "（无 operation）");
    return;
  }
  const where = serviceId ? `服务 ${serviceId}` : "全部服务";
  println(`${where} 的 operation（${json.total} 个）：\n`);
  printTable(
    json.operations.map((o) => [o.risk_level, o.method, `${o.service_id}${o.path}`, o.operation_id]),
    { headers: ["风险", "方法", "路径", "Operation ID"] },
  );
}

// ---- search ---------------------------------------------------------------
async function cmdSearch(args) {
  const { json: asJson } = args.flags;
  const query = (args.positional.join(" ") || "").trim();
  if (!query) die("用法: gateway-cli search \"<自然语言查询>\" [--service <id>] [--limit N]");
  const limit = args.flags.limit ? Number(args.flags.limit) : 10;
  const serviceId = args.flags.service;
  const { status, json } = await http("/search", { query: { q: query, limit, service_id: serviceId } });
  if (status !== 200) die(`检索失败（HTTP ${status}）：${JSON.stringify(json)}`, EXIT.network_error);
  if (asJson) { println(JSON.stringify(json, null, 2)); return; }
  if (!json.results?.length) { println(`为「${query}」无匹配。尝试换个说法。`); return; }
  const where = serviceId ? `（限定服务 ${serviceId}）` : "";
  println(`为「${query}」${where} 找到 ${json.total} 个接口：\n`);
  for (const r of json.results) {
    println(`• ${r.operation_id}  [${r.method} ${r.service_id}${r.path}]  风险:${r.risk_level}  匹配度:${r.score}`);
    if (r.summary) println(`  ${r.summary}`);
    println(`  必填参数: ${r.required_params.join(", ") || "（无）"}`);
  }
}

// ---- exec -----------------------------------------------------------------
async function cmdExec(args) {
  const operationId = args.positional[0];
  if (!operationId) die("用法: gateway-cli exec <operation_id> [--param k=v]... [--confirm] [--json]");
  const { json: asJson } = args.flags;
  const confirm = !!args.flags.confirm;
  const params = Object.keys(args.params).length ? args.params : undefined;

  const { status, json } = await http(`/exec/${encodeURIComponent(operationId)}`, {
    method: "POST",
    body: { params, confirm },
  });

  // 4xx/5xx 时 exec-route 仍返回 ExecuteOutput JSON；按其 status 映射退出码。
  const resultStatus = json?.status;
  if (asJson) {
    println(JSON.stringify(json, null, 2));
  } else {
    printExecResult(operationId, status, json);
  }
  process.exit(resultStatus ? statusToExit(resultStatus) : (status >= 200 && status < 300 ? 0 : EXIT.upstream_error));
}

function printExecResult(operationId, httpStatus, r) {
  if (!r) { println(`✗ HTTP ${httpStatus}（无响应体）`); return; }
  const ok = r.status === "success";
  const head = ok ? "✓" : "✗";
  println(`${head} ${operationId}  [${r.status}]  HTTP ${httpStatus}${r.status_code ? ` (upstream ${r.status_code})` : ""}`);
  if (r.risk_level) println(`  风险等级: ${r.risk_level}`);
  if (r.message) println(`  ${r.message}`);
  if (r.details?.length) {
    println(`  详情:`);
    for (const d of r.details) println(`    - ${d}`);
  }
  if (ok && r.data !== undefined) {
    println(`\n  data:`);
    println(indent(JSON.stringify(r.data, null, 2), "    "));
  }
}

function indent(text, prefix) {
  return text.split("\n").map((l) => prefix + l).join("\n");
}

// ---- audit ----------------------------------------------------------------
async function cmdAudit(args) {
  const { json: asJson } = args.flags;
  const limit = args.positional[0] ? Number(args.positional[0]) : 20;
  const { status, json } = await http("/audit", { query: { limit } });
  if (status !== 200) die(`获取审计失败（HTTP ${status}）：${JSON.stringify(json)}`, EXIT.network_error);
  if (asJson) { println(JSON.stringify(json, null, 2)); return; }
  if (!json.audit?.length) { println("（暂无审计记录）"); return; }
  println(`最近 ${json.total} 条审计：\n`);
  printTable(
    json.audit.map((a) => [a.iso, a.outcome, a.operation_id, a.status_code ?? "-", `${a.duration_ms}ms`, a.caller ?? "-"]),
    { headers: ["时间(UTC)", "结果", "Operation", "状态码", "耗时", "来源"] },
  );
}

// ---- install-skill --------------------------------------------------------
// 支持两种写法（符合直觉，避免用户漏写 --target）：
//   gateway-cli install-skill                       → 装到默认 ~/.zcode/skills
//   gateway-cli install-skill <dir>                 → 装到 <dir>（裸路径）
//   gateway-cli install-skill --target <dir>        → 装到 <dir>（显式 flag）
function cmdInstallSkill(args) {
  // --target 优先；否则取第一个位置参数；都没有则用默认值。
  const target = args.flags.target || args.positional[0] || join(homedir(), ".zcode", "skills");
  const skillId = "openmcp-gateway";

  // skill 源目录：仓库内 skills/openmcp-gateway/
  const repo = findRepoRoot();
  const srcRoot = repo ? join(repo, "skills", skillId) : join(cliDir(), "skills", skillId);
  if (!existsSync(srcRoot)) {
    die(`未找到 skill 源目录：${srcRoot}\n  （install-skill 需在仓库内运行，或 skill 已随包分发）`);
  }

  const dest = join(target, skillId);
  mkdirSync(dest, { recursive: true });
  copyTree(srcRoot, dest);
  println(`✓ 已安装 skill「${skillId}」→ ${dest}`);
  println(`  请确认该目录在你的 Agent skills 搜索路径内（ZCode 默认 ~/.zcode/skills/）。`);
}

// 递归拷贝目录树。
function copyTree(src, dest) {
  const entries = readdirSync(src);
  for (const name of entries) {
    const s = join(src, name);
    const d = join(dest, name);
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

// ---- update（self-update）-------------------------------------------------
//
// 从 git 仓库拉取最新 cli/gateway-cli.mjs 与 skills/openmcp-gateway/SKILL.md。
// 默认 main 分支，可用 --branch <name> 覆盖；--check 只比对不写。
function cmdUpdate(args) {
  const { repo } = cfg();
  if (!repo) {
    die(
      `未设置 self-update 源。\n` +
      `请设置环境变量 OPENMCP_GATEWAY_REPO 指向本仓库地址，例如：\n` +
      `  export OPENMCP_GATEWAY_REPO=https://github.com/<owner>/openmcp-gateway.git\n` +
      `  export OPENMCP_GATEWAY_REPO=git@github.com:<owner>/openmcp-gateway.git`,
    EXIT.usage,
    );
  }
  const branch = args.flags.branch || "main";
  const checkOnly = !!args.flags.check;

  // 1) 拿到远端最新 commit SHA（用 git ls-remote，仅依赖本地 git）。
  const ls = spawnSync("git", ["ls-remote", repo, `refs/heads/${branch}`], { encoding: "utf8" });
  if (ls.status !== 0) {
    die(`git ls-remote 失败（分支 ${branch}）:\n${ls.stderr || ls.stdout}`, EXIT.network_error);
  }
  const shaLine = (ls.stdout || "").split("\n").find((l) => l.trim());
  if (!shaLine) die(`远端分支 ${branch} 不存在或为空。`, EXIT.not_found);
  const remoteSha = shaLine.split(/\s+/)[0];

  // 2) 与本地记录的 SHA 比对。
  const vf = versionFilePath();
  let localSha = "";
  if (existsSync(vf)) {
    try { localSha = JSON.parse(readFileSync(vf, "utf8")).sha || ""; } catch { /* ignore */ }
  }

  println(`远端分支: ${branch}`);
  println(`远端 SHA: ${remoteSha}`);
  println(`本地 SHA: ${localSha || "（未记录，首次运行）"}`);

  if (localSha === remoteSha) {
    println(`\n✓ 已是最新（${remoteSha.slice(0, 8)}）。`);
    return;
  }
  if (checkOnly) {
    println(`\n⬆ 有更新可用。去掉 --check 实际执行更新。`);
    return;
  }

  // 3) 推导 raw 文件 URL（GitHub HTTPS → raw.githubusercontent.com；其它 host 走 <repo>/raw/<branch>/...）。
  const rawBase = toRawBase(repo, branch);
  const cliUrl = `${rawBase}/cli/gateway-cli.mjs`;
  const skillUrl = `${rawBase}/skills/openmcp-gateway/SKILL.md`;

  // 4) 拉最新 CLI 覆盖自身。
  const cliPath = fileURLToPath(import.meta.url);
  const cliText = fetchSync(cliUrl);
  if (!cliText) die(`拉取 CLI 失败：${cliUrl}`, EXIT.network_error);
  writeFileSync(cliPath, cliText);
  println(`✓ 已更新 CLI：${cliPath}`);

  // 5) 拉最新 skill，直接覆盖仓库源 + 所有已安装的副本，一键同步到位。
  const skillText = fetchSync(skillUrl);
  if (skillText) {
    const repo = findRepoRoot();
    // 所有可能装了本 skill 的位置：仓库源 + 各 Agent 的 skills 目录。
    const home = homedir();
    const skillCandidates = [
      repo ? join(repo, "skills", "openmcp-gateway", "SKILL.md") : null,
      join(home, ".zcode", "skills", "openmcp-gateway", "SKILL.md"),
      join(home, ".cc-switch", "skills", "openmcp-gateway", "SKILL.md"),
      join(home, ".claude", "skills", "openmcp-gateway", "SKILL.md"),
    ].filter(Boolean);

    // 只覆盖已存在的副本——不主动创建用户没在用的 Agent 目录。
    const installed = skillCandidates.filter((p) => existsSync(p));
    let updated = 0;
    let skipped = 0;
    for (const p of installed) {
      if (readFileSync(p, "utf8") === skillText) { skipped++; continue; }
      writeFileSync(p, skillText);
      println(`✓ 已更新 skill：${p}`);
      updated++;
    }
    if (installed.length === 0) {
      println(`ℹ 未检测到已安装的 skill。如需使用：gateway-cli install-skill`);
    } else if (updated === 0) {
      println(`✓ skill 已是最新（${skipped} 处安装位置均无需更新）。`);
    } else if (skipped > 0) {
      println(`✓ skill 更新完成（更新 ${updated} 处，${skipped} 处已是最新）。`);
    } else {
      println(`✓ skill 更新完成（${updated} 处）。`);
    }
  } else {
    println(`（skill 拉取失败，已跳过：${skillUrl}）`);
  }

  // 6) 记录本次 SHA。
  writeFileSync(vf, JSON.stringify({ sha: remoteSha, date: new Date().toISOString(), branch, repo }, null, 2));
  println(`\n✓ self-update 完成。当前进程仍为旧版；新开终端或重新调用 gateway-cli 即生效。`);
}

// 把仓库地址转成 raw 文件 URL 前缀。
//   https://github.com/<o>/<r>(.git)  → https://raw.githubusercontent.com/<o>/<r>/<branch>
//   git@github.com:<o>/<r>(.git)      → https://raw.githubusercontent.com/<o>/<r>/<branch>
//   其它 https 仓库                    → <repo 去掉 .git>/raw/<branch>
function toRawBase(repo, branch) {
  const gh = repo.match(/^(?:https:\/\/|git@)github\.com[:/]([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${branch}`;
  const trimmed = repo.replace(/\.git$/, "").replace(/\/+$/, "");
  return `${trimmed}/raw/${branch}`;
}

// 同步 fetch（用 spawnSync curl 兜底，避免 Node 旧版无同步 fetch）。
// 优先用全局 fetch（async）→ 写临时文件 → 读回；为保持 CLI 单文件、同步控制流，
// 这里用 child_process 调 node 内联脚本完成「同步 fetch」。
function fetchSync(url) {
  const code = `(async()=>{try{const r=await fetch(${JSON.stringify(url)});process.stdout.write(await r.text());}catch(e){process.stderr.write(e.message);process.exit(1);}})()`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout;
}

// ---- usage ----------------------------------------------------------------
function usage() {
  println(`gateway-cli v${VERSION} —— openmcp-gateway 命令行客户端

用法:
  gateway-cli <command> [options]

命令:
  version                              显示版本与配置
  services                             列出已注册服务
  ops [service_id] [--service <id>]    列出 operation（可按服务过滤）
  search "<自然语言>" [--service <id>] [--limit N]  语义检索，找 operation_id
  exec <operation_id> [options]        执行一个 operation
  audit [N]                            最近 N 条审计（默认 20）
  install-skill [<dir>]                安装配套 skill 到 Agent skills 目录（默认 ~/.zcode/skills）
  update [--branch <name>] [--check]   从 git 仓库拉取最新 CLI/skill

exec 选项:
  --param key=value     业务参数（可多次；值支持 JSON：数字/布尔/对象/数组）
  --confirm             确认执行 elevated/dangerous 操作
  --json                输出原始 JSON（脚本友好）
  -p key=value          --param 的短写

通用选项:
  --json                输出原始 JSON（适用于 services/ops/search/audit/exec）
  --target <dir>        install-skill 的目标目录（也可用裸路径：install-skill <dir>）
  --branch <name>       update 的远端分支（默认 main）
  --check               update 只比对不写

环境变量:
  OPENMCP_GATEWAY_URL   网关地址（默认 http://127.0.0.1:3001）
  OPENMCP_GATEWAY_KEY   网关 API Key（对应服务端 GATEWAY_API_KEY）
  OPENMCP_GATEWAY_REPO  self-update 用的 git 仓库地址

退出码:
  0 成功 / 1 用法错误 / 2 参数校验失败 / 3 需确认(高风险)
  4 被拒绝 / 5 未找到 / 6 上游错误 / 7 网络错误

示例（先 search 找到真实 operation_id，再 exec）:
  gateway-cli services                              # 看有哪些服务
  gateway-cli search "搜索漫画"                     # 检索，从结果里拿 operation_id
  gateway-cli exec <operation_id>                   # 无参执行
  gateway-cli exec <operation_id> --param k=v       # 传参（值自动按 JSON 解析）
  gateway-cli exec <operation_id> --confirm         # 高风险操作需显式确认
  gateway-cli exec <operation_id> --json | jq '.data'   # 脚本友好输出
`);
}

// ============================================================================
// 入口
// ============================================================================
async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") { usage(); process.exit(0); }

  try {
    switch (cmd) {
      case "version":
      case "--version":
      case "-v":
        return cmdVersion();
      case "services":
        return await cmdServices(parseArgs(rest));
      case "ops":
        return await cmdOps(parseArgs(rest, { flagNeedsValue: ["service"] }));
      case "search":
        return await cmdSearch(parseArgs(rest, { flagNeedsValue: ["limit", "service"] }));
      case "exec":
        return await cmdExec(parseArgs(rest));
      case "audit":
        return await cmdAudit(parseArgs(rest));
      case "install-skill":
        return cmdInstallSkill(parseArgs(rest, { flagNeedsValue: ["target"] }));
      case "update":
        return cmdUpdate(parseArgs(rest, { flagNeedsValue: ["branch"] }));
      default:
        usage();
        die(`未知命令：${cmd}`, EXIT.usage);
    }
  } catch (err) {
    die(`未捕获错误：${err.stack || err.message}`, EXIT.usage);
  }
}

main();
