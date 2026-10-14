#!/bin/sh
# W2.R1 S8 weekly pregame freeze runbook (manual until a scheduled runner is authorized).  Usage: scripts/w2r1/prospective/run_week.sh <week> <firstKickoffISO>
# 1. refuses if the S7 freeze is not intact; 2. produces K/DST + upside rows from the FROZEN models (never refit on 2026 wk 1-5); 3. freezes with a manifest (refuses at/after kickoff);
# 4. appends the loader line to lib/w2r1/data/prospective/index.ts (by hand: see the comment there); 5. tests; commit + push is the external witness of the freeze time.
set -e
WEEK="$1"; KICKOFF="$2"; [ -n "$WEEK" ] && [ -n "$KICKOFF" ] || { echo "usage: $0 <week> <firstKickoffISO>"; exit 2; }
npx tsx scripts/w2r1/s7_verify_frozen.ts
Rscript scripts/w2r1/prospective/s8_pregame_kdst.R "$WEEK"
Rscript scripts/w2r1/prospective/s8_pregame_upside.R "$WEEK"
npx tsx scripts/w2r1/prospective/s8_freeze_week.ts "$WEEK" "$KICKOFF"
echo "NOW: add wk$(printf %02d "$WEEK") to lib/w2r1/data/prospective/index.ts, run: npx tsx --test test/w2r1-s8.test.ts, then git add/commit/push BEFORE kickoff."
