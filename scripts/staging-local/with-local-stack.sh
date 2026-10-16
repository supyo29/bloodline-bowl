#!/usr/bin/env bash
# Runs ONE command with the LOCAL Docker Supabase stack's env exported (keys read at runtime from the local Kong container; never committed).
# Same safety refusals as run-all.sh. usage: bash scripts/staging-local/with-local-stack.sh [--reset] -- <command...>
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PROD_REF="ijpfjdzmaztofawhwepf"
die() { echo "REFUSING TO RUN: $1" >&2; exit 99; }
[ -f supabase/.temp/project-ref ] && die "this checkout is LINKED to a remote project"
grep -q "$PROD_REF" supabase/config.toml && die "supabase/config.toml still names the production project"
if env | grep -qiE '^(SUPABASE_(URL|SERVICE_ROLE_KEY|PROJECT_REF|ACCESS_TOKEN|DB_PASSWORD)|DATABASE_URL|POSTGRES_URL|POSTGRES_PRISMA_URL)='; then die "a Supabase/Postgres credential is already in the environment"; fi
env | grep -q "$PROD_REF" && die "the production project ref appears in the environment"
docker info >/dev/null 2>&1 || die "docker is not running"
RESET=0; [ "${1:-}" = "--reset" ] && { RESET=1; shift; }
[ "${1:-}" = "--" ] && shift
PID=$(grep -E '^project_id' supabase/config.toml | sed -E 's/.*"(.*)".*/\1/')
supabase start -x gotrue,realtime,storage-api,imgproxy,mailpit,studio,edge-runtime,logflare,vector,supavisor,postgres-meta >/dev/null
[ "$RESET" = 1 ] && supabase db reset --local >/dev/null 2>&1
KONG="supabase_kong_${PID}"
export SUPABASE_SERVICE_ROLE_KEY=$(docker exec "$KONG" sh -c "grep -o 'sb_secret_[A-Za-z0-9_-]*' /home/kong/kong.yml | head -1")
export LOCAL_ANON_KEY=$(docker exec "$KONG" sh -c "grep -o 'sb_publishable_[A-Za-z0-9_-]*' /home/kong/kong.yml | head -1")
[ -n "$SUPABASE_SERVICE_ROLE_KEY" ] || die "could not read the local demo keys"
export SUPABASE_URL="http://127.0.0.1:54321" LOCAL_DB_CONTAINER="supabase_db_${PID}" CRON_SECRET="local-staging-cron-secret"
exec "$@"
