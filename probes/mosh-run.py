#!/usr/bin/env python3
"""Own and capture the real mosh client's pty, downstream of its UDP transport."""
import argparse, base64, fcntl, json, os, pty, select, signal, termios, time, tty
from pathlib import Path
ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('--cat', action='store_true')
ap.add_argument('--no-blinks', action='store_true')
args = ap.parse_args()
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
relay = Path(__file__).resolve().with_name('relay.py')
size = fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))
old = termios.tcgetattr(0)
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, size)
    os.execvp('mosh', ['mosh', '--local', '--server=/usr/bin/mosh-server', '--predict=never', '127.0.0.1', '--',
                      'python3', str(relay), '--out', str(out), *(['--cat'] if args.cat else []),
                      *(['--no-blinks'] if args.no_blinks else [])])
fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
(out / 'mosh-pid.json').write_text(json.dumps({'wrapper': os.getpid(), 'client': pid}))
chunks = open(out / 'client-chunks.jsonl', 'w')
tty.setraw(0)
try:
    while True:
        ready, _, _ = select.select([0, fd], [], [], .1)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data: break
            os.write(fd, data)
        if fd in ready:
            try: data = os.read(fd, 65536)
            except OSError: break
            if not data: break
            chunks.write(json.dumps({'at':time.time(), 'data':base64.b64encode(data).decode()}) + '\n')
            chunks.flush()
            os.write(1, data)
finally:
    termios.tcsetattr(0, termios.TCSANOW, old)
    chunks.close()
    os.close(fd)
    done, status = os.waitpid(pid, os.WNOHANG)
    if not done:
        os.kill(pid, signal.SIGTERM)
        _, status = os.waitpid(pid, 0)
    (out / 'mosh-exit.json').write_text(json.dumps({'exit':os.waitstatus_to_exitcode(status)}))
