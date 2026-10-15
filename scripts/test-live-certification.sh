#!/usr/bin/env bash
# LIVE certification (separate from the hermetic `npm test`): runs every test that talks to a real provider and FAILS if any of them was skipped because it could not reach the network.
# `npm test` is allowed to be green offline (those tests skip with an explicit reason); this is the path that proves they actually ran against live Sleeper.
#   usage: bash scripts/test-live-certification.sh        exit 0 = ran live, nothing skipped for being offline; 1 = failure; 3 = no network
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
curl -fsS -m 8 https://api.sleeper.app/v1/state/nfl >/dev/null 2>&1 || { echo "NO NETWORK: cannot certify live behavior" >&2; exit 3; }
FILES=$(grep -lE "api\.sleeper\.app|online|isOnline" test/*.test.ts | sort -u)
OUT="$(mktemp)"; node --import tsx --test $FILES > "$OUT" 2>&1; rc=$?
grep -E "^# (tests|pass|fail|skipped)" "$OUT"
OFFLINE_SKIPS=$(grep -cE "# SKIP .*(offline|Offline)" "$OUT" || true)
echo "skipped for being offline: ${OFFLINE_SKIPS}"; grep -E "# SKIP" "$OUT" | sed 's/^ */  /' | sort | uniq -c | head
[ "$rc" -eq 0 ] || { echo "LIVE FAILURES:"; grep -E "^\s*not ok" "$OUT" | head -20; rm -f "$OUT"; exit 1; }
[ "${OFFLINE_SKIPS}" -eq 0 ] || { echo "FAIL: ${OFFLINE_SKIPS} live test(s) skipped as offline" >&2; rm -f "$OUT"; exit 1; }
rm -f "$OUT"; echo "LIVE CERTIFICATION PASSED"
