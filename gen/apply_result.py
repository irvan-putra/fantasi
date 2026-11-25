#!/usr/bin/env python3
"""Apply fenced blocks from a completed generation result JSON to files; append ledger."""
import json, re, sys, time, pathlib
result_path, repo = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
brief_rel, spend_note = sys.argv[3], sys.argv[4]
res = json.loads(result_path.read_text())
text = res["content"]
blocks = re.findall(r"```[\w+-]*\s+(\S+)\n(.*?)```", text, re.DOTALL)
if not blocks:
    blocks = [(m.group(1), m.group(2)) for m in re.finditer(r"```(\w[\w+-]*)\n(.*?)```", text, re.DOTALL)]
    blocks = [("unnamed_%d.%s" % (i, {"python":"py","html":"html","javascript":"js"}.get(l,"txt")), c) for i,(l,c) in enumerate(blocks)]
written = []
for rel, content in blocks:
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content.rstrip() + "\n")
    written.append(rel)
(repo / "gen").mkdir(exist_ok=True)
(repo / "gen/gen_last.md").write_text(text)
led = repo / "gen/ledger.jsonl"
prev = json.loads(led.read_text().strip().splitlines()[-1]) if led.exists() and led.read_text().strip() else None
cum = (prev["cumulative_usd"] if prev else 0.0) + res.get("cost_usd", 0.0)
entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "brief": brief_rel, "note": spend_note,
         "model": "zai/glm-5.3-flash", "usage": res.get("usage"), "cost_usd": res.get("cost_usd", 0.0),
         "cumulative_usd": round(cum, 6), "files": written}
with led.open("a") as f:
    f.write(json.dumps(entry) + "\n")
print("WROTE:", written)
print("CUMULATIVE USD: %.6f" % cum)
