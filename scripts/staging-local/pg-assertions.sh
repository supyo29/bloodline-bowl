#!/usr/bin/env bash
set -uo pipefail
DB=supabase_db_bloodline-wave1-w2-local-staging
psqlc() { docker exec -i $DB psql -U postgres -q "$@"; }
psqlc -c "drop database if exists w1r1" -c "create database w1r1" >/dev/null
n=0
for f in $(ls supabase/migrations/*.sql | sort); do
  v=$(basename $f | cut -c1-14); [ "$v" -gt 20261009120000 ] && continue
  psqlc -d w1r1 -v ON_ERROR_STOP=1 < $f >/dev/null || { echo "MIGRATION FAILED: $f"; exit 1; }; n=$((n+1))
done
echo "applied $n migrations (Wave 1 -> W2.P1 chain) to a fresh database"
for f in supabase/migrations/20261008120000_projection_freshness_w1p4.sql supabase/migrations/20261009120000_w1r1_final_pregame_revisions.sql; do
  psqlc -d w1r1 -v ON_ERROR_STOP=1 < $f >/dev/null || { echo "NOT IDEMPOTENT: $f"; exit 1; }
done
echo "re-applied W1.P4 + W1.R1 migrations (idempotent)"
node --import tsx scripts/w1r1-pg-compat/fixtures.ts > /tmp/fixtures.psql
cat /tmp/fixtures.psql scripts/w1r1-pg-compat/assertions.sql | psqlc -d w1r1 -v ON_ERROR_STOP=1 -A -t
rc=$?; echo "assertions exit code: $rc"
psqlc -c "drop database w1r1" >/dev/null
exit $rc
