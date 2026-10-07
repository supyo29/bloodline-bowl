#!/usr/bin/env bash
# W1.R1: validate the W1.P4 + W1.R1 migrations and the TypeScript store assumptions against a REAL PostgreSQL, in a throwaway local cluster.
# Never touches any remote database. Skips (exit 0, says so) when no local PostgreSQL server binaries exist. Run from the repo root (as root: uses a temp user).
set -euo pipefail
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)}
if [ -z "${PGBIN:-}" ] || [ ! -x "$PGBIN/initdb" ]; then echo "SKIPPED: no local PostgreSQL server binaries (set PGBIN)"; exit 0; fi
D=$(mktemp -d /tmp/pgcompat.XXXXXX); PORT=${PGPORT:-54331}; RUN="env"
if [ "$(id -u)" = "0" ]; then id pgtest >/dev/null 2>&1 || useradd -m -s /bin/bash pgtest; chown pgtest "$D"; RUN="su pgtest -c"; fi
run() { if [ "$(id -u)" = "0" ]; then su pgtest -c "$1"; else bash -c "$1"; fi; }
cleanup() { run "$PGBIN/pg_ctl -D $D/data stop -m immediate >/dev/null 2>&1 || true"; rm -rf "$D"; }
trap cleanup EXIT
run "$PGBIN/initdb -D $D/data -A trust -U postgres >/dev/null && $PGBIN/pg_ctl -D $D/data -o '-p $PORT -k $D -c listen_addresses=' -l $D/pg.log start >/dev/null"
sleep 2
P="psql -h $D -p $PORT -U postgres -q"
$P -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" >/dev/null
$P -c "create database w1r1" >/dev/null
for f in $(ls supabase/migrations/*.sql | sort); do $P -d w1r1 -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; exit 1; }; done
echo "applied $(ls supabase/migrations/*.sql | wc -l) migrations"
# idempotent re-apply of the two W1 migrations
for f in supabase/migrations/20261008120000_projection_freshness_w1p4.sql supabase/migrations/20261009120000_w1r1_final_pregame_revisions.sql; do $P -d w1r1 -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "NOT IDEMPOTENT: $f"; exit 1; }; done
echo "re-applied W1.P4 + W1.R1 migrations (idempotent)"
node --import tsx scripts/w1r1-pg-compat/fixtures.ts > "$D/fixtures.psql"
cat "$D/fixtures.psql" scripts/w1r1-pg-compat/assertions.sql | $P -d w1r1 -v ON_ERROR_STOP=1 -A -t
