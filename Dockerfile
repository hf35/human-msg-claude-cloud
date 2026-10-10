# Server image: api, bot, worker and delivery in one process (docs/ARCHITECTURE.md, section 17).
# The workspace packages export TypeScript sources, so the server runs through tsx, as in development.
#
#   docker build -t human-msg-server .
#   docker run --env-file .env human-msg-server                                   # the server
#   docker run --env-file .env human-msg-server packages/db/node_modules/.bin/tsx packages/db/src/migrate-cli.ts   # migrations

# Override to pull the base image from a mirror: --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine
ARG NODE_IMAGE=node:22-alpine

# --- deps: installs only what the server needs, from manifests alone so the layer is cached ---
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
# The server and its workspace dependencies only; the frontends and test tooling stay out
RUN pnpm install --frozen-lockfile --filter "@human-msg/server..."

# --- runtime ---
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=deps /app/ ./
COPY tsconfig.base.json ./
COPY apps/server/ apps/server/
COPY packages/core/ packages/core/
COPY packages/db/ packages/db/
COPY packages/shared/ packages/shared/
# pnpm is not needed at runtime (and must not download itself on start): tsx is called directly
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["apps/server/node_modules/.bin/tsx", "apps/server/src/main.ts"]
