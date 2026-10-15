#!/usr/bin/env python3
"""W2.P2 Role Shadow mutation suite. One source mutation at a time; KILLED when a test that passes on the unmutated tree fails; files are restored
byte-for-byte (hash-checked). Proves the W2.P2 tests can actually fail when a guard is weakened.
Usage: python3 scripts/role-shadow-mutation-suite.py [M1 M5 ...]"""
import hashlib, subprocess, sys, json
TESTS = [f"test/role-shadow-{n}.test.ts" for n in ("frozen", "arms", "record", "store", "capture", "isolation", "g3", "cli")]
REC, ARM, SPEC, SCO, STO, CAP, G3, CLI = ("lib/role-shadow/" + f for f in ("record.ts", "arms.ts", "spec.ts", "scoring.ts", "store.ts", "capture.ts", "g3.ts", "g3-cli.ts"))
OUT = "lib/persistence/supabase/role-shadow-outcomes.ts"
RUN = "lib/persistence/supabase/role-shadow-runtime.ts"
SUP = "lib/persistence/supabase/role-shadow-store.ts"
ROUTE = "app/api/cron/role-shadow-capture/route.ts"
MUT = [
 ("M1", "a capture AT the kickoff instant is accepted (strict < relaxed)", REC, [("if (!(x < ko)) v.push(", "if (x > ko) v.push(")]),
 ("M2", "capture time is no longer checked against kickoff", REC, [('const cap = need("captured_at", t.captured_at, true);', 'const cap = ms(t.captured_at);')]),
 ("M3", "source observation time is no longer checked against kickoff (late evidence accepted)", REC, [('const obs = need("source_observed_at", t.source_observed_at, true);', 'const obs = ms(t.source_observed_at);')]),
 ("M4", "Role as-of time is no longer checked against kickoff", REC, [('const asOf = need("role_as_of_at", t.role_as_of_at, true);', 'const asOf = ms(t.role_as_of_at);')]),
 ("M5", "Role data cutoff (hindsight through a later completed game) is no longer checked", REC, [('need("role_data_cutoff_at", t.role_data_cutoff_at, false);', 'void 0;')]),
 ("M6", "a reconstructed record can be population-eligible", REC, [('if (i.capture_class !== "LIVE_CAPTURED") reasons.push(`CLASS_${i.capture_class}_NEVER_ELIGIBLE`);', 'void 0;')]),
 ("M7", "league scoring that deviates from the frozen fit is treated as compatible", SCO, [('compatibility: deviations.length === 0 ? "TEMPLATE_HALF_ON_MODELED_KEYS"', 'compatibility: true ? "TEMPLATE_HALF_ON_MODELED_KEYS"')]),
 ("M8", "the injury-identity guard is disabled (arms apply on unverified evidence)", ARM, [('return all("NEUTRAL_IDENTITY_MISMATCH", Number.isFinite(residual) ? residual : null);', 'void 0;')]),
 ("M9", "availability applied twice (the arm result is discounted by P(active) again)", ARM, [('expected_points: rr.injury_adjusted_expected_points == null ? champion : r4(rr.injury_adjusted_expected_points), p_active', 'expected_points: rr.injury_adjusted_expected_points == null ? champion : r4(rr.injury_adjusted_expected_points * (p0 ?? 1)), p_active')]),
 ("M10", "the LINEAR shortcut (champion + delta x P(active)) replaces the injury-model re-run — the bug the parity sweep found", ARM, [('expected_points: rr.injury_adjusted_expected_points == null ? champion : r4(rr.injury_adjusted_expected_points), p_active', 'expected_points: rr.injury_adjusted_expected_points == null ? champion : r4(champion + delta * (p0 ?? 1)), p_active')]),
 ("M11", "no cap on the Role delta", ARM, [('FROZEN_CONF_WEIGHT[i.role.confidence] * clamp(raw, cap)', 'FROZEN_CONF_WEIGHT[i.role.confidence] * raw')]),
 ("M12", "no confidence shrinkage on the Role delta", ARM, [('FROZEN_CONF_WEIGHT[i.role.confidence] * clamp(raw, cap)', 'clamp(raw, cap)')]),
 ("M13", "known-unavailable players receive a Role delta", ARM, [('if (i.unavailable) return all("NEUTRAL_UNAVAILABLE");', 'void 0;')]),
 ("M14", "a missing Role feature becomes zero instead of making the arm neutral (BOTH null guards: challenger and ridge)", ARM, [('const v = feats[f.feature];', 'const v = feats[f.feature] ?? 0;'), ('const v = valueOf(m.features[j]!);', 'const v = valueOf(m.features[j]!) ?? 0;')]),
 ("M15", "the store's late-evidence refusal is disabled", STO, [('return nowMs >= ko ?', 'return nowMs > ko + 1e12 ?')]),
 ("M16", "a duplicate record overwrites instead of being a no-op", STO, [('if (this.rows.has(r.capture_id)) return { ...base, status: "DUPLICATE_IDENTICAL" };', 'void 0;')]),
 ("M17", "the opt-in flag accepts any truthy string", CAP, [('=> env[ROLE_SHADOW_FLAG] === "1";', '=> Boolean(env[ROLE_SHADOW_FLAG]);')]),
 ("M18", "the cutoff kickoff is the LATER of the two clocks (a disagreement loosens the guard)", CAP, [('new Date(Math.min(x, y)).toISOString()', 'new Date(Math.max(x, y)).toISOString()')]),
 ("M19", "a team disagreement between champion and Role forecast is no longer an identity conflict", CAP, [('if (rf.position !== pos || (fTeam && rTeam && fTeam !== rTeam))', 'if (rf.position !== pos)')]),
 ("M20", "repeated captures are no longer deduplicated to one decision (N inflated)", G3, [('chosen.set(`${r.player.gsis_id}|${r.season}|${r.week}|${r.scoring.fingerprint}`, r);', 'chosen.set(`${r.player.gsis_id}|${r.season}|${r.week}|${r.scoring.fingerprint}|${r.capture_id}`, r);')]),
 ("M21", "the sufficiency requirement is bypassed (gates evaluated on any sample)", G3, [('const met = unmet.length === 0;', 'const met = true;')]),
 ("M22", "model versions are pooled", G3, [('const ofVersion = bundle.records.filter((r) => r.models?.challenger?.config_hash === hash);', 'const ofVersion = bundle.records;')]),
 ("M23", "non-certified (approximate-scoring) outcomes are accepted", G3, [('if (o.evidence_status !== "CERTIFIED") { notEvaluable++; continue; }', 'void 0;')]),
 ("M24", "Q6 treats too few decided pairs as evaluable", G3, [('dec.decided < G.Q6_decisions.min_decided_pairs', 'dec.decided < 0')]),
 ("M25", "the pinned challenger config hash is edited (a frozen coefficient drifted)", SPEC, [('challenger_config_hash: "a95fe2c494cee49e4dec475bb176a6bc"', 'challenger_config_hash: "a95fe2c494cee49e4dec475bb176a6bd"')]),
 ("M26", "a production module imports the research layer", "lib/weekly/forecast/adapters.ts", [('import type { ShadowSignalInput } from "./schema";', 'import type { ShadowSignalInput } from "./schema";\nimport "@/lib/role-shadow/spec";')]),
 ("M27", "the capture mutates the production forecast it observes", CAP, [('const inj = f.injury_model;', 'const inj = f.injury_model; (f as { position: string | null }).position = pos;')]),
 ("M28", "record identity includes the capture time (re-capture of identical evidence is no longer idempotent)", REC, [('return { ...rest, timing: { role_data_cutoff_at: b.timing.role_data_cutoff_at } };', 'return { ...rest, timing: b.timing };')]),
 ("M38", "record identity includes the snapshot/observation LINEAGE ids (a fresh fetch of an identical belief mints a duplicate — the staging finding)", REC, [('const { provenance: _p, lineage: _l, ...rest } = b;', 'const { provenance: _p, ...rest } = b; const _l = 0;')]),
 ("M39", "record identity includes the source-observation instant (same staging finding, time half)", REC, [('return { ...rest, timing: { role_data_cutoff_at: b.timing.role_data_cutoff_at } };', 'return { ...rest, timing: { role_data_cutoff_at: b.timing.role_data_cutoff_at, so: b.timing.source_observed_at } };')]),
 ("M29", "the 3.0-point relevance floor is removed from the population", REC, [('else if (i.conditional_active_points < RELEVANCE_FLOOR_POINTS) reasons.push("BELOW_RELEVANCE_FLOOR");', 'void 0;')]),
 ("M30", "the cron route no longer authenticates", ROUTE, [('if (!auth.ok) return jsonResponse(', 'if (false as boolean) return jsonResponse(')]),
 ("M31", "the database's own late refusal (P0001) is reported as a generic error", SUP, [('e.code === "P0001"', 'e.code === "XXXXX"')]),
 ("M33", "a second DECISION look at the same model is no longer refused", CLI, [('if (repeated && !args.acknowledgeRepeatLook) {', 'if (false as boolean) {')]),
 ("M34", "the outcomes loader relabels every ledger row as CERTIFIED (approximate scoring laundered into the evaluation)", OUT, [('participation_state: r.participation_state, evidence_status: r.evidence_status,', 'participation_state: r.participation_state, evidence_status: "CERTIFIED",')]),
 ("M35", "the DECISION look is not written to the run log", CLI, [('if (report.look === "DECISION" && !args.noLog) {', 'if (false as boolean) {')]),
 ("M36", "the capture clock is read BEFORE the league contexts are built (the defect the real-source dry run found: every record 'composed after capture')", CAP, [('    const weeks = await deps.loadLeagueWeeks();', '    const nowMs = (deps.now ?? Date.now)();\n    const weeks = await deps.loadLeagueWeeks();'), ('    const nowMs = (deps.now ?? Date.now)();\n    const roleCache', '    const roleCache')]),
 ("M37", "the rostered set is the requesting MANAGER's roster instead of the league's (the second dry-run defect: ~8% of the population)", RUN, [('const rostered = leagueRosteredIds(st.snapshot);', 'const rostered = new Set(ctx.all_rostered.map((p) => p.canonical_player_id));')]),
 ("M32", "the capture no longer verifies the frozen-model integrity before running", CAP, [('const integ = (deps.integrity ?? verifyFrozenIntegrity)();', 'const integ = { ok: true, mismatches: [] as string[] };')]),
]
# Mutants proven EQUIVALENT by reasoning (the mutated guard is implied by another guard), reported separately rather than as a test gap.
EQUIVALENT = {"M4": "role_as_of_at <= captured_at is enforced by the chain check and captured_at < kickoff is enforced separately, so role_as_of_at < kickoff is implied; the explicit kickoff check is defense in depth"}
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
def run():
    r = subprocess.run(["node", "--import", "tsx", "--test", *TESTS], capture_output=True, text=True)
    return sorted({l.strip()[7:] for l in r.stdout.splitlines() if l.strip().startswith("not ok")})
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
        res.append((mid, "KILLED" if fresh else ("EQUIVALENT" if mid in EQUIVALENT else "SURVIVED")))
        print(json.dumps({"id": mid, "mutation": desc, "status": res[-1][1], "newly_failing": len(fresh), "killed_by": [x[:110] for x in fresh[:2]]}), flush=True)
    print(json.dumps({"restored_byte_for_byte": before == {f: sha(f) for f in files}, "killed": sum(1 for _, s in res if s == "KILLED"), "total": len(res), "equivalent": [m for m, s in res if s == "EQUIVALENT"], "survived": [m for m, s in res if s not in ("KILLED", "EQUIVALENT")]}))
main()
