#!/usr/bin/env python3
"""Join docs/test-audit/ledger-raw.json (82 failures at PR #44 head, with main / 86e8190 status) with the audit's root-cause classification -> FAILURE_LEDGER.{json,md}."""
import json, collections
led = json.load(open("docs/test-audit/ledger-raw.json")); iso = {(x["file"], x["name"]): x for x in json.load(open("docs/test-audit/isolation.json"))}
F = {  # family -> (category, first_bad, root_cause, resolution)
 "cache": ("TEST_BUG", "650dcb0 (2026-09-26) 'weekly: share oversized projection feed cache'",
   "The Sleeper projection-feed cache became process-global; tests that mock `fetch` per test never reset it, so the first test in a file poisoned every later one (order-dependent: green alone, red in the file).",
   "test files reset `clearProjectionFeedCache()` before each test. Product unchanged."),
 "te_id": ("TEST_BUG", "abe494f (2026-10-07) W1.R1 'team defense identity'",
   "Fixture used Sleeper player_id \"TE\"/\"WR\"; letters-only Sleeper ids are by contract TEAM-DEFENSE ids, so the TE never resolved as a player.", "fixture ids made numeric."),
 "bridge": ("ARCHITECTURE_CHANGED", "d8fa055 (2026-09-24) 'fail closed on empty in-season roster state'",
   "A deliberate production integrity gate (found on a real Rogers Park defect) rejects an in-season snapshot with no rostered players; the shared test fixture defaulted to empty in-season rosters and to rostered ids absent from `players`.",
   "fixture helper defaults to one rostered, resolved player per team; tests wanting empty rosters say so. Gate unchanged and separately covered by yahoo-live-production-regression."),
 "discovery": ("STALE_ASSERTION", "53c58d3 (2026-09-26) cron projection-snapshot route (+ the two Yahoo provider routes)",
   "Three routes exist, are classified in lib/public-api/policy.ts (cron = self-guarded prefix; Yahoo routes = public-read/expensive) but were never added to the discovery-coverage allowlist.", "allowlist entries with reasons (each proven against the policy table)."),
 "rolegame": ("STALE_SNAPSHOT_OR_HASH", "b0f89c7 / 9b4c730 (2026-10-01 / 10-05) bot 'role-calibration: refresh inputs'",
   "The weekly refresh workflow REPLACES the committed role profile file (now target weeks 5-6 only) while the tests hard-coded target week 3; their 'poison the outcomes' teeth also needed outcomes at/after the target week that the committed data does not have.",
   "tests target the latest week present; poisoned target-week outcomes are INJECTED (teeth verified by a same-week-leak mutation); the statistical reproducibility test reads a frozen, documented vintage fixture."),
 "capvintage": ("STALE_SNAPSHOT_OR_HASH", "55b581f (2026-09-22) bot 'football-intel: refresh 2026 week 2'",
   "Capability/vintage expectations were written against the committed manifests at one moment; football-intel / intelligence-history bots move them every few days.",
   "pure-planning tests read a frozen manifest vintage (+ the LIVE registry); tests that research live evidence derive expected vintage from the live manifests; history tests tolerate a growing store."),
 "foundation": ("ENVIRONMENT_DEPENDENT", "bc86821 (2026-09-24) 'allow canonical Yahoo live transaction reads'",
   "Outcome depends on the Yahoo OAuth environment of the machine running the test (unconfigured -> explicit yahoo_not_configured 502; configured-unconnected -> yahoo_auth_required).", "test controls the environment and pins BOTH honest refusals."),
 "league": ("ARCHITECTURE_CHANGED", "fed80bf (2026-09-24) 'stop routing Yahoo ids into Sleeper APIs'",
   "Intentional: Sleeper-native URLs moved to `sleeper_only_urls` (null for Yahoo). Covered by ai-discovery tests.", "assertion updated to the contract, plus the Yahoo-side safety property."),
 "weeklylive": ("TEST_BUG", "n/a (live data: NFL week-6 byes, 2026-10-08)",
   "`illegal_situations` is by design the legality of the CURRENT lineup (a reported fact); the test treated it as the recommended lineup's legality. Real managers whose only QBs/K are on bye correctly produce it.",
   "assert the real invariant (no bye starter recommended when a non-bye alternative exists) on live data; hermetic coverage already in weekly-lineup.test.ts."),
 "psi": ("ENVIRONMENT_DEPENDENT", "red since each test was added (read the gitignored outputs/ build directory)",
   "Tests read R build-certification reports from gitignored outputs/, so they passed only where the R build had been run.",
   "reports tracked under lib/player-scheme-intelligence/certification/ (checksummed, bound to the committed manifest by hash); `npm run test:recertify:player-scheme` is the separate rebuild path."),
}
def fam(f, n):
    if f in ("test/scoring-return-invariant.test.ts", "test/scoring-contract-adversarial.test.ts", "test/weekly-hardening.test.ts"): return "cache"
    if f == "test/scoring-contract.test.ts": return "te_id" if "same season line" in n else "cache"
    if f.startswith("test/bridge-") or f == "test/draft-sportys-alumni.test.ts": return "bridge"
    if f == "test/discovery-route-coverage.test.ts": return "discovery"
    if f in ("test/game-distribution.test.ts", "test/role-calibration.test.ts"): return "rolegame"
    if f.startswith("test/analysis-book-") or f in ("test/book-ready-evidence.test.ts", "test/book-ready-history-store.test.ts"): return "capvintage"
    if f == "test/foundation-live.test.ts": return "foundation"
    if f == "test/league-manager-routing-live.test.ts": return "league"
    if f == "test/weekly-intelligence-live.test.ts": return "weeklylive"
    if f.startswith("test/player-scheme-"): return "psi"
    raise SystemExit(f"unclassified {f} | {n}")
rows = []
for l in led:
    k = fam(l["file"], l["name"]); cat, fb, why, fix = F[k]; i = iso[(l["file"], l["name"])]
    rows.append({"test_file": l["file"], "test_name": l["name"], "family": k, "category": cat, "first_failing_commit": fb, "fails_on_main": l["on_main"] == "FAILS", "fails_on_86e8190": l["on_86e8190"] == "FAILS", "fails_on_pr44_head": True,
                 "fails_when_file_runs_alone": i["fails_when_file_runs_alone"], "passes_when_test_runs_alone": i["passes_when_test_runs_alone"], "error": l["error"][:400], "stack": "\n".join(l["stack"].split("\n")[:3]), "root_cause": why, "resolution": fix, "status_now": "PASS"})
json.dump(rows, open("docs/test-audit/FAILURE_LEDGER.json", "w"), indent=1)
cnt = collections.Counter(r["category"] for r in rows); fc = collections.Counter(r["family"] for r in rows)
md = ["# Failure ledger (82 failures at PR #44 head `af72022`)\n", "Generated by `scripts/test-audit/build-ledger.py` from `ledger-raw.json` (TAP of three full runs) and `isolation.json` (every failure run alone and file-alone). Per-test rows (error, stack, flags) are in `FAILURE_LEDGER.json`.\n",
      "| category | count |\n|---|---|"] + [f"| {c} | {n} |" for c, n in sorted(cnt.items(), key=lambda x: -x[1])] + [f"| **total** | **{sum(cnt.values())}** |", "", "| family | tests | category | first failing commit | root cause | resolution |", "|---|---|---|---|---|---|"]
for k, n in sorted(fc.items(), key=lambda x: -x[1]):
    cat, fb, why, fix = F[k]; files = sorted({r["test_file"].replace("test/", "") for r in rows if r["family"] == k})
    md.append(f"| {k} (`{'`, `'.join(files)}`) | {n} | {cat} | {fb} | {why} | {fix} |")
md += ["", "All 82 fail on `main` (966b51e), on `86e8190` and on the PR #44 head: none was introduced by Wave 1, W2 or Yahoo work (a 83rd, the `waiver2-integration` byte-identity pins, failed on `main`/`86e8190` and was re-baselined with a reviewed-change ledger in PR #44).", ""]
open("docs/test-audit/FAILURE_LEDGER.md", "w").write("\n".join(md))
print(cnt, sum(cnt.values()))
