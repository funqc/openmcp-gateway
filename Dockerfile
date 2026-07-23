# =============================================================================
# OpenMCP Gateway —— 多阶段构建
#   阶段 1 (build): 安装依赖 + tsc 编译
#   阶段 2 (runtime): 仅含生产依赖 + 编译产物，镜像更小
# =============================================================================
# better-sqlite3@13 要求 node >= 22，且有原生模块需要编译。

# ---- 阶段 1：构建 ----
FROM node:22-slim AS build

# better-sqlite3 编译需要 python + make + g++
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷依赖清单（利用 Docker 层缓存）
COPY package.json package-lock.json* ./

# 安装全部依赖（含 devDependencies，用于 tsc 编译）
RUN npm ci

# 拷源码并编译
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN npm run build

# 剪枝掉 devDependencies，只留生产依赖
RUN npm prune --omit=dev

# ---- 阶段 2：运行时 ----
FROM node:22-slim AS runtime

# 运行时 better-sqlite3 的 .node 二进制已在 build 阶段编译好，
# 只需要运行时动态库（sqlite3 通常已随系统，slim 镜像也有）。
WORKDIR /app

# 从 build 阶段拷贝：编译产物 + 生产依赖
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# 数据目录（registry.db / services.yaml / policy.json 挂载点）
RUN mkdir -p /app/data
VOLUME /app/data

# MCP HTTP 端口
EXPOSE 3001

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用编译后的 JS 启动（不用 tsx，更轻量）
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
