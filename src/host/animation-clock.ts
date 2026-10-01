/**
 * The only timer that draws frames (build plan ruling 4: no frames when idle). OpenTUI writes
 * synchronized-output markers on every frame and they cannot be switched off (Loom recon §2), so a
 * still screen must draw nothing at all.
 *
 * Every animation is a finite burst with an end time. The clock runs a timer only while at least
 * one burst is live: the first burst starts it, and the tick that finds the last burst over stops
 * it and samples the restoring state. Samples run on the 125 ms grid; the host asks for a render
 * only if the displayed cells changed. With no burst there is no timer, and a burst without a
 * finite end is refused.
 *
 * The clock also holds whether the terminal has focus (focus reports, `CSI ? 1004 h`), because the
 * idle motion ruling 4 allows (an eye blink) runs only while it does. The terminal is assumed
 * focused until it says otherwise: a terminal that never reports focus is one Trey is looking at.
 *
 * Loom's idle-safe pattern is the reference (`~/Code/loom/src/cockpit/app.tsx:306-325`); its lab's
 * constant `setInterval` is the anti-pattern this replaces.
 */

/** The timers the clock uses; OpenTUI's `Clock` and `ManualClock` fit this shape. */
export type Timers = {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

const systemTimers: Timers = {
  now: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** About 8 frames a second: the contract's motion grammar. */
export const FRAME_MS = 125;

export type Dispose = () => void;

/** A running animation: frames come until `end` (clock time), or until it is cancelled. */
export type Burst = {
  readonly start: number;
  readonly end: number;
  /** Stop it early. Harmless after it has ended. */
  cancel(): void;
};

export class AnimationClock {
  private readonly timers: Timers;
  private readonly frameMs: number;
  private readonly onTick: (now: number) => void;
  private readonly live = new Set<{ end: number }>();
  private readonly focusListeners = new Set<(focused: boolean) => void>();
  private handle: unknown;
  private ticking = false;
  private hasFocus = true;
  private sampledNow: number | undefined;

  constructor(opts: { onTick: (now: number) => void; frameMs?: number; timers?: Timers }) {
    this.onTick = opts.onTick;
    this.frameMs = opts.frameMs ?? FRAME_MS;
    this.timers = opts.timers ?? systemTimers;
  }

  /** The clock's time, for drawing an animation at the right step. */
  now(): number {
    return this.sampledNow ?? this.timers.now();
  }

  /** How many bursts are live. */
  get active(): number {
    return this.live.size;
  }

  /** Whether a timer exists right now. */
  get running(): boolean {
    return this.ticking;
  }

  /**
   * Queue a finite burst on the next sub-tick boundary. Start and restoration share the grid;
   * a non-integral duration rounds up to a whole sub-tick. Cancelling restores on the next tick.
   */
  burst(ms: number): Burst {
    if (!Number.isFinite(ms) || ms <= 0)
      throw new RangeError(`an animation burst needs a finite, positive length (got ${ms})`);
    const start = this.nextTick();
    const entry = { end: start + Math.ceil(ms / this.frameMs) * this.frameMs };
    this.live.add(entry);
    if (!this.ticking) this.schedule();
    return {
      start,
      end: entry.end,
      cancel: () => {
        this.live.delete(entry);
        // The pending tick samples restoration even when no bursts remain.
      },
    };
  }

  /** Whether the terminal has focus, as its last focus report said. */
  get focused(): boolean {
    return this.hasFocus;
  }

  /** A focus report arrived. Listeners hear only real changes. */
  setFocus(focused: boolean): void {
    if (focused === this.hasFocus) return;
    this.hasFocus = focused;
    for (const fn of [...this.focusListeners]) fn(focused);
  }

  /** Hear focus changes until the disposer is called. */
  onFocus(fn: (focused: boolean) => void): Dispose {
    this.focusListeners.add(fn);
    return () => {
      this.focusListeners.delete(fn);
    };
  }

  /** Drop every burst and the timer with them. */
  dispose(): void {
    this.live.clear();
    this.focusListeners.clear();
    this.stop();
  }

  private nextTick(): number {
    return (Math.floor(this.timers.now() / this.frameMs) + 1) * this.frameMs;
  }

  private schedule(): void {
    const at = this.nextTick();
    this.ticking = true;
    // Timers exposes intervals for OpenTUI's ManualClock compatibility. Use each once, then
    // re-arm against the grid rather than accumulating callback drift. A late tick skips slots.
    this.handle = this.timers.setInterval(
      () => {
        this.timers.clearInterval(this.handle);
        this.handle = undefined;
        if (this.timers.now() < at) {
          this.schedule();
          return;
        }
        this.tick();
      },
      Math.max(1, Math.ceil(at - this.timers.now())),
    );
  }

  private tick(): void {
    const now = Math.floor(this.timers.now() / this.frameMs) * this.frameMs;
    for (const b of this.live) if (b.end <= now) this.live.delete(b);
    this.sampledNow = now;
    try {
      this.onTick(now);
    } finally {
      this.sampledNow = undefined;
    }
    if (this.live.size === 0) this.ticking = false;
    else this.schedule();
  }

  private stop(): void {
    if (!this.ticking) return;
    this.timers.clearInterval(this.handle);
    this.handle = undefined;
    this.ticking = false;
  }
}
