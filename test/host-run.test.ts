/**
 * `runScene`'s ways out while the renderer is still starting, in process: a stand-in renderer
 * factory whose promise the test settles, and a stand-in for the process that signals and crashes
 * arrive on. Every way out gives the terminal back with each stack popped exactly once: the title
 * Porch pushed, and (through the renderer's own teardown) whatever the renderer pushed, however many
 * ways out run and in whatever order. The pty checks (`host-boot-pty.test.ts`) cover the ways out
 * once the renderer is up.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { CliRenderer } from '@opentui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanlines } from '../src/grid/grid.ts';
import type { Scene } from '../src/host/grid-host.ts';
import { LATE_START_MS, runScene } from '../src/host/run.ts';
import { POP_TITLE, PUSH_TITLE, RESTORE_SEQUENCE } from '../src/host/terminal.ts';

const scene: Scene = { ground: scanlines('#05080b', '#0a0f14'), draw() {} };

/** Marks the renderer's teardown in the output, where its own pops would go. */
const DESTROYED = '<renderer destroyed>';

function setup() {
  const out: string[] = [];
  const errs: string[] = [];
  const exits: number[] = [];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode() {
      return stdin;
    },
  }) as unknown as NodeJS.ReadStream;
  const stdout = {
    isTTY: true,
    write(s: string) {
      out.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const stderr = {
    write(s: string) {
      errs.push(s);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const proc = Object.assign(new EventEmitter(), {
    exit(code: number) {
      exits.push(code);
    },
  });
  let destroyed = 0;
  const renderer = {
    destroy() {
      destroyed += 1;
      out.push(DESTROYED);
    },
  } as unknown as CliRenderer;
  let resolveStart: (r: CliRenderer) => void = () => {};
  let rejectStart: (e: unknown) => void = () => {};
  const starting = new Promise<CliRenderer>((res, rej) => {
    resolveStart = res;
    rejectStart = rej;
  });
  const running = runScene(scene, { stdin, stdout, stderr, proc, createRenderer: () => starting });
  const text = () => out.join('');
  const times = (seq: string) => text().split(seq).length - 1;
  return {
    running,
    proc,
    errs,
    exits,
    text,
    times,
    destroyed: () => destroyed,
    arrive: () => resolveStart(renderer),
    fail: (e: unknown) => rejectStart(e),
    /** Nothing Porch put on the process is left behind. */
    listenersLeft: () =>
      ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'uncaughtException', 'unhandledRejection', 'exit']
        .map((e) => proc.listenerCount(e))
        .reduce((a, b) => a + b, 0),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

afterEach(() => {
  vi.useRealTimers();
});

describe('a signal while the renderer is starting', () => {
  it('waits for the renderer, lets its teardown run, then pops the title once', async () => {
    const s = setup();
    await tick();
    expect(s.times(PUSH_TITLE)).toBe(1);
    s.proc.emit('SIGTERM');
    // A second signal during the wait changes nothing.
    s.proc.emit('SIGHUP');
    await tick();
    // Still protected while the start settles: nothing has been given back yet.
    expect(s.times(POP_TITLE)).toBe(0);
    expect(s.listenersLeft()).toBeGreaterThan(0);
    s.arrive();
    expect(await s.running).toBe(0);
    expect(s.destroyed()).toBe(1);
    expect(s.times(POP_TITLE)).toBe(1);
    // The title is popped after the renderer's teardown, and the restore is the last thing written.
    expect(s.text().indexOf(DESTROYED)).toBeLessThan(s.text().indexOf(POP_TITLE));
    expect(s.text().endsWith(RESTORE_SEQUENCE)).toBe(true);
    expect(s.listenersLeft()).toBe(0);
    // A process exit afterwards writes nothing more.
    const before = s.text();
    s.proc.emit('exit');
    expect(s.text()).toBe(before);
  });

  it('keeps the terminal guarded past LATE_START_MS, and gives it back after a late renderer', async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    s.proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(LATE_START_MS);
    expect(await s.running).toBe(0);
    // Nothing is given back yet: the late renderer's teardown must come before the title pop.
    expect(s.times(POP_TITLE)).toBe(0);
    expect(s.listenersLeft()).toBeGreaterThan(0);
    s.arrive();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.destroyed()).toBe(1);
    expect(s.times(POP_TITLE)).toBe(1);
    expect(s.text().indexOf(DESTROYED)).toBeLessThan(s.text().indexOf(POP_TITLE));
    expect(s.text().endsWith(RESTORE_SEQUENCE)).toBe(true);
    expect(s.listenersLeft()).toBe(0);
  });

  it('leaves at once on another signal while a late renderer is still starting', async () => {
    vi.useFakeTimers();
    const s = setup();
    await vi.advanceTimersByTimeAsync(0);
    s.proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(LATE_START_MS);
    expect(await s.running).toBe(0);
    s.proc.emit('SIGINT');
    expect(s.exits).toEqual([0]);
    // The process exiting gives the terminal back through the exit guard, once.
    s.proc.emit('exit');
    expect(s.times(POP_TITLE)).toBe(1);
    expect(s.text().endsWith(RESTORE_SEQUENCE)).toBe(true);
  });

  it('pops the title once when the start then fails', async () => {
    const s = setup();
    await tick();
    s.proc.emit('SIGINT');
    await tick();
    s.fail(new Error('no terminal after all'));
    expect(await s.running).toBe(0);
    expect(s.destroyed()).toBe(0);
    expect(s.times(POP_TITLE)).toBe(1);
    expect(s.text().endsWith(RESTORE_SEQUENCE)).toBe(true);
    expect(s.listenersLeft()).toBe(0);
  });
});

describe('a failure while the renderer is starting', () => {
  it('a start that fails gives the terminal back once and says why', async () => {
    const s = setup();
    await tick();
    s.fail(new Error('the renderer broke'));
    expect(await s.running).toBe(1);
    expect(s.times(POP_TITLE)).toBe(1);
    expect(s.text().endsWith(RESTORE_SEQUENCE)).toBe(true);
    expect(s.errs.join('')).toBe('porch-next could not start its renderer: the renderer broke\n');
    expect(s.listenersLeft()).toBe(0);
  });

  it('an uncaught error gives the terminal back before its message, exits 1, and pops once', async () => {
    const s = setup();
    await tick();
    s.proc.emit('uncaughtException', new Error('boom'));
    expect(s.exits).toEqual([1]);
    expect(s.times(POP_TITLE)).toBe(1);
    expect(s.text().endsWith(RESTORE_SEQUENCE)).toBe(true);
    expect(s.errs.join('')).toContain('porch-next crashed: Error: boom');
    // Were the process to live on (the stand-in's exit returns), a start that then fails and the
    // process's own exit still pop nothing a second time.
    s.fail(new Error('late'));
    expect(await s.running).toBe(1);
    s.proc.emit('exit');
    expect(s.times(POP_TITLE)).toBe(1);
    expect(s.times(PUSH_TITLE)).toBe(1);
  });

  it('an unhandled rejection is a crash too', async () => {
    const s = setup();
    await tick();
    s.proc.emit('unhandledRejection', 'rejected');
    expect(s.exits).toEqual([1]);
    expect(s.times(POP_TITLE)).toBe(1);
    expect(s.errs.join('')).toContain('porch-next crashed: rejected');
    s.fail(new Error('late'));
    await s.running;
  });
});
