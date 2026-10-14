#!/usr/bin/env bash
# Player-Scheme RE-CERTIFICATION (separate from `npm test`): rebuild Tiers A-D with R in a SCRATCH copy and diff the certification reports and the served data against the tracked ones.
# Needs: Rscript with the packages in analysis/player_scheme_intelligence, and the nflverse/FTN inputs those builds read (network, or the raw cache: set PSI_RAW_CACHE=/path/to/analysis/football_intel/cache). It NEVER touches the working tree:
# the R builds write served data into lib/, so PSI_ROOT points at a scratch copy.
#   usage: bash scripts/player-scheme-recertify.sh            exit 0 = reproduced byte-identical (JSON-normalized), 1 = differs, 3 = prerequisites missing
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
command -v Rscript >/dev/null || { echo "PREREQ MISSING: Rscript not found" >&2; exit 3; }
S="$(mktemp -d)"; if [ -n "${PSI_KEEP:-}" ]; then echo "scratch kept at $S"; else trap 'rm -rf "$S"' EXIT; fi
mkdir -p "$S/lib/player-scheme-intelligence" "$S/outputs"
cp -R analysis "$S/analysis"; cp -R lib/player-scheme-intelligence/data "$S/lib/player-scheme-intelligence/data"
[ -n "${PSI_RAW_CACHE:-}" ] && { mkdir -p "$S/analysis/football_intel"; ln -s "$PSI_RAW_CACHE" "$S/analysis/football_intel/cache"; }
export PSI_ROOT="$S"
# The committed served data is the 2025-week-18 vintage (manifest: current_season 2025, as_of_week 18). A rebuild with no arguments builds whatever the raw cache holds TODAY (e.g. psi:2026:w04), a
# different vintage that can never match; so tiers A-C are pinned to the committed vintage (override with PSI_SEASON / PSI_WEEK).
SEASON="${PSI_SEASON:-2025}"; WEEK="${PSI_WEEK:-18}"
for t in source_audit build_tierA build_tierB build_tierC build_tierD; do
  case "$t" in build_tierA|build_tierC) a="$SEASON $WEEK";; build_tierB) a="$SEASON ${PSI_TIERB_WEEK:-22}";; *) a="";; esac   # Tier B was built through week 22 (FTN charting runs through the playoffs: manifest ftn_week 22, report "week": 22)
  echo "== Rscript analysis/player_scheme_intelligence/$t.R $a"; Rscript "$S/analysis/player_scheme_intelligence/$t.R" $a || { echo "PREREQ/BUILD FAILED at $t (inputs unavailable?)" >&2; exit 3; }
done
# What is compared (content-bearing parts only; each exclusion is a documented, time-varying input, not a certified number):
#   reports      every key EXCEPT generated_at / updated_at / built_at (volatile), source_audit.json is excluded (it records the CURRENT availability of live data, which grows weekly)
#   served data  every CSV EXCEPT player_directory.csv (team assignments come from the mutable ff_playerids cache); the manifest is compared without timestamps (and list-vs-scalar for single files)
rc=0
norm='import json,sys
VOL={"generated_at","updated_at","built_at"}
def n(x,k=None):
    if isinstance(x,dict): return {a:n(b,a) for a,b in sorted(x.items()) if a not in VOL}
    if isinstance(x,list): return [n(i) for i in x]
    return [x] if k=="files" and isinstance(x,str) else x
print(json.dumps(n(json.load(open(sys.argv[1]))),sort_keys=True))'
for f in lib/player-scheme-intelligence/certification/*.json; do
  b="$(basename "$f")"; [ "$b" = "source_audit.json" ] && continue; n="$S/outputs/player-scheme-intelligence-2026/$b"
  [ -f "$n" ] || { echo "MISSING rebuilt report: $b"; rc=1; continue; }
  diff -q <(python3 -c "$norm" "$f") <(python3 -c "$norm" "$n") >/dev/null || { echo "DIFFERS: report $b"; rc=1; }
done
for f in lib/player-scheme-intelligence/data/*.csv; do
  b="$(basename "$f")"; [ "$b" = "player_directory.csv" ] && continue
  cmp -s "$f" "$S/lib/player-scheme-intelligence/data/$b" || { echo "DIFFERS: served $b"; rc=1; }
done
diff -q <(python3 -c "$norm" lib/player-scheme-intelligence/data/player_scheme_manifest.json) <(python3 -c "$norm" "$S/lib/player-scheme-intelligence/data/player_scheme_manifest.json") >/dev/null || { echo "DIFFERS: served manifest (non-volatile fields)"; rc=1; }
[ $rc -eq 0 ] && echo "REPRODUCED: certified reports and served data identical (volatile/time-varying inputs excluded as documented)" || echo "NOT reproduced (see above)"; exit $rc
