#!/usr/bin/env python3
import argparse, base64, gzip, json
from pathlib import Path
ap = argparse.ArgumentParser()
ap.add_argument('directory')
args = ap.parse_args()
d = Path(args.directory)
r = json.loads((d / 'results.json').read_text())
raw = d / 'scene/chunks.jsonl'
if raw.exists(): content = raw.read_text()
else:
    with gzip.open(str(raw) + '.gz', 'rt') as stream: content = stream.read()
chunks = [json.loads(l) for l in content.splitlines()]
frames, pending = [], b''
start = b'\x1b[?2026h'
end = b'\x1b[?2026l'
at = None
for c in chunks:
    data = base64.b64decode(c['data'])
    pending += data
    while start in pending:
        begin = pending.index(start)
        if at is None: at = c['at']
        finish = pending.find(end, begin)
        if finish < 0:
            pending = pending[begin:]
            break
        frames.append({'at': at, 'bytes': finish + len(end) - begin})
        pending = pending[finish + len(end):]
        at = None
    if start not in pending: pending = b''
for row in r['idle']:
    row['passBytesAndRenders'] = row['bytes'] == 0 and row['renderPasses'] == 0 and row['syncFrames'] == 0
    if row['name'] == 'blink-window':
        fs = [f for f in frames if row['start']['at'] <= f['at'] < row['end']['at']]
        bursts = []
        for f in fs:
            if not bursts or f['at'] - bursts[-1]['lastAt'] > 1:
                bursts.append({'at':f['at'], 'lastAt':f['at'], 'bytes':0, 'frames':0})
            bursts[-1]['lastAt'] = f['at']; bursts[-1]['bytes'] += f['bytes']; bursts[-1]['frames'] += 1
        row['bursts'] = bursts
        row['startGapsS'] = [b['at']-a['at'] for a,b in zip(bursts, bursts[1:])]
        row['passBlink'] = bool(bursts) and all(n >= 6 for n in row['startGapsS']) and all(b['frames'] == 2 for b in bursts)
if 'emote' in r:
    e=r['emote']; fs=[f for f in frames if e['start']['at'] <= f['at'] < e['end']['at']]
    e['frames'] = fs
    e['renderPasses'] = e['end']['grid']['passes'] - e['start']['grid']['passes']
    e['maxBytes'] = max((f['bytes'] for f in fs), default=0)
    e['maxFramesIn1s'] = max((sum(0 <= b['at']-a['at'] < 1 for b in fs) for a in fs), default=0)
    observed = e['end']['timers'].get('passes', [])
    ps = [p for p in observed if e['start']['at'] <= p['at'] < e['end']['at']]
    e['renderTimes'] = ps
    e['maxRenderPassesIn1s'] = max((sum(0 <= b['at']-a['at'] < 1 for b in ps) for a in ps), default=None)
    e['pass'] = len(fs) >= 2 and e['maxFramesIn1s'] <= 8 and e['maxBytes'] <= 4096
    if e['maxRenderPassesIn1s'] is not None: e['pass'] = e['pass'] and e['maxRenderPassesIn1s'] <= 8
for name in ['typing','typingEmote']:
    if name in r:
        item = r[name]
        item['deltaP50'] = item['p50'] - r['cat']['p50']
        item['deltaP95'] = item['p95'] - r['cat']['p95']
        item['pass'] = item['deltaP50'] <= 10 and item['deltaP95'] <= 30
(d / 'summary.json').write_text(json.dumps(r, indent=2))
print(json.dumps({'idle': [{k:v for k,v in row.items() if k not in ('start','end')} for row in r['idle']],
                  'emote': {k:v for k,v in r.get('emote',{}).items() if k not in ('start','end','frames')},
                  'typing': {n:{k:v for k,v in r[n].items() if k!='ms'} for n in ['cat','typing','typingEmote'] if n in r}}, indent=2))
