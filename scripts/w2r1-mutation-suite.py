#!/usr/bin/env python3
"""W2.R1 mutation suite. One source mutation at a time; KILLED when a test that passes on the unmutated tree fails; files are restored byte-for-byte
(hash-checked). Do NOT edit files while this runs. Usage: python3 scripts/w2r1-mutation-suite.py [W1 W2 ...]"""
import hashlib, subprocess, sys, json
TESTS = ["test/w2r1-vor.test.ts", "test/w2r1-isolation.test.ts", "test/w2r1-adapter.test.ts", "test/w2r1-kdst.test.ts", "test/w2r1-gameplan.test.ts"]
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
 ("W34", "an acquisition may enter a full active roster (no open spot)", R, [("const adds = wanted.slice(0, room);", "const adds = wanted;")]),
 ("W35", "an IR-slot player with unknown designation is assumed activatable now", A, [('returns = status === "IR" && out > 0 ? week + out : null;', 'returns = status === "IR" ? week + out : null;')]),
 ("W36", "K: the flat per-FG score (fgm) is not added to the distance-bin weights", "lib/w2r1/kdst.ts", [('make: [w(s, "fgm_0_19") + fm, w(s, "fgm_20_29") + fm, w(s, "fgm_30_39") + fm, w(s, "fgm_40_49") + fm,', 'make: [w(s, "fgm_0_19"), w(s, "fgm_20_29"), w(s, "fgm_30_39"), w(s, "fgm_40_49"),')]),
 ("W37", "K: a missed FG is never penalised", "lib/w2r1/kdst.ts", [("pbin[b]! * k.make[b]! + (1 - c.pbin[b]!) * k.miss[b]!)", "pbin[b]! * k.make[b]!)")]),
 ("W38", "D/ST: points-allowed uses only the bins (the continuous per-point key is ignored)", "lib/w2r1/kdst.ts", [("return d.pa_bins[bin]! + d.pa_cont * pa;", "return d.pa_bins[bin]!;")]),
 ("W39", "D/ST: the points-allowed DISTRIBUTION is replaced by its mean (bin scoring evaluated at the mean)", "lib/w2r1/kdst.ts", [("for (let k = 0; k < c.pa_pmf.length; k++) epa += c.pa_pmf[k]! * paScore(k, d);", "let m = 0; for (let k = 0; k < c.pa_pmf.length; k++) m += k * c.pa_pmf[k]!; epa = paScore(Math.round(m), d);")]),
 ("W40", "D/ST: yardage components (sack/return yards) are ignored", "lib/w2r1/kdst.ts", [("c.e_sacks * (d.sacks + d.sack_yd * c.mean_yds.sack_yd)", "c.e_sacks * (d.sacks)")]),
 ("W41", "an unreconstructable scoring key is silently dropped from the report", "lib/w2r1/kdst.ts", [("&& !SUPPORTED_K.test(k) && !SUPPORTED_D.has(k) && !/^pts_allow_/.test(k)", "&& false")]),
 ("W42", "S5: the TARGET game counts as prior evidence (<= instead of <)", "lib/w2r1/gameplan.ts", [("(g.season === target.season && g.week < target.week)", "(g.season === target.season && g.week <= target.week)")]),
 ("W43", "S5: later games leak backward into the window", "lib/w2r1/gameplan.ts", [("return games.filter((g) => isStrictlyEarlier(g, target))", "return games.filter(() => true)")]),
 ("W44", "S5: Tier-B evidence from the TARGET season is accepted as current truth", "lib/w2r1/gameplan.ts", [("if (a.evidenceSeason >= a.targetSeason || a.prior == null) return null;", "if (a.evidenceSeason > a.targetSeason || a.prior == null) return null;")]),
 ("W45", "S5: coaching continuity is ignored", "lib/w2r1/gameplan.ts", [("return (c.hcSame ? 1 : 0.4) * (c.qbSame === false ? 0.6 : 1);", "return 1;")]),
 ("W46", "S5: missing evidence is treated as full confidence", "lib/w2r1/gameplan.ts", [("return k >= 4 ? 1 : k >= 2 ? 0.6 : 0;", "return k >= 4 ? 1 : k >= 2 ? 0.6 : 1;")]),
 ("W47", "S5: a layer / interaction is retained without a bootstrap lower bound or the 0.03 gain", "lib/w2r1/gameplan.ts", [("export const retainLayer = (dMAE: number, lo95: number): boolean => dMAE >= MIN_LAYER_GAIN && lo95 > 0;", "export const retainLayer = (dMAE: number, lo95: number): boolean => dMAE >= 0;")]),
 ("W48", "S5: availability is discounted twice", "lib/w2r1/gameplan.ts", [("=> injury(b0 + delta);", "=> injury(injury(b0 + delta));")]),
 ("W49", "S5: an opponent matchup effect applies without player usage relevance", "lib/w2r1/gameplan.ts", [("(playerFingerprint == null || opponentResponse == null ? null : playerFingerprint * opponentResponse)", "(playerFingerprint == null || opponentResponse == null ? null : opponentResponse)")]),
 ("W50", "S5: teammate absence redistributes only to a direct backup", "lib/w2r1/gameplan.ts", [("for (const t of teammates) out.set(t.id, total > 0 ? absent * (Math.max(0, t.share) / total) : absent / Math.max(1, teammates.length));", "teammates.forEach((t, i) => out.set(t.id, i === 0 ? absent : 0));")]),
 ("W51", "S5: no-evidence is reported as OK", "lib/w2r1/gameplan.ts", [('if (i.totalGames <= 0) return ["NO_EVIDENCE"];', 'if (i.totalGames <= 0) return ["OK"];')]),
 ("W52", "S5: stale evidence is never flagged", "lib/w2r1/gameplan.ts", [("if (i.gapDays != null && i.gapDays > STALE_AFTER_DAYS) out.push(\"STALE_EVIDENCE\");", "")]),
 ("W53", "S5: the game-plan layer is imported by a production module (influences production)", "lib/weekly/waivers.ts", [('import { buildOptimalLineup', 'import "@/lib/w2r1/gameplan";\nimport { buildOptimalLineup')]),
 ("W54", "S5: Tier-B features enter the primary G2 candidate", "scripts/w2r1/s5_run.ts", [('case "G2": return g2;', 'case "G2": return [...g2, ...TIERB];')]),
 ("W55", "S5: wording claims certainty about an unpublished game plan", "lib/w2r1/gameplan.ts", [("tendency is ${level}", "will be ${level}")]),
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
