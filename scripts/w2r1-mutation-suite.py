#!/usr/bin/env python3
"""W2.R1 mutation suite. One source mutation at a time; KILLED when a test that passes on the unmutated tree fails; files are restored byte-for-byte
(hash-checked). Do NOT edit files while this runs. Usage: python3 scripts/w2r1-mutation-suite.py [W1 W2 ...]"""
import hashlib, subprocess, sys, json
TESTS = ["test/w2r1-vor.test.ts", "test/w2r1-isolation.test.ts", "test/w2r1-adapter.test.ts"]
V, R, E, W = "lib/w2r1/vor.ts", "lib/w2r1/roster.ts", "lib/w2r1/evidence.ts", "lib/weekly/waivers.ts"
A, L, G = "lib/w2r1/adapter.ts", "lib/w2r1/live.ts", "lib/w2r1/guard.ts"
MUT = [
 ("W1", "bye zeroes Hold VOR", V, [('const hold = component(holdCalcs, weeks.length, "UNDERLYING_VALUE_OVER_HORIZON_REGARDLESS_OF_CURRENT_WEEK_STATUS");', 'const hold: VorComponent = focal.weeks[week]?.state === "BYE" ? { ...component(holdCalcs, weeks.length, "x"), value: 0 } : component(holdCalcs, weeks.length, "UNDERLYING_VALUE_OVER_HORIZON_REGARDLESS_OF_CURRENT_WEEK_STATUS");')]),
 ("W2", "bye destroys ROS value", V, [('if (held) ros.low =', 'if (focal.weeks[week]?.state === "BYE") ros.value = 0;\n  if (held) ros.low =')]),
 ("W3", "generic positional replacement cutoff instead of the roster cascade", V, [("const rosterOnly = withL.total - withoutL.total;", "const rosterOnly = focalVal - 5;")]),
 ("W4", "bench ignored (only starters can replace)", R, [('const active = kept.filter((a) => a.status === "STARTER" || a.status === "BENCH");', 'const active = kept.filter((a) => a.status === "STARTER");')]),
 ("W5", "IR / reserve returns ignored", R, [("const reservists = kept.filter((a) => a.status !== \"STARTER\" && a.status !== \"BENCH\" && a.returns_in_week != null && a.returns_in_week <= s.week);", "const reservists: typeof kept = [];")]),
 ("W6", "FLEX cascade ignored (flex slots only accept their literal label)", R, [("const allowed = slotEligiblePositions(slot);", "const allowed = [slot];")]),
 ("W7", "a waiver claim with unknown competition is treated as guaranteed", V, [("if (pr != null) knownP.push({ c, l, p: pr });", "knownP.push({ c, l, p: pr ?? 1 });")]),
 ("W8", "an UNVERIFIED (full NFL) pool is used as the replacement market", V, [("market && market.verified ? topCandidates(market.candidates, week, TOP_K) : []", "market ? topCandidates(market.candidates, week, TOP_K) : []")]),
 ("W9", "availability is discounted a second time (lineup value x0.9)", R, [('return kind === "lineup" ? w.lineup : w.underlying;', 'return kind === "lineup" ? (w.lineup == null ? null : w.lineup * 0.9) : w.underlying;')]),
 ("W10", "unknown becomes zero", R, [('if (!w || w.state === "UNKNOWN") return null;', 'if (!w || w.state === "UNKNOWN") return 0;')]),
 ("W11", "market value input equals private roster value", V, [("market_value_input: lc(mw,", "market_value_input: ros,  /*")]),
 ("W12", "scoring-fingerprint mismatch no longer refuses", V, [("if (mismatch > 0) return mk(\"SCORING_FINGERPRINT_MISMATCH\");", "if (false as boolean) return mk(\"SCORING_FINGERPRINT_MISMATCH\");")]),
 ("W13", "Hold VOR uses the availability-aware lineup value instead of the underlying value", V, [('const holdCalcs = weeks.map((w) => calcWeek(rules, roster, focal, w, market, { focalKind: "underlying", heldAdd: held }));', 'const holdCalcs = weeks.map((w) => calcWeek(rules, roster, focal, w, market, { focalKind: "lineup", heldAdd: held }));')]),
 ("W14", "league VOR charges a bye week a negative replacement penalty", V, [('if (wk.state === "BYE" || (wk.state === "OUT" && kind === "lineup")) return 0;', 'if (false as boolean) return 0;')]),
 ("W15", "unknown teammates are never reported provisional", R, [("provisional: unknownEligible.length > 0", "provisional: false")]),
 ("W16", "IR returns ignore the active-roster capacity", R, [("if (space <= 0) break;", "")]),
 ("W17", "the verified market is ignored for the weekly replacement", V, [("market && market.verified ? topCandidates(market.candidates, week, TOP_K) : [];", "[];")]),
 ("W18", "evidence validation no longer enforces bye = exactly 0", E, [('if (v.state === "BYE" && v.lineup !== 0)', 'if (false as boolean)')]),
 ("W19", "evidence validation no longer requires provenance on a feature", E, [("if (!f.provenance) out.push(", "if (false as boolean) out.push(")]),
 ("W20", "evidence validation allows an unknown feature without a reason", E, [("if (f.value == null && !f.unknown_reason)", "if (false as boolean)")]),
 ("W21", "a waiver claim may be declared guaranteed", E, [('if (c.acquisition.method === "WAIVER_CLAIM" && p === 1)', 'if (false as boolean)')]),
 ("W25", "the adapter re-applies availability (a second injury discount)", A, [('weeks[week] = { state: "ACTIVE", lineup: exp, underlying: cond ?? exp };', 'weeks[week] = { state: "ACTIVE", lineup: exp * 0.9, underlying: cond ?? exp };')]),
 ("W26", "the adapter zero-fills unknown future weeks", A, [('else if (perGame == null) weeks[w] = { state: "UNKNOWN", lineup: null, underlying: null };', 'else if (perGame == null) weeks[w] = { state: "ACTIVE", lineup: 0, underlying: 0 };')]),
 ("W27", "the adapter treats a waiver / inferred add as certain", A, [("success_probability: providerVerifiedFa ? 1 : null", "success_probability: 1")]),
 ("W28", "an uncertified pool is treated as verified", A, [("const verified = ctx.free_agent_pool_readiness.actionable === true;", "const verified = true;")]),
 ("W29", "a verified current-week bye is not represented as a bye", A, [('else if (cw === "BYE" || f.game_status.is_bye) weeks[week]', 'else if (false as boolean) weeks[week]')]),
 ("W30", "the shadow routes are served from production", G, [('return env.VERCEL_ENV !== "production" || env.W2R1_SHADOW_ENABLED === "1";', "return true;")]),
 ("W31", "an unfinished layer is advertised as qualified", L, [('S4_k_dst_component_model: "NOT YET QUALIFIED",', 'S4_k_dst_component_model: "QUALIFIED",')]),
 ("W32", "the production-influence statement is dropped from responses", L, [("production_influence: PRODUCTION_STATEMENT,", "")]),
 ("W22", "a production module imports W2.R1 (shadow leaks into production)", W, [('import { buildOptimalLineup', 'import "@/lib/w2r1/version";\nimport { buildOptimalLineup')]),
 ("W23", "game-lock availability ignored (a not-yet-acquirable candidate is used)", R, [("if (c.acquisition.available_from_week != null && c.acquisition.available_from_week > week) continue;", "")]),
 ("W24", "scarcity VOR uses the best alternative instead of the pool shape", V, [("const sw = weeks.map((w) => overLevel(w, \"lineup\", \"top5\"));", "const sw = weeks.map((w) => overLevel(w, \"lineup\", \"best\"));")]),
]
EQUIVALENT = {}
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
def run():
    r = subprocess.run(["node", "--import", "tsx", "--test", *TESTS], capture_output=True, text=True)
    return sorted({l.strip()[7:] for l in r.stdout.splitlines() if l.strip().startswith("not ok")})
def main():
    only = set(sys.argv[1:]); files = {m[2] for m in MUT}; before = {f: sha(f) for f in files}
    base = set(run()); print(json.dumps({"baseline_failing": len(base), "baseline_failing_names": sorted(base)[:5]}), flush=True); res = []
    for mid, desc, path, edits in MUT:
        if only and mid not in only: continue
        orig = open(path).read(); new = orig
        for a, b in edits:
            c = new.count(a)
            if c != 1: print(json.dumps({"id": mid, "error": f"anchor matched {c}x", "anchor": a[:80]}), flush=True); new = None; break
            new = new.replace(a, b)
        if new is None: res.append((mid, "ANCHOR_ERROR")); continue
        open(path, "w").write(new)
        try: n2 = run()
        finally: open(path, "w").write(orig)
        fresh = [x for x in n2 if x not in base]
        res.append((mid, "KILLED" if fresh else ("EQUIVALENT" if mid in EQUIVALENT else "SURVIVED")))
        print(json.dumps({"id": mid, "mutation": desc, "status": res[-1][1], "newly_failing": len(fresh), "killed_by": [x[:110] for x in fresh[:2]]}), flush=True)
    print(json.dumps({"restored_byte_for_byte": before == {f: sha(f) for f in files}, "killed": sum(1 for _, s in res if s == "KILLED"), "total": len(res), "equivalent": [m for m, s in res if s == "EQUIVALENT"], "survived": [m for m, s in res if s not in ("KILLED", "EQUIVALENT")]}))
main()
