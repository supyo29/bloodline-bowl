#!/usr/bin/env python3
"""W1.P4 mutation suite (M1-M10). Applies one source mutation at a time, runs the freshness-relevant test files, and restores the
file byte-for-byte. A mutation is KILLED when at least one test fails. Usage: python3 scripts/w1p4-mutation-suite.py"""
import hashlib, subprocess, sys, json

TESTS = [
    "test/freshness-policy.test.ts", "test/freshness-events.test.ts", "test/freshness-architecture.test.ts",
    "test/projection-observation-history.test.ts", "test/projection-observation-supabase.test.ts", "test/final-pregame.test.ts",
    "test/projection-freshness-lifecycle.test.ts", "test/multi-league-freshness.test.ts",
    "test/projection-snapshot-provider.test.ts", "test/canonical-weekly-forecast.test.ts",
    "test/canonical-weekly-forecast-architecture.test.ts", "test/projection-architecture-guard.test.ts",
]
CP = "lib/weekly/projections/canonical-provider.ts"
MUT = [
 ("M1", "Restore universal 90-minute TTL", CP, [
   ("{ maxAgeMs: batchPolicy.required_max_age_ms, now: () => nowMs }", "{ maxAgeMs: 90 * 60_000, now: () => nowMs }"),
   ("hit.age_ms <= batchPolicy.required_max_age_ms &&", "hit.age_ms <= 90 * 60_000 &&")]),
 ("M2", "Pointer/snapshot time replaces source observation time in the age gate", "lib/persistence/supabase/projection-snapshot.ts", [
   ("const t = Date.parse(l.source_observed_at ?? l.observed_at);", "const t = Date.parse(l.observed_at);")]),
 ("M3", "Treat failed refresh as fresh", "lib/weekly/freshness/policy.ts", [
   ('      state: "STALE",\n      invalidation_reasons: ["REFRESH_FAILED"],', '      state: "FRESH",\n      invalidation_reasons: ["REFRESH_FAILED"],')]),
 ("M4", "Allow post-kickoff observation to replace the final pregame record", "lib/weekly/freshness/final-pregame.ts", [
   ("if (!Number.isFinite(o) || o > k) return", "if (!Number.isFinite(o)) return")]),
 ("M5", "Share batches across different scoring (scoring dropped from the request-scope key)", CP, [
   ("${s.scoring_fingerprint}|${s.request_fingerprint}|${contentHash", "${s.request_fingerprint}|${contentHash")]),
 ("M6", "Require a Sleeper player id in generic event matching", "lib/weekly/freshness/events.ts", [
   ("const keys = PROVIDER_ID_KEYS[scope.provider] ?? [];", 'const keys = scope.provider === "sleeper" ? PROVIDER_ID_KEYS.sleeper! : [];')]),
 ("M7", "One simple player event invalidates everything (scope ignored)", "lib/weekly/freshness/events.ts", [
   ('    case "PLAYER": {', '    case "PLAYER": {\n      if (scope) return true;')]),
 ("M8", "Record identical observations repeatedly (no change-only gate)", "lib/weekly/freshness/observation.ts", [
   ("if (!needFull && changes.length === 0 && removed === 0) {", "if (false) {")]),
 ("M9", "Snapshot-created time presented as source-observed time", CP, [
   ("        source_observed_at: sourceAt,\n", "        source_observed_at: observedAt,\n")]),
 ("M10", "Wall clock read directly inside the freshness policy", "lib/weekly/freshness/policy.ts", [
   ("kickoffMs == null ? null : kickoffMs - input.now_ms;", "kickoffMs == null ? null : kickoffMs - Date.now();")]),
]

def sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()

def run():
    r = subprocess.run(["node", "--import", "tsx", "--test", *TESTS], capture_output=True, text=True)
    out = r.stdout
    num = lambda k: int(next((l.split()[-1] for l in out.splitlines() if l.startswith(f"# {k} ")), "0"))
    fails = sorted({l.strip()[7:] for l in out.splitlines() if l.strip().startswith("not ok")})
    return num("tests"), num("pass"), num("fail"), fails

def main():
    only = set(sys.argv[1:])
    files = {m[2] for m in MUT}
    before = {f: sha(f) for f in files}
    base = run()
    print(json.dumps({"baseline": {"tests": base[0], "pass": base[1], "fail": base[2]}}))
    if base[2] != 0:
        print("baseline not green; refusing to mutate", base[3]); sys.exit(2)
    results = []
    for mid, desc, path, edits in MUT:
        if only and mid not in only: continue
        orig = open(path).read()
        new = orig
        for a, b in edits:
            if new.count(a) != 1:
                print(json.dumps({"id": mid, "error": f"anchor matched {new.count(a)}x", "anchor": a[:60]})); sys.exit(3)
            new = new.replace(a, b)
        open(path, "w").write(new)
        try:
            t, p, f, names = run()
        finally:
            open(path, "w").write(orig)
        status = "KILLED" if f > 0 else "SURVIVED"
        results.append((mid, status))
        print(json.dumps({"id": mid, "mutation": desc, "file": path, "status": status, "failing_tests": f, "killed_by": names[:4]}))
    after = {f: sha(f) for f in files}
    print(json.dumps({"restored_byte_for_byte": before == after, "killed": sum(1 for _, s in results if s == "KILLED"), "survived": [m for m, s in results if s == "SURVIVED"]}))

main()
