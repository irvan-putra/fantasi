#!/usr/bin/env python3
"""Fenrir code-generation driver for the kota project.

Every substantive source file in this repo is drafted by a Fenrir-hosted
model (default GLM-5.3-Flash) through Fenrir's OpenAI-compatible API.
This driver only: sends the brief, applies the returned files, runs them,
feeds errors back, and logs token usage to gen/ledger.jsonl.

Usage:
  python3 gen/driver.py briefs/<name>.md --out <dir> [--model glm-5.3-flash] [--max-rounds 6]

The brief file tells the model what to build and which files to emit.
The model answers with fenced blocks whose info string is the target path,
e.g. ```pipeline/build_data.py ... ```
"""
import json, os, re, sys, time, pathlib, urllib.request, urllib.error

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEDGER = ROOT / 'gen' / 'ledger.jsonl'
KEY_PATH = pathlib.Path('/tmp/jakarta/fenrir.key')
BASE_URL = os.environ.get('FENRIR_BASE_URL', 'https://fenrir.lio.id/v1')
MODEL = 'zai/glm-5.3-flash'
UA = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}

SYSTEM = (
    'You are a careful senior web/data engineer. You answer ONLY with fenced code '
    'blocks. Each block info string is the repo-relative target path. No prose. '
    'Write complete, runnable files. Prefer vanilla JS, no build step, no npm.'
)

def chat(model, messages, temperature=0.2):
    key = KEY_PATH.read_text().strip()
    body = json.dumps({'model': model, 'messages': messages, 'temperature': temperature}).encode()
    req = urllib.request.Request(
        BASE_URL + '/chat/completions', data=body,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', **UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                d = json.load(r)
            break
        except urllib.error.HTTPError as e:
            txt = e.read().decode()[:500]
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(10 * (attempt + 1)); continue
            raise RuntimeError(f'Fenrir HTTP {e.code}: {txt}')
    usage = d.get('usage', {})
    with LEDGER.open('a') as f:
        f.write(json.dumps({'ts': time.time(), 'model': model, 'usage': usage}) + '\n')
    return d['choices'][0]['message']['content']

LANG_TAGS = {'python', 'py', 'javascript', 'js', 'html', 'css', 'json', 'bash', 'sh', 'text'}

def apply_blocks(text, outdir, default_name=None):
    wrote = []
    for m in re.finditer(r'```([^\n`]+)\n(.*?)```', text, re.S):
        path, code = m.group(1).strip(), m.group(2)
        if path.lower() in LANG_TAGS and default_name:
            path = default_name
        if not re.match(r'^[A-Za-z0-9_./-]+$', path) or '..' in path:
            continue
        p = ROOT / outdir / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(code if code.endswith('\n') else code + '\n')
        wrote.append(str(p.relative_to(ROOT)))
    return wrote

def main():
    brief_path, outdir = sys.argv[1], 'site'
    if '--out' in sys.argv:
        outdir = sys.argv[sys.argv.index('--out') + 1]
    model = MODEL
    if '--model' in sys.argv:
        model = sys.argv[sys.argv.index('--model') + 1]
    default_name = None
    if '--name' in sys.argv:
        default_name = sys.argv[sys.argv.index('--name') + 1]
    brief = pathlib.Path(brief_path).read_text()
    messages = [
        {'role': 'system', 'content': SYSTEM},
        {'role': 'user', 'content': brief},
    ]
    if '--fix' in sys.argv:
        target = pathlib.Path(sys.argv[sys.argv.index('--fix') + 1])
        err = pathlib.Path(sys.argv[sys.argv.index('--err') + 1]).read_text() if '--err' in sys.argv else ''
        messages[1]['content'] += (
            '\n\nYour previous attempt follows, then the error it produced. '
            'Return the complete corrected file(s), same format.\n\nCURRENT FILE:\n'
            + target.read_text() + '\n\nERROR OUTPUT:\n' + err[-4000:])
    text = chat(model, messages)
    wrote = apply_blocks(text, outdir, default_name)
    print('wrote:', *wrote, sep='\n  ')

if __name__ == '__main__':
    main()
