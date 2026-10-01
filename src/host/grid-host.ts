/**
 * The one OpenTUI renderable Porch mounts (build plan ruling 3). A scene draws each frame from
 * scratch into a fresh `Grid`; the host keeps the previous frame's grid, compares the two cell by
 * cell, and writes only the cells that changed into its own buffer, which OpenTUI keeps between
 * frames (a `buffered` renderable). After a resize, or when there is no previous frame, every cell
 * is written (I5).
 *
 * It draws only when asked: `requestFrame()` (after input, a resize, a state change, or an
 * animation tick) schedules one frame however many times it is called before that frame, and
 * nothing else starts one. OpenTUI's renderer is never started in its continuous mode, so with no
 * request there is no frame at all (ruling 4).
 *
 * Input: key presses and bracketed pastes go to the scene, and a left click hands the scene the
 * action of the topmost hit region under the pointer. Each asks for a frame afterwards unless its
 * handler returns `false`. Focus reports update the animation clock and reach the scene, which asks
 * for a frame only if it draws focus.
 */
import {
  type CliRenderer,
  decodePasteBytes,
  type KeyEvent,
  type MouseEvent,
  type OptimizedBuffer,
  type PasteEvent,
  Renderable,
  RGBA,
  TextAttributes,
} from '@opentui/core';
import { monochrome, noColorRequested } from '../grid/color.ts';
import { type Cell, Grid, type Ground, type HitAction, sameCell } from '../grid/grid.ts';
import { AnimationClock, type Burst, type Dispose, type Timers } from './animation-clock.ts';

/** What a scene can ask of the host it is drawn in. */
export type HostApi = {
  /** Draw a frame soon (at most one, however often this is called before it). */
  requestFrame(): void;
  /** Queue a finite burst; its returned start/end lie on the animation sub-tick grid. */
  animate(ms: number): Burst;
  /** The animation clock's time, in milliseconds. */
  now(): number;
  /** Whether the terminal has focus (true until a focus report says otherwise). */
  focused(): boolean;
  /** Leave Porch. */
  quit(): void;
};

/** What a scene handler returns: `false` when nothing changed and no frame is needed. */
type Handled = boolean | undefined;

export type Scene = {
  /** The screen under everything, scanlines included. */
  ground: Ground;
  /** Draw the whole frame. Hit regions registered on the grid are what a click can reach. */
  draw(grid: Grid, host: HostApi): void;
  key?(key: KeyEvent, host: HostApi): Handled;
  /** A bracketed paste, as text (controls and newlines as the terminal sent them). */
  paste?(text: string, host: HostApi): Handled;
  /** A left click on a hit region. */
  hit?(action: HitAction, host: HostApi): Handled;
  /** The terminal gained or lost focus. No frame is drawn unless this returns something else. */
  focus?(focused: boolean, host: HostApi): Handled;
};

export type GridHostOptions = {
  scene: Scene;
  /** Draw in the monochrome pair; defaults to whether `NO_COLOR` is set. */
  noColor?: boolean;
  /** Timers for the animation clock (tests pass their own). */
  timers?: Timers;
  /** Frame period while animating. */
  frameMs?: number;
  onQuit?: () => void;
};

export class GridHost extends Renderable {
  private readonly renderer: CliRenderer;
  private readonly scene: Scene;
  private readonly noColor: boolean;
  private readonly clock: AnimationClock;
  private readonly onQuit: () => void;
  private readonly rgba = new Map<string, RGBA>();
  private readonly api: HostApi;
  private readonly unfocus: Dispose;
  private current: Grid | undefined;
  /** The grid whose cells the persistent buffer holds; undefined means write every cell. */
  private previous: Grid | undefined;
  private stale = true;
  /** The buffer the previous frame was written into. */
  private previousBuffer: OptimizedBuffer | undefined;
  /** Render passes, scene samples (including unchanged ticks), last and total cell writes. */
  paints = 0;
  draws = 0;
  written = 0;
  writes = 0;

  private readonly onKey = (key: KeyEvent) => {
    if (this.scene.key?.(key, this.api) !== false) this.requestFrame();
  };

  private readonly onTerminalPaste = (event: PasteEvent) => {
    const text = decodePasteBytes(event.bytes);
    if (this.scene.paste?.(text, this.api) !== false) this.requestFrame();
  };

  private readonly onTerminalResize = (width: number, height: number) => {
    this.width = width;
    this.height = height;
    this.previous = undefined;
    this.requestFrame();
  };

  private readonly onFocusIn = () => this.clock.setFocus(true);
  private readonly onFocusOut = () => this.clock.setFocus(false);

  constructor(renderer: CliRenderer, opts: GridHostOptions) {
    super(renderer, {
      id: 'porch-grid',
      position: 'absolute',
      left: 0,
      top: 0,
      width: renderer.width,
      height: renderer.height,
      buffered: true,
    });
    this.renderer = renderer;
    this.scene = opts.scene;
    this.noColor = opts.noColor ?? noColorRequested();
    this.onQuit = opts.onQuit ?? (() => {});
    this.clock = new AnimationClock({
      onTick: () => this.animationFrame(),
      ...(opts.frameMs !== undefined ? { frameMs: opts.frameMs } : {}),
      ...(opts.timers !== undefined ? { timers: opts.timers } : {}),
    });
    this.api = {
      requestFrame: () => this.requestFrame(),
      animate: (ms) => this.clock.burst(ms),
      now: () => this.clock.now(),
      focused: () => this.clock.focused,
      quit: () => this.onQuit(),
    };
    this.unfocus = this.clock.onFocus((focused) => {
      const handled = this.scene.focus?.(focused, this.api);
      if (handled !== undefined && handled !== false) this.requestFrame();
    });
    this.onMouseDown = (event: MouseEvent) => this.click(event);
    renderer.keyInput.on('keypress', this.onKey);
    renderer.keyInput.on('paste', this.onTerminalPaste);
    renderer.on('resize', this.onTerminalResize);
    renderer.on('focus', this.onFocusIn);
    renderer.on('blur', this.onFocusOut);
  }

  /** The grid last drawn, for tests and captures. */
  get grid(): Grid | undefined {
    return this.current;
  }

  /** The animation clock: whether it has a timer, how many bursts are live, and focus. */
  get animation(): { running: boolean; active: number; focused: boolean } {
    return { running: this.clock.running, active: this.clock.active, focused: this.clock.focused };
  }

  /**
   * Ask for one frame. Calls before that frame is drawn are the same request: OpenTUI's idle
   * renderer schedules one frame per batch of requests (`CliRenderer.requestRender`).
   */
  requestFrame(): void {
    this.stale = true;
    if (!this.isDestroyed) this.requestRender();
  }

  /** Sample motion before asking OpenTUI to render: unchanged sub-ticks emit no render pass. */
  private animationFrame(): void {
    if (this.isDestroyed) return;
    const prev = this.current;
    if (prev === undefined) {
      this.requestFrame();
      return;
    }
    const next = this.drawGrid(prev.cols, prev.rows);
    this.current = next;
    this.stale = false;
    for (let y = 0; y < next.rows; y++) {
      for (let x = 0; x < next.cols; x++) {
        const cell = next.at(x, y);
        if (cell !== undefined && changed(prev, next, x, y, cell, this.noColor)) {
          this.requestRender();
          return;
        }
      }
    }
  }

  private drawGrid(cols: number, rows: number): Grid {
    const grid = new Grid(cols, rows, this.scene.ground);
    this.scene.draw(grid, this.api);
    this.draws += 1;
    return grid;
  }

  private click(event: MouseEvent): void {
    if (event.button !== 0) return;
    const action = this.current?.hitAt(event.x - this.x, event.y - this.y) ?? null;
    if (action === null) return;
    if (this.scene.hit?.(action, this.api) !== false) this.requestFrame();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    // A buffered renderable draws into its own buffer, sized to it, which OpenTUI does not clear
    // between frames. Without one (a zero-sized host) it draws into the frame's buffer, which is
    // cleared, so every cell is written.
    const persistent = this.frameBuffer !== null && buffer === this.frameBuffer;
    const ox = persistent ? 0 : this.x;
    const oy = persistent ? 0 : this.y;
    const cols = Math.max(0, Math.min(this.width, buffer.width - ox));
    const rows = Math.max(0, Math.min(this.height, buffer.height - oy));
    let next = this.current;
    if (next === undefined || this.stale || next.cols !== cols || next.rows !== rows) {
      next = this.drawGrid(cols, rows);
      this.current = next;
      this.stale = false;
    }
    const prev = persistent && buffer === this.previousBuffer ? this.previous : undefined;
    const full = prev === undefined || prev.cols !== next.cols || prev.rows !== next.rows;
    let written = 0;
    for (let y = 0; y < next.rows; y++) {
      for (let x = 0; x < next.cols; x++) {
        const cell = next.at(x, y);
        if (cell === undefined || cell.w === 0) continue;
        if (!full && !changed(prev, next, x, y, cell)) continue;
        this.writeCell(buffer, ox + x, oy + y, cell);
        written += 1;
      }
    }
    this.previous = persistent ? next : undefined;
    this.previousBuffer = persistent ? buffer : undefined;
    this.written = written;
    this.writes += written;
    this.paints += 1;
  }

  private writeCell(buffer: OptimizedBuffer, x: number, y: number, cell: Readonly<Cell>): void {
    const { fg, bg } = this.noColor ? monochrome(cell.fg, cell.bg, cell.ch) : cell;
    const f = this.color(fg);
    const b = this.color(bg);
    // `setCell` stores one code point in one column: a wide grapheme, or one made of several code
    // points (a flag, a family, a combining mark, VS16), goes through `drawText`, which keeps the
    // cluster whole and marks its continuation column itself. The continuation cell is never
    // written after it.
    if (cell.w === 1 && cell.ch.length === 1) {
      buffer.setCell(x, y, cell.ch, f, b, attributes(cell));
      return;
    }
    // The buffer persists, so the column a wide glyph is about to cover may still hold the start of
    // an older wide glyph. OpenTUI unpairs that older glyph after the new one is written, blanking
    // the new one too (the pty check caught `x日本🙂` drawn over `日本語🙂` as `x日本  `). Clearing
    // the column first unpairs it beforehand.
    if (cell.w === 2) buffer.setCell(x + 1, y, ' ', f, b, 0);
    buffer.drawText(cell.ch, x, y, f, b, attributes(cell));
  }

  private color(hex: string): RGBA {
    let c = this.rgba.get(hex);
    if (c === undefined) {
      c = RGBA.fromHex(hex);
      this.rgba.set(hex, c);
    }
    return c;
  }

  protected override destroySelf(): void {
    this.unfocus();
    this.clock.dispose();
    this.renderer.keyInput.off('keypress', this.onKey);
    this.renderer.keyInput.off('paste', this.onTerminalPaste);
    this.renderer.off('resize', this.onTerminalResize);
    this.renderer.off('focus', this.onFocusIn);
    this.renderer.off('blur', this.onFocusOut);
    super.destroySelf();
  }
}

/**
 * Whether the glyph starting at `x` must be written again: it differs from the previous frame, or
 * it is wide and its continuation cell differs (which the grid's pairing rules make impossible, but
 * the check costs nothing and keeps a half-written wide glyph off the screen if they ever change).
 */
function changed(
  prev: Grid | undefined,
  next: Grid,
  x: number,
  y: number,
  cell: Readonly<Cell>,
  noColor = false,
): boolean {
  const old = prev?.at(x, y);
  if (old === undefined || !sameDisplayedCell(old, cell, noColor)) return true;
  if (cell.w !== 2) return false;
  const a = prev?.at(x + 1, y);
  const b = next.at(x + 1, y);
  return a === undefined || b === undefined || !sameDisplayedCell(a, b, noColor);
}

/** Raw equality is the fast path; monochrome can collapse distinct palette cells. */
function sameDisplayedCell(a: Readonly<Cell>, b: Readonly<Cell>, noColor: boolean): boolean {
  if (sameCell(a, b)) return true;
  return (
    noColor &&
    sameCell({ ...a, ...monochrome(a.fg, a.bg, a.ch) }, { ...b, ...monochrome(b.fg, b.bg, b.ch) })
  );
}

function attributes(c: Readonly<Cell>): number {
  let a = 0;
  if (c.bold === true) a |= TextAttributes.BOLD;
  if (c.dim === true) a |= TextAttributes.DIM;
  if (c.italic === true) a |= TextAttributes.ITALIC;
  if (c.underline === true) a |= TextAttributes.UNDERLINE;
  return a;
}
