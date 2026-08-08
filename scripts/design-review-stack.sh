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

if [ "$1" = "--stop" ]; then
  pkill -f 'serve -s build -l 3009' 2>/dev/null || true
  pkill -f 'node dist/main' 2>/dev/null || true
  $COMPOSE down
  echo "stopped"
  exit 0
fi

$COMPOSE up -d
cd "$ROOT/video-sync-backend"
DATABASE_URL="$DB" npx prisma migrate deploy >/dev/null
npm run build >/dev/null
DATABASE_URL="$DB" JWT_SECRET='design-review-secret' \
  FRONTEND_URL='http://localhost:3009' PORT=3000 node dist/main &
BACKEND=$!

cd "$ROOT/video-sync-frontend"
# CRA bakes these in at build time, so the build must know the API is local
REACT_APP_API_URL=http://localhost:3000/api \
  REACT_APP_WS_URL=ws://localhost:3000 CI=true npm run build >/dev/null
npx serve -s build -l 3009 &
FRONTEND=$!

trap 'kill $BACKEND $FRONTEND 2>/dev/null' INT TERM
echo
echo "  UI       http://localhost:3009"
echo "  API      http://localhost:3000/health"
echo "  register a user in the UI, or POST /api/auth/register"
echo
wait
