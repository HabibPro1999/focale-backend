FROM oven/bun:1-alpine AS base
WORKDIR /app

# --- Build: all deps + prisma generate ---
FROM base AS build
COPY package.json bun.lock ./
COPY prisma ./prisma/
RUN bun install --frozen-lockfile && \
    bun x prisma generate

# --- Prod deps only (no devDependencies) ---
FROM base AS prod-deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- Production image ---
FROM base AS release

# Prod node_modules (lean, no devDeps)
COPY --from=prod-deps /app/node_modules ./node_modules

# Prisma runtime: @prisma/client/runtime/ has the WASM query compiler
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Generated Prisma TypeScript client (custom output path)
COPY --from=build /app/src/generated ./src/generated

# Source + config (ordered by change frequency — least to most)
COPY tsconfig.json ./
COPY src ./src

USER bun

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
