FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.34.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
COPY scripts/check-tokens.ts ./scripts/check-tokens.ts
RUN pnpm run build:web

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/tsconfig.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/web/dist ./web/dist
ENV NODE_ENV=production \
    AEVAL_HOST=0.0.0.0 \
    AEVAL_PORT=3000 \
    AEVAL_DATA_DIR=/tmp/daoeval \
    AEVAL_BROWSER_PATH=/usr/bin/chromium \
    AEVAL_BROWSER_NO_SANDBOX=1 \
    XDG_CONFIG_HOME=/tmp/chromium-config \
    XDG_CACHE_HOME=/tmp/chromium-cache
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "src/server/index.ts"]
