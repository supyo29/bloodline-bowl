#!/usr/bin/env python3
"""Parse node:test TAP output into a failure list. usage: parse-tap.py run.tap > failures.json
A 'leaf' failure is a `not ok` whose block has no failing child; suite wrappers ('N subtests failed') are dropped."""
import re, sys, json
lines = open(sys.argv[1], errors="replace").read().split("\n")
items = []  # (indent, ok, name, yaml_lines)
i = 0
while i < len(lines):
    m = re.match(r"^(\s*)(not ok|ok) (\d+) - (.*)$", lines[i])
    if m:
        ind = len(m.group(1)); name = m.group(4); ok = m.group(2) == "ok"
        yaml = []; j = i + 1
        if j < len(lines) and lines[j].strip() == "---":
            j += 1
            while j < len(lines) and lines[j].strip() != "...":
                yaml.append(lines[j]); j += 1
            j += 1
        items.append({"indent": ind, "ok": ok, "name": name, "yaml": yaml, "idx": len(items)})
        i = j
    else:
        i += 1
# parent/child by indentation order (children are emitted BEFORE their parent's line in node TAP: subtests precede the parent result)
fails = [it for it in items if not it["ok"]]
def has_failing_child(k):
    it = items[k]; p = k - 1
    while p >= 0 and items[p]["indent"] > it["indent"]:
        if items[p]["indent"] == it["indent"] + 4 and not items[p]["ok"]: return True
        p -= 1
    return False
out = []
for k, it in enumerate(items):
    if it["ok"]: continue
    if has_failing_child(k): continue
    y = "\n".join(it["yaml"])
    loc = re.search(r"location: '([^']+)'", y); err = re.search(r"error: (?:\|-?\n)?((?:\s{4,}.*\n?)+|.*)", y)
    stack = re.search(r"stack: \|-?\n((?:\s{4,}.*\n?)+)", y)
    ftype = re.search(r"failureType: '([^']+)'", y)
    f = loc.group(1).split(":")[0] if loc else None
    if f: f = f.split("/bb-audit/")[-1]
    out.append({"name": it["name"], "file": f, "location": loc.group(1) if loc else None, "failure_type": ftype.group(1) if ftype else None,
                "error": (err.group(1).strip() if err else y[:600])[:1500], "stack": (stack.group(1).strip() if stack else "")[:1500], "indent": it["indent"]})
json.dump(out, sys.stdout, indent=1)
