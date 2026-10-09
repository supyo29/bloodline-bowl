#!/usr/bin/env python3
"""W2.P1 mutation suite. One source mutation at a time; KILLED when a test that passes on the unmutated tree fails; files restored byte-for-byte (hash-checked).
Usage: python3 scripts/w2p1-mutation-suite.py [M1 M5 ...]"""
import hashlib, subprocess, sys, json
TESTS = ["test/w2p1-role-qualification.test.ts", "test/role-calibration.test.ts", "test/wave1-ratchets.test.ts", "test/canonical-weekly-forecast.test.ts"]
H = "scripts/lib/role-qualification.ts"
MUT = [
 ("M1", "target-game realized opportunity used as the honest input feature (leakage)", H, [("conf: f.confidence, x, oracle: { ...x, ...tOpp },", "conf: f.confidence, x: { ...x, ...tOpp }, oracle: { ...x, ...tOpp },")]),
 ("M2", "availability applied twice (Role delta then an extra x(1-p_absent))", H, [("expected: injuryExpected(r, b0 + delta) };", "expected: injuryExpected(r, b0 + delta) * (1 - r.forecast.availability.p_absent) };")]),
 ("M3", "population not restricted to QB/RB/WR/TE (K/DST leak in)", H, [("(POSITIONS as readonly string[]).includes(p.position));", "true);")]),
 ("M4", "player keyed by a Sleeper id instead of the NFL (gsis) identity", H, [("gsis: p.gsis_id,", "gsis: p.sleeper_id ?? p.gsis_id,")]),
 ("M5", "no confidence shrinkage on the Role delta", H, [("const delta = ROLE_SHADOW_CONF_WEIGHT[r.conf] * clamped + 0;", "const delta = clamped + 0;")]),
 ("M6", "missing Role evidence becomes a zero forecast", H, [("applicable: false, expected: b1Of(r, scoring) };", "applicable: false, expected: 0 };")]),
 ("M7", "the freeze no longer pins the pre-registration", H, [('export const preregSha = (): string => createHash("sha256").update(readFileSync(join(ROOT, PREREG_PATH))).digest("hex");', 'export const preregSha = (): string => "0";')]),
 ("M8", "a production module imports the research harness", "lib/weekly/forecast/adapters.ts", [('import type { ShadowSignalInput } from "./schema";', 'import type { ShadowSignalInput } from "./schema";\nimport "../../../scripts/lib/role-qualification";')]),
 ("M9", "Role delta applied to OUT players", H, [('if (!model || !r.covered || r.designation === "OUT") return neutral;', 'if (!model || !r.covered) return neutral;')]),
 ("M10", "hindsight: the target week's own observed game enters the pre-game volume forecast", "lib/role-calibration/volume.ts", [("const before = (r: { season: number; week: number }, season: number, week: number): boolean => r.season < season || (r.season === season && r.week < week);", "const before = (r: { season: number; week: number }, season: number, week: number): boolean => r.season < season || (r.season === season && r.week <= week);")]),
 ("M11", "no cap on the Role delta", H, [("const clamped = Math.max(-cap, Math.min(cap, raw));", "const clamped = raw;")]),
 ("M12", "the baseline (TD-contaminated) term is dropped so nothing damps a one-game spike", H, [('WR: ["exp_targets", "exp_rz_targets", "snap_share", "air_yards_share", "b0"],', 'WR: ["exp_targets", "exp_rz_targets", "snap_share", "air_yards_share"],')]),
 ("M13", "bye-week players are scored as eligible", H, [("{ counts.bye_week++; continue; }", "{ counts.bye_week++; }")]),
 ("M14", "the oracle control is not actually a leak (harness would be blind to leakage)", H, [("oracle: { ...x, ...tOpp },", "oracle: { ...x },")]),
 ("M15", "Role delta forced to zero everywhere (a model that does nothing)", H, [("return { delta, raw, capped: Math.abs(raw) > cap, applicable: true, expected: injuryExpected(r, b0 + delta) };", "return { delta: 0, raw, capped: false, applicable: true, expected: injuryExpected(r, b0) };")]),
]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
def run():
    r = subprocess.run(["node", "--experimental-test-module-mocks", "--import", "tsx", "--test", *TESTS], capture_output=True, text=True)
    names = sorted({l.strip()[7:] for l in r.stdout.splitlines() if l.strip().startswith("not ok")})
    return names
def main():
    only = set(sys.argv[1:]); files = {m[2] for m in MUT}; before = {f: sha(f) for f in files}
    base = set(run()); print(json.dumps({"baseline_failing": len(base)}), flush=True); res = []
    for mid, desc, path, edits in MUT:
        if only and mid not in only: continue
        orig = open(path).read(); new = orig
        for a, b in edits:
            c = new.count(a)
            if c != 1: print(json.dumps({"id": mid, "error": f"anchor matched {c}x"}), flush=True); new = None; break
            new = new.replace(a, b)
        if new is None: res.append((mid, "ANCHOR_ERROR")); continue
        open(path, "w").write(new)
        try: n2 = run()
        finally: open(path, "w").write(orig)
        fresh = [x for x in n2 if x not in base]
        res.append((mid, "KILLED" if fresh else "SURVIVED"))
        print(json.dumps({"id": mid, "mutation": desc, "status": res[-1][1], "newly_failing": len(fresh), "killed_by": [x[:100] for x in fresh[:2]]}), flush=True)
    print(json.dumps({"restored_byte_for_byte": before == {f: sha(f) for f in files}, "killed": sum(1 for _, s in res if s == "KILLED"), "total": len(res), "not_killed": [m for m, s in res if s != "KILLED"]}))
main()
