#!/usr/bin/env python3
"""W1.R2 mutation suite (M1-M14 required + M15-M20). One source mutation at a time; KILLED when a test that passes on the unmutated tree fails;
files restored byte-for-byte (hash-verified). Usage: python3 scripts/w1r2-mutation-suite.py [M1 M5 ...]"""
import hashlib, subprocess, sys, json

PATS = ["w1r2-final-pregame-clock", "w1r2-asset-value", "w1r2-mutation-gaps", "final-pregame", "final-pregame-calibration-grade", "projection-observation-supabase",
        "bye-asset-preservation", "feed-absent-bye", "injury-decisions", "competitive-trade-horizon", "api-lineup-parity", "wave1-ratchets",
        "canonical-weekly-forecast", "w1r1-five-league-certification", "multi-league-freshness", "calibration-ledger", "forward-row-normalization"]
TESTS = [f"test/{p}.test.ts" for p in PATS]
CTX, FP, ASSET, BUILD = "lib/weekly/context.ts", "lib/weekly/freshness/final-pregame.ts", "lib/weekly/forecast/asset.ts", "lib/weekly/forecast/build.ts"
WAIV, HOR, OBS = "lib/weekly/waivers.ts", "lib/trades/competitive/horizon.ts", "lib/persistence/supabase/projection-observations.ts"
MUT = [
  ("M1", "restore the pre-fetch composition time (request start)", CTX, [("projProvider.now ? projProvider.now() : fctx?.now_ms ?? null", "fctx?.now_ms ?? null")]),
  ("M2", "allow an observation made at kickoff as pregame evidence (store + context filter)", FP, [("if (c >= k || o >= k) return", "if (c >= k || o > k) return")]),
  ("M2b", "context capture filter drops the evidence-time cutoff", CTX, [(" && Date.parse(r.source_observed_at) < Date.parse(r.kickoff_at));", ");")]),
  ("M3", "waiver drop cost uses current-week value for non-bye players", WAIV, [("const keep = keepFor(hold.points);", "const keep = bye ? keepFor(hold.points) : keepLegacy;")]),
  ("M4", "a bye source zero overrides ROS evidence (builder)", BUILD, [("if (sourcePoints != null && sourcePoints > 0) {", "if (sourcePoints != null) {")]),
  ("M4b", "a bye source zero overrides ROS evidence (asset module)", ASSET, [("if (!suppressed && pre != null && pre > 0) candidates.push", "if (!suppressed && pre != null) candidates.push")]),
  ("M5", "unknown asset value maps to a low fallback (0)", ASSET, [("asset_value: { hold_points_per_week: hold, basis,", "asset_value: { hold_points_per_week: hold ?? 0, basis,")]),
  ("M6", "trade horizon multiplies all ROS by this week's availability", HOR, [("    if (!wp) return 0;\n    const weeksOut", "    if (!wp) return 0;\n    return (Math.min(1, Math.max(0, wp.expected_availability ?? 1)) - 1) * rate(id);\n    const weeksOut")]),
  ("M7", "the asset view requires a Sleeper id", BUILD, [("    asset_value: canonicalAssetValue({\n      row: p,", "    asset_value: canonicalAssetValue({\n      row: player?.identifiers?.sleeper_id ? p : null,")]),
  ("M8", "asset value equals current-week expected value", ASSET, [("asset_value: { hold_points_per_week: hold, basis,", "asset_value: { hold_points_per_week: expected, basis,")]),
  ("M9", "model version removed from the final-pregame signature", FP, [("    model_version: f.model_version,\n    value_state: f.value_state,", "    value_state: f.value_state,")]),
  ("M10", "shadow components removed from the signature", FP, [("    role: f.role,\n    environment: f.environment,\n    matchup: f.matchup,\n", "")]),
  ("M11", "RI lookup by provider id only (canonical identity dropped)", CTX, [("riSeasonSignal?.by_canonical_id?.get(p.canonical_player_id) ?? (p.identifiers", "(p.identifiers")]),
  ("M12", "K/DST null pts_std becomes a known zero", "lib/weekly/projections/sleeper-weekly.ts", [("const std = stats.pts_std == null ? Number.NaN : Number(stats.pts_std);", "const std = Number(stats.pts_std);")]),
  ("M13", "older OBSERVATION can overwrite the pointer when its composition is newer (DB guard removed)", OBS, [("{ ...scope, confirmed_through: `lte.${r.source_observed_at}`, composed_at: `lte.${r.composed_at}` }", "{ ...scope, composed_at: `lte.${r.composed_at}` }")]),
  ("M14", "older COMPOSITION can overwrite the pointer when its observation is newer/equal (DB guard removed)", OBS, [("{ ...scope, confirmed_through: `lte.${r.source_observed_at}`, composed_at: `lte.${r.composed_at}` }", "{ ...scope, confirmed_through: `lte.${r.source_observed_at}` }")]),
  ("M15", "calibration picks the latest COMPOSITION instead of the single final-revision rule", "lib/calibration/final-pregame-evidence.ts", [("?? selectFinalRevision(g);", "?? [...g].sort((a, b) => Date.parse(a.composed_at) - Date.parse(b.composed_at)).at(-1) ?? null;")]),
  ("M16", "the signature signs the freshness-downgraded certification state", FP, [("state: f.certification.state_before_freshness ?? f.certification.state,", "state: f.certification.state,")]),
  ("M17", "opponent/team removed from the signature", FP, [("    game: { team: f.team, opponent: f.opponent, position: f.position },\n", "")]),
  ("M18", "close calls read the source rows", "lib/weekly/intelligence.ts", [("const decisionRows = decisionProjectionRows(ctx.projections, ctx.forecasts).rows;", "const decisionRows = ctx.projections.by_player;")]),
  ("M19", "a capture failure is reported as nothing-to-capture (silent)", CTX, [('finalPregameCapture = { status: "FAILED", candidates: recs.length, counts: null, error: message };', 'finalPregameCapture = { status: "NOTHING_TO_CAPTURE", candidates: 0, counts: null, error: null };')]),
  ("M21", "a Questionable tag moves the hold value (Q valued on ROS, not its own projection)", ASSET, [('    if (condition === "NONE" || (condition === "INJURY_SHORT_TERM" && state === "QUESTIONABLE")) {', '    if (condition === "NONE") {')]),
  ("M21b", "a static ROS overrides a healthy player's fresh projection (uniform max)", ASSET, [('      if (row.projected_points != null) candidates.push({ v: row.projected_points, basis: condition === "NONE" ? "CURRENT_WEEK_NOT_BYE" : "QUESTIONABLE_SOURCE" });', '      if (row.projected_points != null) candidates.push({ v: row.projected_points, basis: condition === "NONE" ? "CURRENT_WEEK_NOT_BYE" : "QUESTIONABLE_SOURCE" });\n      if (fwd != null) candidates.push({ v: fwd, basis: fwdHoldBasis });')]),
  ("M21c", "bye + long-term: impairment not applied to the pre-bye number", ASSET, [('candidates.push({ v: r2(pre * factor), basis: "SOURCE_PROJECTION_PRE_BYE" });', 'candidates.push({ v: pre, basis: "SOURCE_PROJECTION_PRE_BYE" });')]),
  ("M22", "IR on a bye week carries no trade-horizon drag (re-audit B-3)", HOR, [("    if (!wp) return 0;\n    const weeksOut", "    if (!wp || isVerifiedBye(wp)) return 0;\n    const weeksOut")]),
  ("M23", "the ledger ignores the store's pointer and re-derives the final from revisions", "lib/calibration/final-pregame-evidence.ts", [("return viaPointer ?? selectFinalRevision(g);", "return selectFinalRevision(g);")]),
  ("M24", "a no-op store reports CAPTURED", CTX, [('status: fpStore.kind === "none" ? "STORE_NOT_CONFIGURED" : "CAPTURED"', 'status: "CAPTURED"')]),
  ("M25", "unknown-asset hold-backs / long-term notes are silent", WAIV, [("return notes.length > 0 ? { asset_review_notes: notes } : {};", "return {};")]),
  ("M26", "a player with an unknown CURRENT week becomes an assessable drop", WAIV, [("const currentKnown = isVerifiedBye(p) || p.projected_points != null;", "const currentKnown = true;")]),
  ("M27", "an injured drop valued from ROS carries no review note", WAIV, [('if (av.current_week.condition === "INJURY_SHORT_TERM" && fromForward) {', 'if (false) {')]),
  ("M28", "the ledger grades a pointer's revision without re-validating it", "lib/calibration/final-pregame-evidence.ts", [('g.find((r) => r.forecast_id === pointed && decideCandidate(null, r) === "RECORDED")', 'g.find((r) => r.forecast_id === pointed)')]),
  ("M20", "long-term injury treated as temporary (no forward impairment)", ASSET, [('const LONG_TERM: ReadonlySet<NormalizedInjuryState> = new Set(["INJURED_RESERVE", "UNAVAILABLE_LIST"]);', 'const LONG_TERM: ReadonlySet<NormalizedInjuryState> = new Set<NormalizedInjuryState>([]);')]),
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
    t, f, n = run(); print(json.dumps({"baseline": {"tests": t, "fail": f, "files": len(TESTS), "failing": n[:5]}}), flush=True)
    base = set(n); res = []
    for mid, desc, path, edits in MUT:
        if only and mid not in only: continue
        orig = open(path).read(); new = orig
        for a, b in edits:
            c = new.count(a)
            if c != 1: print(json.dumps({"id": mid, "error": f"anchor matched {c}x", "anchor": a[:70]}), flush=True); new = None; break
            new = new.replace(a, b)
        if new is None: res.append((mid, "ANCHOR_ERROR")); continue
        open(path, "w").write(new)
        try: t2, f2, n2 = run()
        finally: open(path, "w").write(orig)
        fresh = [x for x in n2 if x not in base]
        res.append((mid, "KILLED" if fresh else "SURVIVED"))
        print(json.dumps({"id": mid, "mutation": desc, "status": res[-1][1], "newly_failing": len(fresh), "killed_by": [x[:110] for x in fresh[:3]]}), flush=True)
    print(json.dumps({"restored_byte_for_byte": before == {f: sha(f) for f in files}, "killed": sum(1 for _, s in res if s == "KILLED"), "total": len(res), "survived": [m for m, s in res if s != "KILLED"]}))
main()
