#!/usr/bin/env python3
"""Protected-preview certification harness (read-only GETs / MCP tools/call via `vercel curl`). Usage: certify.py <preview-url> <production-url> <out.json>
Never prints secrets; every call is a GET or a JSON-RPC read-only tool call. Compares the integrated preview against current production."""
import json, subprocess, sys, time
PREVIEW, PROD, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
CWD = "/Users/johnmcpherson/Fantasy Football/Bloodline Bowl"
def curl(base, path, post=None, timeout=170):
    cmd = ["vercel", "curl", path, "--deployment", base, "--yes"]
    if post is not None:
        cmd += ["--", "-s", "-X", "POST", "-H", "content-type: application/json", "-H", "accept: application/json, text/event-stream", "--data", json.dumps(post)]
    else:
        cmd += ["--", "-s"]
    t0 = time.time()
    r = subprocess.run(cmd, cwd=CWD, capture_output=True, text=True, timeout=timeout)
    out = r.stdout
    body = None
    try: body = json.loads(out)
    except Exception:
        for line in out.splitlines():
            if line.startswith("data:"):
                try: body = json.loads(line[5:].strip())
                except Exception: pass
    return {"ms": int((time.time() - t0) * 1000), "body": body, "raw_len": len(out)}
def mcp(base, name, args):
    r = curl(base, "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
    sc = ((r["body"] or {}).get("result") or {}).get("structuredContent")
    return {"ms": r["ms"], "env": sc, "err": (r["body"] or {}).get("error")}
LEAGUES = {"bloodline-bowl": "supyo29", "devoted-to-the-game": "darthmarker", "maclin-on-chicks-xvi": sys.argv[4] if len(sys.argv) > 4 else None, "rogers-park": sys.argv[5] if len(sys.argv) > 5 else None}
res = {"preview": PREVIEW, "production": PROD, "leagues": {}}
for lg, mg in LEAGUES.items():
    if not mg: continue
    row = {}
    for label, base in (("preview", PREVIEW), ("production", PROD)):
        e = {}
        e["lineup"] = mcp(base, "bloodline_start_sit", {"league": lg, "manager": mg})
        e["waivers"] = mcp(base, "bloodline_waiver_analysis", {"league": lg, "manager": mg})
        if label == "preview":
            for v in ("roster", "dst", "upside", "qualification", "add"):
                e["w2r1_" + v] = mcp(base, "bloodline_dynamic_vor", {"league": lg, "manager": mg, "view": v})
            e["weekly"] = mcp(base, "bloodline_weekly_analysis", {"league": lg, "manager": mg})
        row[label] = e
    res["leagues"][lg] = row
json.dump(res, open(OUT, "w"))
print("saved", OUT)
