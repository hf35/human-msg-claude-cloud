# Server image: api, bot, worker and delivery in one process (docs/ARCHITECTURE.md, section 17).
# The workspace packages export TypeScript sources, so the server runs through tsx, as in development.
#
#   docker build -t human-msg-server .
#   docker run --env-file .env human-msg-server                                   # the server
#   docker run --env-file .env human-msg-server pnpm --filter @human-msg/db db:migrate   # migrations

ARG NODE_VERSION=22

# --- deps: installs only what the server needs, from manifests alone so the layer is cached ---
FROM node:${NODE_VERSION}-alpine AS deps
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
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=deps /app/ ./
COPY tsconfig.base.json ./
COPY apps/server/ apps/server/
COPY packages/core/ packages/core/
COPY packages/db/ packages/db/
COPY packages/shared/ packages/shared/
# Drop the unprivileged user into the app tree; nothing is written at runtime
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["pnpm", "--filter", "@human-msg/server", "start"]
