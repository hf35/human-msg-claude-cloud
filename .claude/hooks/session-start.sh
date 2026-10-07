#!/bin/bash
# SessionStart hook for Claude Code cloud sessions.
# Installs workspace dependencies and starts the development PostgreSQL so that
# typecheck, lint and tests work right away. Safe to run repeatedly.
set -euo pipefail

# Only needed in Claude Code cloud sessions
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

echo "[session-start] installing dependencies"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable pnpm
fi
# Not --frozen-lockfile: the container state is cached, so an incremental install is cheaper
pnpm install

# The database is best-effort: a Docker problem must not block the session
start_postgres() {
  command -v docker >/dev/null 2>&1 || { echo "[session-start] docker not found, skipping PostgreSQL"; return 1; }

  if ! docker info >/dev/null 2>&1; then
    echo "[session-start] starting the Docker daemon"
    # Fully detached, otherwise the hook would wait for the daemon to exit
    setsid nohup dockerd >/tmp/dockerd.log 2>&1 </dev/null &
    for _ in $(seq 1 30); do
      docker info >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  docker info >/dev/null 2>&1 || { echo "[session-start] Docker daemon is not available"; return 1; }

  echo "[session-start] starting PostgreSQL"
  timeout 240 docker compose up -d --wait postgres
}

start_postgres || echo "[session-start] warning: PostgreSQL was not started (see messages above)"

echo "[session-start] done"
