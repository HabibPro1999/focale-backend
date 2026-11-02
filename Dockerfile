# Multi-stage build for the pnpm workspace.
# One image runs api (default), worker, or both with APP=all (start-runtime.mjs).
#
#   docker build -t focale-api .
#   docker build --build-arg APP=worker -t focale-worker .
#
# Or one image, pick at run time:
#   docker run -e APP=worker focale

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
# Process-local time is UTC; timestamps never depend on the host zone (plan 6.10).
ENV TZ=UTC
ARG APP=api
ENV APP=${APP}
# Copy the pruned workspace (dist/, prod node_modules, workspace symlinks).
COPY --from=build /app ./
# node:24-alpine ships a non-root `node` user.
USER node
EXPOSE 3000

# APP=api/all: GET /health/live (liveness, no DB). APP=worker: the worker
# heartbeat file (touched every 15 s, also while RUN_WORKERS=false) is < 60 s old.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

# SIGTERM → start-runtime.mjs forwards it; children drain within
# SHUTDOWN_GRACE_MS (default 25 s) and are SIGKILLed 3 s later.
STOPSIGNAL SIGTERM
# Default: api. Build with --build-arg APP=worker for a worker image.
CMD ["node", "start-runtime.mjs"]
