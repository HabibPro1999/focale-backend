# Multi-stage build for the pnpm workspace (branch: nest-rebuild).
# One image runs EITHER app: default CMD = api; build --build-arg APP=worker
# (or override CMD at run) for the worker.
#
#   docker build -f Dockerfile.new -t focale-api .
#   docker build -f Dockerfile.new --build-arg APP=worker -t focale-worker .
#
# Or one image, pick at run time:
#   docker run focale node apps/worker/dist/main.js

FROM node:24-alpine AS base
WORKDIR /app
# libc6-compat: native deps (@swc/core, sharp, esbuild) expect glibc symbols on alpine.
RUN apk add --no-cache libc6-compat && corepack enable

# --- Build: install ALL deps, build every package, then prune to prod ---
FROM base AS build
# Manifests first (cache install layer across source-only changes).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile
# Source + build everything (tsc emits dist/ per package).
COPY . .
RUN pnpm -r build
# Drop devDependencies in place; workspace symlinks + built dist/ remain.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# --- Release: lean runtime image ---
FROM base AS release
ENV NODE_ENV=production
ARG APP=api
ENV APP=${APP}
# Copy the pruned workspace (dist/, prod node_modules, workspace symlinks).
COPY --from=build /app ./
# node:24-alpine ships a non-root `node` user.
USER node
EXPOSE 3000

# api parity with the legacy image. Worker images have no HTTP surface — run
# them with `docker run --health-cmd=none ...` or override at the platform.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default: api. Build with --build-arg APP=worker for a worker image.
CMD ["sh", "-c", "node apps/$APP/dist/main.js"]
