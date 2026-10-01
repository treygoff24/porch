#!/usr/bin/env python3
"""Controller for an explicitly owned Herdr pane. See the report for instrument limits."""
import argparse, base64, hashlib, json, math, os, random, signal, socket, time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument('--pane', required=True)
ap.add_argument('--socket', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--quick', action='store_true')
ap.add_argument('--no-blinks', action='store_true')
ap.add_argument('--mosh', action='store_true')
ap.add_argument('--frame-ms', type=int, default=125)
ap.add_argument('--wait-cpu', action='store_true')
args = ap.parse_args()
root = Path(__file__).resolve().parent.parent
out = Path(args.out).resolve()
if out.exists() and any(out.iterdir()): raise RuntimeError('output directory must be fresh')
out.mkdir(parents=True, exist_ok=True)
calls = 0
pressure = []
def cpu_pressure():
    first = Path('/proc/pressure/cpu').read_text().splitlines()[0]
    return float(next(item.split('=')[1] for item in first.split() if item.startswith('avg10=')))
def quiet(name):
    if args.wait_cpu:
        announced = False
        since = None
        # A stable quiet interval avoids accepting the instant a busy batch dips below testrun's
        # 30% threshold. Keep phase boundary values so a later contention spike stays visible.
        while True:
            value = cpu_pressure()
            if value <= 10:
                if since is None: since = time.monotonic()
                if time.monotonic() - since >= 5: break
            else: since = None
            if not announced:
                print(f'waiting for sustained low CPU pressure before {name}', flush=True)
                announced = True
            time.sleep(1)
    pressure.append({'phase': name, 'at': time.time(), 'avg10': cpu_pressure()})
def await_emote(d):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        state = json.loads((d / 'sheet.json').read_text())
        if state['emoteMsRemaining'] > 0: return
        time.sleep(.005)
    raise RuntimeError('emote did not start on the sub-tick grid')
def api(method, **params):
    global calls
    calls += 1
    params['pane_id'] = args.pane
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(5)
        sock.connect(args.socket)
        sock.sendall((json.dumps({'id': str(calls), 'method': method, 'params': params}) + '\n').encode())
        data = b''
        while b'\n' not in data: data += sock.recv(1 << 20)
    result = json.loads(data.split(b'\n')[0])
    if 'error' in result: raise RuntimeError(result['error'])
    return result['result']
def send(text):
    # Logical keys avoid Herdr's bracketed-paste treatment of command controls.
    if text == '\x15': api('pane.send_keys', keys=['ctrl+u'])
    elif text == '\x05': api('pane.send_keys', keys=['ctrl+e'])
    elif len(text) == 1 and text.isalpha(): api('pane.send_keys', keys=[text])
    else: api('pane.send_text', text=text)
def read(fmt='text'):
    return api('pane.read', source='visible', format=fmt, strip_ansi=fmt != 'ansi')['read']['text']
def wait_file(p, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if p.exists(): return
        time.sleep(.02)
    raise RuntimeError(f'no file {p}')
def launch(name, cat=False):
    d = out / name
    launcher = 'mosh-run.py' if args.mosh else 'relay.py'
    command = f'PORCH_PROBE_FRAME_MS={args.frame_ms} python3 {root}/probes/{launcher} --out {d}' + (' --cat' if cat else '') + (' --no-blinks' if args.no_blinks else '')
    api('pane.send_input', text=command, keys=['enter'])
    wait_file(d / 'pid.json')
    if not cat: wait_file(d / 'grid.json')
    # OpenTUI's terminal capability timeout is 5s. Do not count initialization
    # writes or timer callbacks as a settled idle screen.
    time.sleep(2 if cat else 10)
    return d
def stop(d):
    pids = json.loads((d / 'pid.json').read_text())
    # PID ownership must still match our relay and output path.
    command = Path(f'/proc/{pids["relay"]}/cmdline').read_bytes()
    if str(d).encode() not in command: raise RuntimeError('relay PID ownership changed')
    os.kill(pids['relay'], signal.SIGTERM)
    wait_file(d / 'exit.json', 10)
    if args.mosh:
        wait_file(d / 'mosh-exit.json', 15)
        client = json.loads((d / 'mosh-pid.json').read_text())['client']
        if Path(f'/proc/{client}').exists(): raise RuntimeError(f'mosh client survived: {client}')
        if Path(f'/proc/{pids["parent"]}').exists(): raise RuntimeError(f'mosh server survived: {pids["parent"]}')
    time.sleep(.3)
    for pid in pids['relay'], pids['child']:
        if Path(f'/proc/{pid}').exists(): raise RuntimeError(f'owned process survived: {pid}')
def snapshot(d):
    pid = json.loads((d / 'pid.json').read_text())['child']
    log = d / 'wakeups.jsonl'
    n = len(log.read_text().splitlines()) if log.exists() else 0
    os.kill(pid, signal.SIGUSR2)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        lines = log.read_text().splitlines() if log.exists() else []
        if len(lines) > n:
            time.sleep(.01)
            return {'at': time.time(), 'grid': json.loads((d / 'grid.json').read_text()), 'timers': json.loads(lines[-1]),
                    'state': json.loads((d / 'grid.json.state').read_text())}
        time.sleep(.002)
    raise RuntimeError('no timer snapshot')
def window(d, name, seconds):
    quiet(name + " start")
    a = snapshot(d)
    time.sleep(seconds)
    b = snapshot(d)
    chunks = [json.loads(line) for line in (d / 'chunks.jsonl').read_text().splitlines()]
    raw = b''.join(base64.b64decode(c['data']) for c in chunks if a['at'] <= c['at'] < b['at'])
    pressure.append({'phase': name + ' end', 'at': time.time(), 'avg10': cpu_pressure()})
    result = {'name': name, 'seconds': b['at'] - a['at'], 'bytes': len(raw),
              'syncFrames': raw.count(b'\x1b[?2026h'), 'renderPasses': b['grid']['passes'] - a['grid']['passes'],
              'timerWakeups': b['timers']['wakeups'] - a['timers']['wakeups'], 'start': a, 'end': b}
    print(json.dumps({k:v for k,v in result.items() if k not in ('start','end')}), flush=True)
    return result
def percentile(values, p):
    return sorted(values)[min(len(values)-1, int(p * len(values)))] if values else None
def typing(d, emote=False, cat=False):
    phase = 'cat' if cat else 'typing-emote' if emote else 'typing'
    quiet(phase + ' start')
    text = 'abcdef' if emote else 'abcdefghijklmnopqrstuvwxyz'
    latencies, sends, reads, markers = [], [], [], {}
    rng = random.Random(1)
    for repeat in range(10 if emote else 3):
        if cat:
            markers[str(repeat)] = f'B{hashlib.sha256(str(d).encode()).hexdigest()[:8]}_{repeat}: '
            send('\r\n' + markers[str(repeat)]); time.sleep(.2)
        elif repeat: send('\x15'); time.sleep(.2)
        if emote:
            quiet(f'typing-emote burst {repeat}')
            time.sleep(1.3)
            emote_start = time.time()
            send('\x05')
            await_emote(d)
        prefix = ''
        for i, char in enumerate(text):
            start = time.time()
            if emote and start - emote_start >= 1.125: break
            send(char)
            sends.append([start, char, repeat])
            prefix += char
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                screen = read()
                end = time.time()
                reads.append([end, screen])
                if (markers[str(repeat)] + prefix in screen if cat else f'ECHO: {prefix}' in screen):
                    latencies.append((end-start)*1000)
                    break
                time.sleep(.001)
            else: raise RuntimeError(f'echo missing for {prefix}')
            time.sleep(rng.uniform(.6,1.4)/14)
    pressure.append({'phase': phase + ' end', 'at': time.time(), 'avg10': cpu_pressure()})
    result = {'n': len(latencies), 'p50': percentile(latencies,.5), 'p95': percentile(latencies,.95), 'max': max(latencies), 'ms': latencies}
    (d / ('typing-emote.json' if emote else 'typing.json')).write_text(json.dumps({'sends': sends, 'reads': reads, 'markers': markers, 'result': result}))
    print(json.dumps({k:v for k,v in result.items() if k != 'ms'}), flush=True)
    return result

active = None
results = {'transport': 'herdr + mosh --local --predict=never localhost' if args.mosh else 'herdr pane API input and rendered viewport readback', 'pane': args.pane}
try:
    active = launch('cat', cat=True)
    results['cat'] = typing(active, cat=True)
    stop(active); active = None
    active = launch('scene')
    results['idle'] = []
    # Focus reports injected through the actual pane input path.
    send('\x1b[O'); time.sleep(.5)
    if snapshot(active)['state']['focused'] is not False: raise RuntimeError('focus-out was not delivered')
    results['idle'].append(window(active, 'unfocused', 2 if args.quick else 30))
    send('\x1b[I'); send('\x15'); time.sleep(.5)
    if snapshot(active)['state']['focused'] is not True: raise RuntimeError('focus-in was not delivered')
    results['idle'].append(window(active, 'blink-window', 2 if args.quick else 32))
    results['typing'] = typing(active)
    send('\x15'); time.sleep(.2)
    results['typingEmote'] = typing(active, emote=True)
    send('\x15'); time.sleep(.3)
    # Capture a finite authored emote, including its immediate and final render passes.
    time.sleep(1.3)
    quiet('cadence start')
    a = snapshot(active); send('\x05'); await_emote(active)
    time.sleep(1.4); b = snapshot(active)
    pressure.append({'phase': 'cadence end', 'at': time.time(), 'avg10': cpu_pressure()})
    results['emote'] = {'start': a, 'end': b, 'durationMs':1125}
    results['sheet'] = json.loads((active / 'sheet.json').read_text())
    results['sheetAnsi'] = read('ansi')
    (out / 'pane-sheet.ansi').write_text(results['sheetAnsi'])
    # Last Ctrl+U above is a real keypress; wait out the actual two-minute policy.
    if not args.quick:
        remaining = 121 - (time.time() - a['at'])
        if remaining > 0: time.sleep(remaining)
        results['idle'].append(window(active, 'focused-after-blink-window', 30))
    stop(active); active = None
finally:
    if active is not None: stop(active)
    results['cpuPressure'] = pressure
    (out / 'results.json').write_text(json.dumps(results, indent=2))
