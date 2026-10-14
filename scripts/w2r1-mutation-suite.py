#!/usr/bin/env python3
"""W2.R1 mutation suite. One source mutation at a time; KILLED when a test that passes on the unmutated tree fails; files are restored byte-for-byte
(hash-checked). Do NOT edit files while this runs. Usage: python3 scripts/w2r1-mutation-suite.py [W1 W2 ...]"""
import hashlib, subprocess, sys, json
TESTS = ["test/w2r1-vor.test.ts", "test/w2r1-isolation.test.ts", "test/w2r1-adapter.test.ts", "test/w2r1-kdst.test.ts", "test/w2r1-gameplan.test.ts", "test/w2r1-breakout.test.ts", "test/w2r1-freeze.test.ts", "test/w2r1-s8.test.ts", "test/w2r1-s9.test.ts", "test/w2r1-integration.test.ts"]
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
 ("W30", "the W2.R1 emergency stop is ignored", G, [('return env.W2R1_DISABLED !== "1";', "return true;")]),
 ("W31", "an unfinished layer is advertised as qualified", L, [('S4_k_dst_component_model: "D/ST: QUALIFIED_SHADOW (Devoted to the Game, Sporty\'s Alumni, Maclin on Chick\'s XVI); EXPLORATORY_POST_DEFECT (Rogers Park); DIAGNOSTIC_ONLY (Bloodline Bowl D/ST, all K)",', 'S4_k_dst_component_model: "QUALIFIED",')]),
 ("W32", "the decision-support / read-only statement is dropped from responses", L, [("decision_support: DECISION_SUPPORT_STATEMENT, writes_to_providers: false as const,", "")]),
 ("W34", "an acquisition may enter a full active roster (no open spot)", R, [("const adds = wanted.slice(0, room);", "const adds = wanted;")]),
 ("W35", "an IR-slot player with unknown designation is assumed activatable now", A, [('returns = status === "IR" && out > 0 ? week + out : null;', 'returns = status === "IR" ? week + out : null;')]),
 ("W36", "K: the flat per-FG score (fgm) is not added to the distance-bin weights", "lib/w2r1/kdst.ts", [('make: [w(s, "fgm_0_19") + fm, w(s, "fgm_20_29") + fm, w(s, "fgm_30_39") + fm, w(s, "fgm_40_49") + fm,', 'make: [w(s, "fgm_0_19"), w(s, "fgm_20_29"), w(s, "fgm_30_39"), w(s, "fgm_40_49"),')]),
 ("W37", "K: a missed FG is never penalised", "lib/w2r1/kdst.ts", [("pbin[b]! * k.make[b]! + (1 - c.pbin[b]!) * k.miss[b]!)", "pbin[b]! * k.make[b]!)")]),
 ("W38", "D/ST: points-allowed uses only the bins (the continuous per-point key is ignored)", "lib/w2r1/kdst.ts", [("return d.pa_bins[bin]! + d.pa_cont * pa;", "return d.pa_bins[bin]!;")]),
 ("W39", "D/ST: the points-allowed DISTRIBUTION is replaced by its mean (bin scoring evaluated at the mean)", "lib/w2r1/kdst.ts", [("for (let k = 0; k < c.pa_pmf.length; k++) epa += c.pa_pmf[k]! * paScore(k, d);", "let m = 0; for (let k = 0; k < c.pa_pmf.length; k++) m += k * c.pa_pmf[k]!; epa = paScore(Math.round(m), d);")]),
 ("W40", "D/ST: yardage components (sack/return yards) are ignored", "lib/w2r1/kdst.ts", [("c.e_sacks * (d.sacks + d.sack_yd * c.mean_yds.sack_yd)", "c.e_sacks * (d.sacks)")]),
 ("W41", "an unreconstructable scoring key is silently dropped from the report", "lib/w2r1/kdst.ts", [("&& !SUPPORTED_K.test(k) && !SUPPORTED_D[provider].has(k) && !NOT_APPLICABLE_D[provider].has(k) && !/^pts_allow_/.test(k)", "&& false")]),
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
 ("W56", "S6: the TARGET game leaks into a feature (as-of window includes the target week)", "scripts/w2r1/s6_build.R", [("return(NULL); idx <- which(h$season < s | (h$season == s & h$week < w))", "return(NULL); idx <- which(h$season < s | (h$season == s & h$week <= w))")]),
 ("W57", "S6: later games leak backward into the as-of window", "scripts/w2r1/s6_build.R", [("return(NULL); idx <- which(h$season < s | (h$season == s & h$week < w))", "return(NULL); idx <- which(h$season <= 2025)")]),
 ("W58", "S6: negative examples are dropped from cohort statistics", "lib/w2r1/breakout.ts", [("negatives: n - positives, rate, baseRate", "negatives: 0, rate, baseRate")]),
 ("W59", "S6: the base rate is omitted from the comparable-situation display", "lib/w2r1/breakout.ts", [("(about ${pct}% vs position base rate ${baseP}%)", "(about ${pct}%)")]),
 ("W60", "S6: a random split is accepted in place of the time split", "lib/w2r1/breakout.ts", [("if (!(maxFit < minVal)) throw", "if (false as boolean) throw")]),
 ("W61", "S6: position labels are pooled (TE judged on the top-12 label)", "lib/w2r1/breakout.ts", [("TE: 6, K: 6, DST: 6 }", "TE: 12, K: 6, DST: 6 }")]),
 ("W62", "S6: an unknown model output becomes probability 0", "lib/w2r1/breakout.ts", [("if (pModel == null || !Number.isFinite(pModel)) return baseRate;", "if (pModel == null || !Number.isFinite(pModel)) return 0;")]),
 ("W63", "S6: a player with no history is treated as high confidence", "lib/w2r1/breakout.ts", [("const w = confidenceWeight(priorGames, priorGames);", "const w = 1;")]),
 ("W64", "S6: a raw / uncalibrated score is displayed as a probability", "lib/w2r1/breakout.ts", [('if (verdict !== "VALIDATION CANDIDATE") return', 'if (false as boolean) return')]),
 ("W65", "S6: the high-upside alert threshold is altered after validation", "lib/w2r1/breakout.ts", [("export const ALERT_HIGH = 2.0;", "export const ALERT_HIGH = 1.2;")]),
 ("W66", "S6: the calibration gate (slope / ECE) is dropped", "lib/w2r1/breakout.ts", [("return b4 && b5 && late ? ", "return b5 && late ? ")]),
 ("W67", "S6: the breakout layer is imported by a production module (influences production)", "lib/weekly/waivers.ts", [('import { buildOptimalLineup', 'import "@/lib/w2r1/breakout";\nimport { buildOptimalLineup')]),
 ("W68", "S6: the minimum-events gate (INSUFFICIENT SAMPLE) is removed", "lib/w2r1/breakout.ts", [("if (g.events < 40) return", "if (false as boolean) return")]),
 ("W69", "S7 semantics: Yahoo special-teams fumble recoveries are mapped through Sleeper's def_st_fum_rec key", "lib/w2r1/kdst.ts", [('fumrec_st: sl ? w(s, "def_st_fum_rec") : w(s, "fum_rec")', 'fumrec_st: w(s, "def_st_fum_rec")')]),
 ("W70", "S7 semantics: Sleeper forced fumbles are double counted (ff + def_st_ff on defensive forced fumbles)", "lib/w2r1/kdst.ts", [('ff_def: sl ? w(s, "ff") : 0', 'ff_def: w(s, "ff") + w(s, "def_st_ff")')]),
 ("W71", "S7 semantics: Yahoo blocked-kick TDs are paid as the KR/PR TD key instead of the defensive Touchdown", "lib/w2r1/kdst.ts", [('blk_td: sl ? w(s, "def_st_td") : w(s, "def_td")', 'blk_td: sl ? w(s, "def_st_td") : w(s, "st_td")')]),
 ("W72", "S7 semantics: fum_rec_td (an individual-player key) is treated as a D/ST component candidate", "lib/w2r1/kdst.ts", [('sleeper: new Set(["st_td", "st_ff", "st_fum_rec", "kr_yd", "pr_yd", "fum_rec_td"]),', 'sleeper: new Set(["st_td", "st_ff", "st_fum_rec", "kr_yd", "pr_yd"]),')]),
 ("W73", "S7 semantics: Sleeper ST TDs use the individual-player st_td key instead of def_st_td", "lib/w2r1/kdst.ts", [('st_td: sl ? w(s, "def_st_td") : w(s, "st_td")', 'st_td: w(s, "st_td")')]),
 ("W74", "S7 semantics: the blocked-kick TD component is dropped from expected points", "lib/w2r1/kdst.ts", [("c.r_blk_td * d.blk_td +", "")]),
 ("W75", "S7 semantics: the provider is ignored (everything scored with Sleeper semantics)", "lib/w2r1/kdst.ts", [('const sl = provider === "sleeper";', "const sl = true;")]),
 ("W76", "S7 freeze: the S5 harness discounts availability a second time", "scripts/w2r1/s5_run.ts", [("expected: inj(r, b0 + delta), delta, applicable: true", "expected: inj(r, inj(r, b0 + delta)), delta, applicable: true")]),
 ("W77", "S7 freeze: the verifier ignores an artifact hash mismatch", "scripts/w2r1/s7_verify_frozen.ts", [("if (sha(at(p)) !== f.artifacts_sha256[p]) problems.push", "if (false as boolean) problems.push")]),
 ("W78", "S7 freeze: the verifier no longer pins the immutable preregistration", "scripts/w2r1/s7_verify_frozen.ts", [("if (sha(at(\"scripts/w2r1/prereg.json\")) !== PREREG_IMMUTABLE_SHA256 || f.prereg_sha256 !== PREREG_IMMUTABLE_SHA256)", "if (false as boolean)")]),
 ("W79", "S7 freeze: a missing artifact is silently skipped", "scripts/w2r1/s7_verify_frozen.ts", [("if (!existsSync(at(p))) { problems.push(`missing artifact ${p}`); continue; }", "if (!existsSync(at(p))) { continue; }")]),
 ("W80", "S8: a generic provider forecast may wear a W2.R1-qualified label (silent fallback)", "lib/w2r1/qualification.ts", [('if (q.state === "QUALIFIED_SHADOW" && source !== "W2R1_COMPONENT_MODEL") {', 'if (false as boolean) {')]),
 ("W81", "S8: Rogers Park D/ST is described as qualified", "lib/w2r1/qualification.ts", [('"rogers-park": { state: "EXPLORATORY_POST_DEFECT"', '"rogers-park": { state: "QUALIFIED_SHADOW"')]),
 ("W82", "S8: Bloodline D/ST is described as qualified", "lib/w2r1/qualification.ts", [('"bloodline-bowl": { state: "DIAGNOSTIC_ONLY", label: "D/ST expected points — unqualified"', '"bloodline-bowl": { state: "QUALIFIED_SHADOW", label: "D/ST expected points — unqualified"')]),
 ("W83", "S8: a kicker model is called W2.R1-qualified", "lib/w2r1/qualification.ts", [('const base = { state: "DIAGNOSTIC_ONLY" as const, label: "K forecast quality', 'const base = { state: "QUALIFIED_SHADOW" as unknown as "DIAGNOSTIC_ONLY", label: "K forecast quality')]),
 ("W84", "S8: the tactical layer is marked as applied to forecasts", "lib/w2r1/qualification.ts", [('applied_to_forecast: false as const', 'applied_to_forecast: true as unknown as false')]),
 ("W85", "S8: TE upside is shown as a calibrated (qualified) output", "lib/w2r1/qualification.ts", [('if (pos === "TE") return { state: "INSUFFICIENT_FINAL_SAMPLE"', 'if (pos === "TE") return { state: "QUALIFIED_SHADOW"')]),
 ("W86", "S8: WR upside gets a probability", "lib/w2r1/upside-live.ts", [('if (q.state === "NO_RELIABLE_SIGNAL") return', 'if (false as boolean) return')]),
 ("W87", "S8: Dynamic VOR is fed non-qualified D/ST values", "lib/w2r1/dst-live.ts", [('if (q.state !== "QUALIFIED_SHADOW" || cap.meta.target_week !== week)', 'if (cap.meta.target_week !== week)')]),
 ("W88", "S8: the D/ST override also rewrites future weeks / wrong-week captures", "lib/w2r1/dst-live.ts", [('|| cap.meta.target_week !== week)', ')')]),
 ("W89", "S8: D/ST override replaces a bye week", "lib/w2r1/dst-live.ts", [('if ("unavailable" in live || !cur || cur.state === "BYE") return a;', 'if ("unavailable" in live || !cur) return a;')]),
 ("W90", "S8: a bye / missing team is not reported UNAVAILABLE", "lib/w2r1/dst-live.ts", [('if (!t) return { unavailable: true, reason: `team ${team} has no game in week', 'if (!t && false as boolean) return { unavailable: true, reason: `team ${team} has no game in week')]),
 ("W91", "S8: the manifest verifier ignores a hash mismatch", "lib/w2r1/capture.ts", [('if (sha256(canonicalJson(JSON.parse(readFileSync(join(dir, f), "utf8")))) !== h) out.push', 'if (false as boolean) out.push')]),
 ("W92", "S8: a capture frozen AT kickoff is accepted", "lib/w2r1/capture.ts", [('if (Date.parse(frozenAt) >= Date.parse(firstKickoffAt)) throw', 'if (Date.parse(frozenAt) > Date.parse(firstKickoffAt)) throw')]),
 ("W93", "S8: decision regret ignores the best verified-pool alternative", "lib/w2r1/capture.ts", [('Math.max(rep, ...f.verified_pool_alternatives.map((id) => realized[id] ?? -Infinity)) - rep', '0')]),
 ("W94", "S8: the persistence row is allowed to influence production", "lib/w2r1/capture-store.ts", [('writes_to_providers: "false"', 'writes_to_providers: "true"')]),
 ("W95", "S9: the scenario memo ignores the removed player", "lib/w2r1/scenario-cache.ts", [('${s.removeId ?? ""}|', '|')]),
 ("W96", "S9: the scenario memo ignores the week", "lib/w2r1/scenario-cache.ts", [('const key = `${s.week}|', 'const key = `|')]),
 ("W97", "S9: the scenario memo ignores a value override (hold VOR)", "lib/w2r1/scenario-cache.ts", [('${s.valueOverride ? `${s.valueOverride.id}:${s.valueOverride.kind}` : ""}`;', '`;')]),
 ("W98", "integration: the D/ST override replaces a bye team's defense", "lib/weekly/context.ts", [('if (!p || p.position !== "DEF" || !p.nfl_team || row.is_bye) continue;', 'if (!p || p.position !== "DEF" || !p.nfl_team) continue;')]),
 ("W99", "integration: the W1 final-pregame calibration capture records the REPLACED values instead of provider evidence", "lib/weekly/context.ts", [('.map((id) => providerForecasts.by_player.get(id))', '.map((id) => forecasts.by_player.get(id))')]),
 ("W100", "integration: an unqualified league receives the D/ST override", "lib/w2r1/context-hook.ts", [('if (q.state !== "QUALIFIED_SHADOW") return off(', 'if (false as boolean) return off(')]),
 ("W101", "integration: a capture for a different week is applied", "lib/w2r1/context-hook.ts", [('if (!cap || cap.meta.target_week !== a.week) return off(', 'if (!cap) return off(')]),
 ("W102", "integration: the D/ST emergency stop is ignored", "lib/w2r1/context-hook.ts", [('if ((a.env ?? process.env).W2R1_DST_DISABLED === "1") return off("W2R1_DST_DISABLED emergency stop");', '')]),
 ("W103", "integration: forecasts are not recomposed after the D/ST replacement (production value diverges from the canonical forecast)", "lib/weekly/context.ts", [('if (dstReplaced.length > 0) forecasts = composeForecasts();', '')]),
 ("W104", "integration: a team without a capture row is zero-filled", "lib/w2r1/dst-live.ts", [('const t = cap.teams[normTeam(team)];\n  if (!t) return {', 'const t = cap.teams[normTeam(team)] ?? ({ available: true, opp: "", gameday: "", dst: { e_sacks: 0, e_ints: 0, e_fr: 0, r_fumrec_st: 0, r_ff_def: 0, r_ff_st: 0, r_def_td: 0, r_st_td: 0, r_blk_td: 0, r_safeties: 0, r_blk: 0, r_stops4: 0, r_forced_punts: 0, r_kr_yd: 0, r_pr_yd: 0, r_def2pt: 0, mean_yds: { sack_yd: 0, int_ret_yd: 0, fum_ret_yd: 0 }, pa_pmf: [1], pa_mean: 0 } } as never);\n  if (!t) return {')]),
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
