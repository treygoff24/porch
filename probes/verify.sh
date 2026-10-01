#!/usr/bin/env bash
# Run through: testrun porch test -- bash probes/verify.sh
set -euo pipefail
cd "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")/.."
pnpm exec biome ci --colors=off probes
pnpm exec tsc --project probes/tsconfig.json --noEmit --pretty false
pnpm exec vitest run --config probes/vitest.config.ts --maxWorkers=4 probes/scene.test.ts

# Only these deliberately corrupted copies are expected to fail. An arbitrary
# crash is not a red proof: verify the expected mismatch/missing-sample readback.
if node --import tsx probes/fidelity.ts docs/probes/raw/fidelity-red; then
  printf '%s\n' 'colour red proof unexpectedly passed' >&2
  exit 1
fi
python3 - <<'PY'
import json
j=json.load(open('docs/probes/raw/fidelity-red/fidelity.json'))
assert j['sampled']==256 and j['matched']==240
PY
node --import tsx probes/fidelity.ts docs/probes/raw/herdr-8fps
node --import tsx probes/fidelity.ts docs/probes/raw/mosh-settled-8fps
node --import tsx probes/fidelity.ts docs/probes/raw/mosh-4fps

if node --import tsx probes/typing.ts docs/probes/raw/typing-red; then
  printf '%s\n' 'missing echo red proof unexpectedly passed' >&2
  exit 1
fi
python3 - <<'PY'
import json
j=json.load(open('docs/probes/raw/typing-red/typing-vt.json'))
assert j['cat']['missed']==0 and j['cat']['n']==78
assert j['typing']['missed']==78 and j['typingEmote']['missed']==60
PY
node --import tsx probes/typing.ts docs/probes/raw/herdr-8fps
node --import tsx probes/typing.ts docs/probes/raw/herdr-timestamped-8fps
node --import tsx probes/typing.ts docs/probes/raw/herdr-4fps
node --import tsx probes/typing.ts docs/probes/raw/mosh-settled-8fps
node --import tsx probes/typing.ts docs/probes/raw/mosh-4fps
python3 -m py_compile probes/*.py

# Final production-clock captures: quick idle checks, cadence including restoration,
# VT typing against cat, and retained palette evidence on both transports.
for capture in herdr-ruling-quiet mosh-ruling-quiet; do
  python3 probes/summarize.py "docs/probes/raw/$capture"
  node --import tsx probes/typing.ts "docs/probes/raw/$capture"
  node --import tsx probes/fidelity.ts "docs/probes/raw/$capture"
done
python3 - <<'PY_CHECK'
import json
for name in ['herdr-ruling-quiet', 'mosh-ruling-quiet']:
    root = 'docs/probes/raw/' + name
    s = json.load(open(root + '/summary.json'))
    t = json.load(open(root + '/typing-vt.json'))
    assert s['emote']['pass'] and s['emote']['maxRenderPassesIn1s'] <= 8
    assert all(row['passBytesAndRenders'] and row['timerWakeups'] == 0 for row in s['idle'])
    assert max(row['avg10'] for row in s['cpuPressure']) <= 30
    for key in ['typing', 'typingEmote']:
        assert t[key]['missed'] == 0
        assert t[key]['p50'] - t['cat']['p50'] <= 10
        assert t[key]['p95'] - t['cat']['p95'] <= 30
PY_CHECK
