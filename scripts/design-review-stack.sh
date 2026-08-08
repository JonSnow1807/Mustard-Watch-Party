#!/bin/sh
# Bring up a fully local stack to click through the UI: lab Postgres in
# Docker, the backend on :3000, and the production frontend build on
# :3009. Nothing here touches the deployed site or its database.
#
#   scripts/design-review-stack.sh          # start (rebuilds the frontend)
#   scripts/design-review-stack.sh --stop   # stop everything
#
# Ctrl-C stops the servers; the Docker containers keep running so a
# restart is fast (use --stop to take them down too).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
COMPOSE="docker compose -f $ROOT/sync-harness/lab/docker-compose.harness.yml"
DB='postgresql://videouser:videopass@localhost:5433/videosync'
# The PIDs we start, so --stop and the cleanup trap kill exactly those and
# never a pattern match against somebody else's node process.
PIDFILE="${TMPDIR:-/tmp}/mustard-design-review-stack.pids"

# Kill one recorded PID and whatever it spawned (npx runs the real server as
# a child). Children first: once the parent is gone they are reparented and
# no longer findable by parent PID.
stop_pid() {
  [ -n "$1" ] || return 0
  pkill -P "$1" 2>/dev/null || true
  kill "$1" 2>/dev/null || true
}

if [ "$1" = "--stop" ]; then
  # No PID file means nothing was started from here - stop nothing.
  if [ -f "$PIDFILE" ]; then
    while read -r pid; do
      stop_pid "$pid"
    done < "$PIDFILE"
    rm -f "$PIDFILE"
  fi
  $COMPOSE down
  echo "stopped"
  exit 0
fi

# Registered before anything is launched: a failure in the migrate, either
# build, or the frontend start must not leave the backend orphaned on :3000.
BACKEND=''
FRONTEND=''
cleanup() {
  stop_pid "$BACKEND"
  stop_pid "$FRONTEND"
  if [ -n "$BACKEND" ] || [ -n "$FRONTEND" ]; then
    rm -f "$PIDFILE"
  fi
}
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap cleanup EXIT

# A fresh signing key per run, so no secret is committed. Export JWT_SECRET
# before calling this if you want tokens to survive a restart.
if [ -z "${JWT_SECRET:-}" ]; then
  JWT_SECRET="$(openssl rand -hex 32 2>/dev/null || true)"
  if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET="$(dd if=/dev/urandom bs=32 count=1 2>/dev/null | od -An -v -tx1 | tr -d ' \n')"
  fi
fi

$COMPOSE up -d
cd "$ROOT/video-sync-backend"
DATABASE_URL="$DB" npx prisma migrate deploy >/dev/null
npm run build >/dev/null
DATABASE_URL="$DB" JWT_SECRET="$JWT_SECRET" \
  FRONTEND_URL='http://localhost:3009' PORT=3000 node dist/main &
BACKEND=$!
printf '%s\n' "$BACKEND" > "$PIDFILE"

cd "$ROOT/video-sync-frontend"
# CRA bakes these in at build time, so the build must know the API is local
REACT_APP_API_URL=http://localhost:3000/api \
  REACT_APP_WS_URL=ws://localhost:3000 CI=true npm run build >/dev/null
npx serve -s build -l 3009 &
FRONTEND=$!
printf '%s\n' "$FRONTEND" >> "$PIDFILE"

echo
echo "  UI       http://localhost:3009"
echo "  API      http://localhost:3000/health"
echo "  register a user in the UI, or POST /api/auth/register"
echo
wait
