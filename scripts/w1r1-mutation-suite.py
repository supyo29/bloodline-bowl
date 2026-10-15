#!/usr/bin/env python3
"""W1.R1 mutation suite (M1-M10 + M4b). One source mutation at a time; KILLED when any test fails; files restored byte-for-byte (hash-verified).
Usage: python3 scripts/w1r1-mutation-suite.py [M1 M5 ...]"""
import hashlib, subprocess, sys, json, glob

PATS = ["api-lineup-parity", "postgrest-schema-compat", "team-defense-identity", "feed-absent-bye", "forward-row-normalization", "final-pregame-calibration-grade",
        "final-pregame", "projection-observation-supabase", "wave1-ratchets", "bye-asset-preservation", "injury-decisions", "calibration-ledger",
        "canonical-weekly-forecast", "canonical-weekly-forecast-architecture", "freshness-architecture", "freshness-policy", "multi-league-freshness",
        "projection-freshness-lifecycle", "roster-health", "schedule-planning", "trade-engine-phase2-audit"]
TESTS = [f"test/{p}.test.ts" for p in PATS]
ROUTE = "app/api/lineup/[league]/[manager]/week/[week]/route.ts"
MUT = [
 ("M1", "break structured PostgREST missing-column detection", "lib/persistence/supabase/rest.ts",
  [('if (e.code === "42703" || e.code === "PGRST204") return "MISSING_COLUMN";', 'if (false) return "MISSING_COLUMN";')]),
 ("M2", "/api/lineup builds its own source-basis lineup (no canonical forecasts)", ROUTE,
  [('import { runWithWeeklyContext, lineupEndpointView } from "@/lib/weekly/intelligence";', 'import { runWithWeeklyContext } from "@/lib/weekly/intelligence";\nimport { buildOptimalLineup } from "@/lib/weekly/lineup";'),
   ('runWithWeeklyContext(league, manager, { week: parsed.week }, lineupEndpointView);', 'runWithWeeklyContext(league, manager, { week: parsed.week }, (ctx) => ({ lineup: buildOptimalLineup({ week: ctx.league.week, roster: ctx.roster, constraints: ctx.league.roster_constraints, players: new Map(ctx.all_rostered.map((p) => [p.canonical_player_id, p])), projections: ctx.projections }), start_sit: [], roster_constraints: ctx.league.roster_constraints, forecast_set_identity: null }));')]),
 ("M3", "Yahoo DST mapped to a provider-specific player id", "lib/canonical/players.ts",
  [("            teamDefenseId(t.team),\n", "            `player:${observed.provider}:${observed.provider_player_id}`,\n")]),
 ("M4", "restore the legacy cheap-drop fallback for an unknown-value bye player", "lib/weekly/waivers.ts",
  [("if (isVerifiedBye(p)) return holdFor(id).points != null;", "if (isVerifiedBye(p)) return true;")]),
 ("M4b", "feed-absent bye row built without its ROS evidence (the audited cause)", "lib/weekly/context.ts",
  [("const holdRos = projected?.rest_of_season_points ?? riRos;", "const holdRos = projected?.rest_of_season_points ?? null;")]),
 ("M5", "stale is_bye carried into a forward/ROS row", "lib/weekly/forecast/bye.ts",
  [("    is_bye: false,\n    opponent: null,", "    is_bye: src.is_bye,\n    opponent: null,")]),
 ("M6", "contribution ledger dropped from the final-pregame record", "lib/weekly/freshness/final-pregame.ts",
  [("forecast_snapshot: structuredClone(f),", "forecast_snapshot: { ...structuredClone(f), contributions: [] },")]),
 ("M7", "a post-kickoff composition may rewrite the frozen forecast", "lib/weekly/freshness/final-pregame.ts",
  [('if (c >= k || o > k) return "REJECTED_POST_KICKOFF";', 'if (o > k) return "REJECTED_POST_KICKOFF";')]),
 ("M8", "calibrate against the SOURCE projection instead of the final canonical expected value", "lib/calibration/final-pregame-evidence.ts",
  [("    projected_points: r.expected_points,", "    projected_points: r.source_points,")]),
 ("M9", "a Sleeper id becomes a required calibration identity", "lib/calibration/final-pregame-evidence.ts",
  [("if (!f || r.expected_points == null || !r.scoring_fingerprint) return null;", "if (!f || r.expected_points == null || !r.scoring_fingerprint || !r.identifiers.sleeper_id) return null;")]),
 ("M10", "the two lineup endpoints consume different forecast-set identities", "lib/weekly/intelligence.ts",
  [("forecast_set_identity: ctx.forecasts?.identity?.identity_id ?? null }", "forecast_set_identity: null }")]),
]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
def run():
    r = subprocess.run(["node", "--experimental-test-module-mocks", "--import", "tsx", "--test", *TESTS], capture_output=True, text=True)
    out = r.stdout
    g = lambda k: int(next((l.split()[-1] for l in out.splitlines() if l.startswith(f"# {k} ")), "0"))
    names = sorted({l.strip()[7:] for l in out.splitlines() if l.strip().startswith("not ok")})
    return g("tests"), g("fail"), names
def main():
    only = set(sys.argv[1:]); files = {m[2] for m in MUT}; before = {f: sha(f) for f in files}
    t, f, n = run(); print(json.dumps({"baseline": {"tests": t, "fail": f, "files": len(TESTS)}}), flush=True)
    base = set(n)
    res = []
    for mid, desc, path, edits in MUT:
        if only and mid not in only: continue
        orig = open(path).read(); new = orig
        for a, b in edits:
            c = new.count(a)
            if c != 1: print(json.dumps({"id": mid, "error": f"anchor matched {c}x", "anchor": a[:60]}), flush=True); new = None; break
            new = new.replace(a, b)
        if new is None: continue
        open(path, "w").write(new)
        try: t2, f2, n2 = run()
        finally: open(path, "w").write(orig)
        fresh = [x for x in n2 if x not in base]
        res.append((mid, "KILLED" if fresh else "SURVIVED"))
        print(json.dumps({"id": mid, "mutation": desc, "status": res[-1][1], "newly_failing": len(fresh), "killed_by": [x[:110] for x in fresh[:3]]}), flush=True)
    print(json.dumps({"restored_byte_for_byte": before == {f: sha(f) for f in files}, "killed": sum(1 for _, s in res if s == "KILLED"), "total": len(res), "survived": [m for m, s in res if s == "SURVIVED"]}))
main()
