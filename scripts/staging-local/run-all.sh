#!/usr/bin/env bash
# LOCAL-ONLY staging validation of the Wave 1 -> W2.P1 -> W2.P2 stack on a Docker Supabase stack (Postgres 17 + Kong + PostgREST).
# Never links, pushes or migrates a hosted project. Free: no paid Supabase branch, no hosted staging project.
#
#   prerequisites: Docker (colima ok), Supabase CLI, `npm ci`, `npx next build`
#   usage:         bash scripts/staging-local/run-all.sh
#
# BEFORE running: replace supabase/config.toml's project_id (it names the PRODUCTION ref) with a temporary UNCOMMITTED local value, e.g.
#   sed -i '' 's/^project_id = .*/project_id = "bloodline-wave1-w2-local-staging"/' supabase/config.toml
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# ---------------------------------------------------------------- safety: stop immediately on anything that could reach a remote project
PROD_REF="ijpfjdzmaztofawhwepf"
die() { echo "REFUSING TO RUN: $1" >&2; exit 99; }
[ -f supabase/.temp/project-ref ] && die "supabase/.temp/project-ref exists: this checkout is LINKED to a remote project"
grep -q "$PROD_REF" supabase/config.toml && die "supabase/config.toml still names the production project ($PROD_REF)"
if env | grep -qiE '^(SUPABASE_(URL|SERVICE_ROLE_KEY|PROJECT_REF|ACCESS_TOKEN|DB_PASSWORD)|DATABASE_URL|POSTGRES_URL|POSTGRES_PRISMA_URL)='; then die "a Supabase/Postgres credential is already in the environment"; fi
if env | grep -q "$PROD_REF"; then die "the production project ref appears in the environment"; fi
docker info >/dev/null 2>&1 || die "docker is not running"
PID=$(grep -E '^project_id' supabase/config.toml | sed -E 's/.*"(.*)".*/\1/')
echo "local project id: $PID  (no remote link, no credentials in env)"

# ---------------------------------------------------------------- local stack (only db + kong + postgrest: the real HTTP path)
supabase start -x gotrue,realtime,storage-api,imgproxy,mailpit,studio,edge-runtime,logflare,vector,supavisor,postgres-meta >/dev/null
# The local-demo API keys are read at RUNTIME from this checkout's own LOCAL Kong container (never committed: GitHub push protection rightly refuses
# anything shaped like a Supabase secret key, even the public demo one). They are valid only against the local JWT secret.
KONG="supabase_kong_${PID}"
SERVICE_KEY=$(docker exec "$KONG" sh -c "grep -o 'sb_secret_[A-Za-z0-9_-]*' /home/kong/kong.yml | head -1" 2>/dev/null || true)
ANON_KEY=$(docker exec "$KONG" sh -c "grep -o 'sb_publishable_[A-Za-z0-9_-]*' /home/kong/kong.yml | head -1" 2>/dev/null || true)
[ -n "$SERVICE_KEY" ] && [ -n "$ANON_KEY" ] || die "could not read the local demo keys from the local Kong container $KONG"
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY"
export LOCAL_ANON_KEY="$ANON_KEY"
export LOCAL_DB_CONTAINER="supabase_db_${PID}"
export CRON_SECRET="local-staging-cron-secret"
CHAIN=20261009120000   # last Wave 1 -> W2.P1 migration; the Role-shadow migration (W2.P2) is applied separately below
run() { echo; echo "=== $*"; "$@"; }

run supabase db reset --local --version $CHAIN
run bash scripts/staging-local/pg-assertions.sh                                  # the repo's own PostgreSQL assertions, on a throwaway database
run supabase db reset --local --version $CHAIN
run node --import tsx scripts/staging-local/stage1-chain.ts                      # schema/PostgREST/privileges + differential store tests
run supabase db reset --local --version $CHAIN
run node --import tsx scripts/staging-local/live1-pre-migration.ts              # real providers; capture-failure visibility (table missing)
run supabase migration up --local                                                # apply the Role-shadow migration (local only)
run supabase db reset --local                                                    # fresh database, full chain incl. W2.P2
run node --import tsx scripts/staging-local/stage2-roleshadow-http.ts          # Role-shadow HTTP/PostgREST assertions
run supabase db reset --local
run node --import tsx scripts/staging-local/live2-http-route.ts                  # real Next server + cron route + providers + PostgREST
run node --import tsx scripts/staging-local/live3-wave1-timing.ts                # kickoff behavior, Wave 1 post-kickoff gate, bye/injured spot checks
run node --import tsx scripts/staging-local/egress-audit.ts                      # every outbound request: methods and hosts
run node --import tsx scripts/role-shadow-g3.ts --out outputs/role-shadow-g3-local --no-log   # evaluator over the real local store
echo; echo "ALL LOCAL STAGING PHASES COMPLETED (evidence: docs/evidence/w2p2-local-staging-*.json)"
