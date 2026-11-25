#!/usr/bin/env python3
"""Build the chat-completion request JSON for a brief. Same prompts as driver.py."""
import json, sys, pathlib
brief_path = pathlib.Path(sys.argv[1])
out_path = pathlib.Path(sys.argv[2])
fix_file = sys.argv[3] if len(sys.argv) > 3 else None
err_file = sys.argv[4] if len(sys.argv) > 4 else None
SYSTEM = (
    "You are a senior geospatial web engineer writing production code for a real deliverable. "
    "Follow the brief exactly. Output format: for each file, one fenced code block whose info string "
    "is the language followed by the relative file path, e.g. ```python pipeline/build_data.py. "
    "No commentary outside the fenced blocks. Write complete files; never use placeholders or TODOs."
)
user = brief_path.read_text()
if fix_file and err_file:
    code = pathlib.Path(fix_file).read_text()
    err = pathlib.Path(err_file).read_text()[-4000:]
    user += ("\n\nREPAIR TASK: the file " + fix_file + " you previously wrote fails at runtime. "
             "Rewrite the COMPLETE corrected file in one fenced block with the same path. "
             "Current broken file:\n```\n" + code + "\n```\nRuntime stderr (tail):\n```\n" + err + "\n```")
req = {"model": "zai/glm-5.3-flash",
       "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
       "temperature": 0.2, "max_tokens": 65536, "thinking": {"type": "disabled"}}
out_path.write_text(json.dumps(req))
print("request bytes:", out_path.stat().st_size)
