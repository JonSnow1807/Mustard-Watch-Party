# Development

## Prerequisites

Node ≥ 20, Docker Desktop (Postgres/Redis/labs), Chrome (measurement runs).

## Run the app locally

```bash
# 1. infrastructure (postgres on :5433 + impairment lab)
docker compose -f sync-harness/lab/docker-compose.harness.yml up -d

# 2. backend
cd video-sync-backend
npm ci
DATABASE_URL='postgresql://videouser:videopass@localhost:5433/videosync' npx prisma migrate deploy
DATABASE_URL='postgresql://videouser:videopass@localhost:5433/videosync' npm run start:dev

# 3. frontend (second terminal)
cd video-sync-frontend
npm ci
npm start          # http://localhost:3001
```

Optional: set `REDIS_URL=redis://localhost:6380` on the backend to run the
production coordination plane (Lua store + pub/sub adapter) locally.

## Multi-instance lab

```bash
docker compose -f docker-compose.lab.yml up -d --build
# nginx least_conn on :3300, direct instances on :3301..3303
cd sync-harness && npx tsx src/verify-m6.ts   # the multi-instance proofs
```

## Tests and gates

```bash
cd video-sync-backend && npm test             # unit incl. shared sync-core
cd video-sync-frontend && npm test            # smoke
cd sync-harness && npm run bots -- --n 10 --duration 120 --gate   # protocol gate
node scripts/sync-shared.mjs --check          # shared copies in sync
```

## Measurement runs

See [`sync-harness/README.md`](../sync-harness/README.md) for the browser
scenario matrix, impairment lab, and sweep instructions. Published numbers
live under [`docs/measurements/`](measurements/) with SHA + hardware
provenance per run.

## Shared sync core

`/shared` is the canonical source for the protocol, clock estimator, drift
controller and timeline math — one implementation consumed by the browser,
the bot fleet, and jest. CRA cannot import outside `src/`, so
`node scripts/sync-shared.mjs` mirrors it into both packages; CI fails if
the copies drift. Edit `/shared`, never the copies.

## Notes

- Frontend stays on TS 4.9: react-scripts 5 peer-depends on TS ≤4; shared
  code is written to the 4.9-compatible subset. A CRA→Vite migration is
  deliberately out of scope.
- The frontend `.env` is gitignored; copy `.env.example`.
