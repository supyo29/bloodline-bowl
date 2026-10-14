#!/usr/bin/env python3
"""Test-failure-audit mutation suite: proves the REPAIRED tests can still fail. One mutation at a time; KILLED when a test that is green on the unmutated tree fails; files restored byte-for-byte.
Do NOT edit files while it runs.   usage: python3 scripts/test-audit/mutation-suite.py [A1 A2 ...]"""
import hashlib, subprocess, sys, json
TESTS = ["test/role-calibration.test.ts", "test/game-distribution.test.ts", "test/scoring-return-invariant.test.ts", "test/scoring-contract.test.ts", "test/scoring-contract-adversarial.test.ts", "test/weekly-hardening.test.ts",
         "test/bridge-refresh.test.ts", "test/bridge-capabilities.test.ts", "test/yahoo-live-production-regression.test.ts", "test/analysis-book-planner.test.ts", "test/analysis-book-synthesis.test.ts",
         "test/book-ready-evidence.test.ts", "test/book-ready-history-store.test.ts", "test/player-scheme-certification.test.ts", "test/player-scheme-tierb.test.ts", "test/draft-predraft.test.ts",
         "test/league-manager-routing-live.test.ts", "test/foundation-live.test.ts", "test/discovery-route-coverage.test.ts", "test/waiver2-integration.test.ts", "test/publication-audit-order.test.ts"]
MUT = [
 ("A1", "role forecasts accept same-week outcomes (point-in-time leak) — the injected-poison tests must catch it", "lib/role-calibration/volume.ts", [("r.season === season && r.week < week)", "r.season === season && r.week <= week)")]),
 ("A2", "the projection-feed cache reset is a no-op — the repaired scoring tests depend on it", "lib/sleeper/client.ts", [("  projectionFeedCache.clear();\n  inFlightProjectionFeedFetches.clear();\n}\n\n/** Small, payload-free", "  /* mutated: no-op */\n}\n\n/** Small, payload-free")]),
 ("A3", "the empty in-season roster gate is removed — the production-regression coverage that replaced the old fixtures must still catch it", "lib/canonical/capabilities.ts", [('    snap.league.status === "in_season" &&\n    snap.teams.length > 0 &&', '    (snap.league.status as string) === "__never__" &&\n    snap.teams.length > 0 &&')]),
 ("A4", "the planner stops reporting SOURCE_LAG (a lagging surface looks current)", "lib/analysis-book/capability.ts", [('    if (v.lag_weeks && v.lag_weeks > 0) { flags.push("SOURCE_LAG");', '    if (false as boolean) { flags.push("SOURCE_LAG");')]),
 ("A9", "the planner's lag condition is inverted (lag > 0 no longer lags; negative lag does)", "lib/analysis-book/capability.ts", [('if (v.lag_weeks && v.lag_weeks > 0) { flags.push("SOURCE_LAG");', 'if (v.lag_weeks && v.lag_weeks < 0) { flags.push("SOURCE_LAG");')]),
 ("A5", "a certification report no longer matches the committed served data (hash drift)", "lib/player-scheme-intelligence/certification/tierB_reconciliation.json", [('"served_content_sha256": "5a10eac5', '"served_content_sha256": "6a10eac5')]),
 ("A6", "pre-draft: the bundle counts a phantom acquired player for every team", "lib/sleeper/draft.ts", [("          players_acquired: owned.length,", "          players_acquired: owned.length + 1,")]),
 ("A7", "Sleeper-native URLs are advertised for a Yahoo league again", "app/api/leagues/route.ts", [("sleeper_only_urls: isSleeper\n", "sleeper_only_urls: true\n")]),
 ("A10", "publication-audit latest() loses its tie-break (returns the oldest of tied attempts)", "lib/persistence/memory.ts", [(" || b.seq - a.seq)", ")")]),
 ("A8", "the Yahoo transactions route fabricates an empty success instead of refusing", "app/api/transactions/[league]/route.ts", [('    return errorResponse(502, live.warnings[0]?.code ?? "provider_error", live.warnings[0]?.message);', '    return new Response(JSON.stringify({ transactions: [], source: "ledger", status: "OK" }), { status: 200 });')]),
]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
def run():
    r = subprocess.run(["node", "--import", "tsx", "--test", *TESTS], capture_output=True, text=True)
    return sorted({l.strip()[7:] for l in r.stdout.splitlines() if l.strip().startswith("not ok")})
def main():
    only = set(sys.argv[1:]); files = {m[2] for m in MUT}; before = {f: sha(f) for f in files}
    base = set(run()); print(json.dumps({"baseline_failing": len(base), "names": sorted(base)[:5]}), flush=True); res = []
    for mid, desc, path, edits in MUT:
        if only and mid not in only: continue
        orig = open(path).read(); new = orig
        for a, b in edits:
            c = new.count(a)
            if c < 1: print(json.dumps({"id": mid, "error": f"anchor matched {c}x", "anchor": a[:70]}), flush=True); new = None; break
            new = new.replace(a, b, 1)
        if new is None: res.append((mid, "ANCHOR_ERROR")); continue
        open(path, "w").write(new)
        try: n2 = run()
        finally: open(path, "w").write(orig)
        fresh = [x for x in n2 if x not in base]
        res.append((mid, "KILLED" if fresh else "SURVIVED"))
        print(json.dumps({"id": mid, "mutation": desc, "status": res[-1][1], "newly_failing": len(fresh), "killed_by": [x[:100] for x in fresh[:2]]}), flush=True)
    print(json.dumps({"restored_byte_for_byte": before == {f: sha(f) for f in files}, "killed": sum(1 for _, s in res if s == "KILLED"), "total": len(res), "not_killed": [m for m, s in res if s != "KILLED"]}))
main()
