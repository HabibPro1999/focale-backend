FROM oven/bun:1-alpine AS base
WORKDIR /app

# --- Dependencies (cached until package.json/bun.lock change) ---
FROM base AS deps
COPY package.json bun.lock ./
# Install prod deps into a temp dir so we get a clean copy later
RUN mkdir -p /temp/prod && \
    cp package.json bun.lock /temp/prod/ && \
    cd /temp/prod && \
    bun install --frozen-lockfile --production

# --- Prisma generate (cached until prisma schema changes) ---
FROM deps AS generate
# prisma CLI is a devDependency — install it separately, then generate
COPY prisma ./prisma/
RUN bun add --dev prisma && \
    bun x prisma generate && \
    bun remove prisma && \
    rm -rf /app/node_modules/.cache

# --- Production image ---
FROM base AS release

# Prod node_modules (no devDeps)
COPY --from=deps /temp/prod/node_modules ./node_modules

# Generated Prisma client + runtime (prisma generate writes CockroachDB
# query-compiler into @prisma/client/runtime/, which the deps stage lacks)
COPY --from=generate /app/src/generated ./src/generated
COPY --from=generate /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Source + config
COPY tsconfig.json ./
COPY src ./src

# Non-root
USER bun

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
