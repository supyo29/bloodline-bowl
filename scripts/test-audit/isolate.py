#!/usr/bin/env python3
"""For every failing test in the ledger: does it pass (a) when its file runs alone, (b) when it runs alone (exact name)? usage: isolate.py ledger.json out.json"""
import json, subprocess, sys, re, os, concurrent.futures as cf
led = json.load(open(sys.argv[1])); files = sorted({l["file"] for l in led})
def run(args):
    r = subprocess.run(["node", "--import", "tsx", "--test", *args], capture_output=True, text=True, timeout=600)
    return r.stdout + r.stderr
def fails_in(out):
    return {re.sub(r"^\s*not ok \d+ - ", "", l) for l in out.split("\n") if re.match(r"^\s*not ok \d+ - ", l)}
res = {}
def file_run(f): return f, fails_in(run([f]))
with cf.ThreadPoolExecutor(4) as ex:
    for f, s in ex.map(file_run, files): res[f] = s
out = []
def single(l):
    pat = "^" + re.escape(l["name"]) + "$"
    o = run(["--test-name-pattern", pat, l["file"]])
    ok = re.search(r"^# fail 0", o, re.M) is not None and re.search(r"^# pass [1-9]", o, re.M) is not None
    return {**{k: l[k] for k in ("file", "name")}, "fails_when_file_runs_alone": l["name"] in res[l["file"]], "passes_when_test_runs_alone": ok}
with cf.ThreadPoolExecutor(4) as ex:
    out = list(ex.map(single, led))
json.dump(out, open(sys.argv[2], "w"), indent=1)
import collections
print(collections.Counter((o["fails_when_file_runs_alone"], o["passes_when_test_runs_alone"]) for o in out))
