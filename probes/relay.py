#!/usr/bin/env python3
"""Own an inner pty; record and forward every native byte into the herdr pane.

Keyboard bytes arrive from that pane, not from a substitute pty-only transport.
The controller timestamps them before the Herdr API write (Loom typing-jank method).
"""
import argparse, base64, fcntl, json, os, pty, select, signal, struct, sys, termios, time, tty
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('--cat', action='store_true')
ap.add_argument('--no-blinks', action='store_true')
args = ap.parse_args()
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
root = Path(__file__).resolve().parent.parent
size = fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))
rows, cols, _, _ = struct.unpack('HHHH', size)
old = termios.tcgetattr(0)
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, size)
    if args.cat:
        # Raw cat echoes each byte itself; canonical tty echo can insert old
        # queued lines after our marker and would measure the line discipline.
        tty.setraw(0)
        os.execvp('cat', ['cat'])
    env = dict(os.environ, PORCH_GRID_DUMP=str(out / 'grid.json'),
               PORCH_PROBE_WAKEUPS=str(out / 'wakeups.jsonl'),
               PORCH_PROBE_SHEET=str(out / 'sheet.json'),
               TERM='xterm-256color', COLORTERM='truecolor', POST_MAIL_ROOT=str(out / 'post'))
    os.chdir(root)
    os.execvpe('node', ['node', '--import', 'tsx', '--import', str(root / 'probes/wakeups.mjs'),
                      str(root / 'probes/main.ts'), *(['--no-blinks'] if args.no_blinks else [])], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
(out / 'pid.json').write_text(json.dumps({'relay': os.getpid(), 'child': pid, 'parent': os.getppid(), 'cols': cols, 'rows': rows}))
chunks = open(out / 'chunks.jsonl', 'w')
stop = False
def stopping(*_):
    global stop
    stop = True
signal.signal(signal.SIGTERM, stopping)
signal.signal(signal.SIGINT, stopping)
tty.setraw(0)
try:
    while not stop:
        ready, _, _ = select.select([0, fd], [], [], .1)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data: break
            os.write(fd, data)
        if fd in ready:
            try: data = os.read(fd, 65536)
            except OSError: break
            if not data: break
            chunks.write(json.dumps({'at': time.time(), 'data': base64.b64encode(data).decode()}) + '\n')
            chunks.flush()
            os.write(1, data)
finally:
    termios.tcsetattr(0, termios.TCSANOW, old)
    # Only this fork's PID; wait and reap it before reporting completion.
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done: break
        time.sleep(.02)
    else:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
    chunks.close()
    os.close(fd)
    (out / 'exit.json').write_text(json.dumps({'exit': os.waitstatus_to_exitcode(status)}))
