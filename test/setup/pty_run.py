#!/usr/bin/env python3
# Copied from ~/Code/loom/test/support/pty_run.py (c0c4b75); Porch adds the resize, waitFile and
# file steps.
"""Run a command under a pty of a given size, scripted, and report what happened.

    pty_run.py --cols 80 --rows 24 --out out.bin --script '[...]' -- cmd args...

The script is JSON: a list of steps, each one of
    {"wait": ms}                       sleep
    {"send": "text"}                   write to the terminal (\\x1b etc. are JSON-escaped by the caller)
    {"waitFor": "text", "ms": 5000}    read until the output contains the text (or fail the step)
    {"signal": "TERM"}                 signal the child (only the child this script started)
    {"mark": "name"}                   record the output length so far under `marks`
    {"probe": "name"}                  record the terminal's line discipline now under `tty`
    {"resize": [cols, rows]}           resize the pty (the kernel sends the child SIGWINCH); the
                                       output length at that moment goes into `resizes`
    {"waitFile": path, "contains": "text", "ms": 5000}
                                       poll until the file exists and contains the text
    {"file": "name", "path": path}     record the output length under `marks` and the file's text
                                       (or null) under `files`, at the same moment
The report's `times` (seconds since start) says when the last `send` and the last `signal` went, and
when the output first held the alternate screen's leave sequence (`left`).
Everything the child wrote to the terminal goes to --out. On exit a JSON line is printed:
    {"exit": code|null, "signal": name|null, "bytes": n, "marks": {...}, "timedOut": bool,
     "resizes": [[offset, cols, rows], ...], "files": {...},
     "tty": {"<probe name>": {"icanon": bool, "echo": bool} | null, "end": {...} | null}}
A terminal in raw mode has icanon and echo off; the cooked terminal a shell hands back has both on.
"""
import argparse, json, os, pty, select, signal, struct, sys, time, fcntl, termios

ap = argparse.ArgumentParser()
ap.add_argument('--cols', type=int, default=80)
ap.add_argument('--rows', type=int, default=24)
ap.add_argument('--out', required=True)
ap.add_argument('--script', default='[]')
ap.add_argument('--timeout', type=float, default=30.0)
ap.add_argument('cmd', nargs=argparse.REMAINDER)
args = ap.parse_args()
cmd = args.cmd[1:] if args.cmd and args.cmd[0] == '--' else args.cmd

pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', args.rows, args.cols, 0, 0))
buf = bytearray()
marks = {}
timed_out = False
start = time.time()

def pump(ms):
    """Read whatever arrives for up to ms milliseconds."""
    end = time.time() + ms / 1000.0
    while True:
        left = end - time.time()
        if left <= 0:
            return
        r, _, _ = select.select([fd], [], [], left)
        if not r:
            return
        try:
            data = os.read(fd, 65536)
        except OSError:
            return
        if not data:
            return
        buf.extend(data)
        if 'left' not in times and b'\x1b[?1049l' in buf:
            times['left'] = time.time() - start

def drain():
    """Read everything already waiting, without waiting for more."""
    while True:
        r, _, _ = select.select([fd], [], [], 0)
        if not r:
            return
        try:
            data = os.read(fd, 65536)
        except OSError:
            return
        if not data:
            return
        buf.extend(data)

tty = {}
times = {}
resizes = []
files = {}

def read_file(path):
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except OSError:
        return None

def tty_state():
    """The pty's line discipline as the child left it: raw mode is icanon and echo both off."""
    try:
        lflag = termios.tcgetattr(fd)[3]
        return {'icanon': bool(lflag & termios.ICANON), 'echo': bool(lflag & termios.ECHO)}
    except (termios.error, OSError):
        return None

def finished():
    try:
        p, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return (True, None)
    if p == 0:
        return (False, None)
    return (True, status)

result = None
for step in json.loads(args.script):
    if 'wait' in step:
        pump(step['wait'])
    elif 'send' in step:
        os.write(fd, step['send'].encode())
        times['send'] = time.time() - start
    elif 'waitFor' in step:
        needle = step['waitFor'].encode()
        deadline = time.time() + step.get('ms', 5000) / 1000.0
        while needle not in buf and time.time() < deadline:
            pump(50)
    elif 'signal' in step:
        os.kill(pid, getattr(signal, 'SIG' + step['signal']))
        times['signal'] = time.time() - start
    elif 'mark' in step:
        marks[step['mark']] = len(buf)
    elif 'probe' in step:
        tty[step['probe']] = tty_state()
    elif 'resize' in step:
        cols, rows = step['resize']
        drain()
        resizes.append([len(buf), cols, rows])
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    elif 'waitFile' in step:
        deadline = time.time() + step.get('ms', 5000) / 1000.0
        while time.time() < deadline:
            text = read_file(step['waitFile'])
            if text is not None and step.get('contains', '') in text:
                break
            pump(50)
    elif 'file' in step:
        drain()
        marks[step['file']] = len(buf)
        files[step['file']] = read_file(step['path'])
    if time.time() - start > args.timeout:
        timed_out = True
        break

# Let it finish on its own; never kill by pattern, only the child we started.
while True:
    pump(100)
    done, status = finished()
    if done:
        result = status
        tty['end'] = tty_state()
        break
    if time.time() - start > args.timeout:
        timed_out = True
        os.kill(pid, signal.SIGKILL)
        _, result = os.waitpid(pid, 0)
        break
pump(200)
with open(args.out, 'wb') as f:
    f.write(bytes(buf))
code = None
sig = None
if result is not None:
    if os.WIFEXITED(result):
        code = os.WEXITSTATUS(result)
    elif os.WIFSIGNALED(result):
        sig = signal.Signals(os.WTERMSIG(result)).name
print(json.dumps({'exit': code, 'signal': sig, 'bytes': len(buf), 'marks': marks, 'timedOut': timed_out, 'tty': tty, 'times': times, 'resizes': resizes, 'files': files}))
