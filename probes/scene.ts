import { readFileSync, writeFileSync } from 'node:fs';
import {
  type AvatarPack,
  applyImpersonationCap,
  type EmotePlayer,
  framePixels,
  freezeEmote,
  mirrorX,
  parseAvatar,
  playEmote,
  resolveAccent,
  SPRITE_PALETTE,
  toHalfBlocks,
} from '@estate/pixel';
import type { Grid } from '../src/grid/grid.ts';
import { scanlines } from '../src/grid/grid.ts';
import { graphemes } from '../src/grid/text.ts';
import type { HostApi, Scene } from '../src/host/grid-host.ts';

const names = ['bolt', 'wisp', 'ribbit'];
const packs = names.map((name) => {
  const result = parseAvatar(
    readFileSync(new URL(`../packages/pixel/examples/${name}.json`, import.meta.url)),
  );
  if (result.pack === null) throw new Error(`${name}: ${result.rules.join(', ')}`);
  return result.pack;
});

/** A probe-only scene; all drawing and terminal handling use the production host. */
export function probeScene(
  opts: { blinks?: boolean; sheet?: string; motion?: string; frameMs?: number } = {},
) {
  let line = '';
  let host: HostApi | undefined;
  let lastInput = -Infinity;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let restore: ReturnType<typeof setTimeout> | undefined;
  let emoteTimer: ReturnType<typeof setTimeout> | undefined;
  let blink = -1;
  let nextSprite = 0;
  let player: EmotePlayer | undefined;
  let emoteStart = 0;
  const full = opts.motion !== 'off' && opts.motion !== 'reduced';
  const cancel = () => {
    clearTimeout(pending);
    pending = undefined;
  };
  const schedule = (from?: number) => {
    cancel();
    if (!full || opts.blinks === false || !host?.focused()) return;
    const delay = Math.max(0, (from ?? host.now()) + 6000 + Math.random() * 8000 - host.now());
    if (host.now() + delay >= lastInput + 120000) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (!host?.focused() || host.now() >= lastInput + 120000 || player) {
        schedule();
        return;
      }
      blink = nextSprite++ % packs.length;
      const started = host.now();
      host.requestFrame();
      restore = setTimeout(() => {
        blink = -1;
        host?.requestFrame();
        restore = undefined;
        schedule(started);
      }, 125);
    }, delay);
  };
  const input = (h: HostApi) => {
    host = h;
    lastInput = h.now();
    if (!pending) schedule();
  };
  const scene: Scene = {
    ground: scanlines('#05080b', '#0a0f14'),
    draw(g: Grid, h: HostApi) {
      host = h;
      g.text(1, 0, 'PORCH RENDERER PROBE', { fg: '#3fd9f2' });
      g.text(1, 1, 'Ctrl+E emote | Ctrl+U clear | Esc quit');
      const frame = player?.frameAt(h.now() - emoteStart);
      if (player && h.now() >= emoteStart + player.durationMs) player = undefined;
      packs.forEach((pack: AvatarPack, i) => {
        const x = 2 + i * 19;
        const accent = resolveAccent(pack, { isOwner: false }, names[i] ?? '');
        const f = i === 0 ? frame : null;
        const px = f
          ? f.flipX
            ? mirrorX(f.px)
            : f.px
          : framePixels(pack.body[blink === i ? 'blink' : 'idle'] ?? pack.body.idle);
        if (!f || f.visible)
          g.blit(
            x + (f?.dx ?? 0),
            5 + (f?.dy ?? 0) / 2,
            toHalfBlocks(
              applyImpersonationCap(px, 'body', { isOwner: false }, accent),
              SPRITE_PALETTE,
            ),
          );
        for (const p of f?.particles ?? []) {
          g.withClip({ x: 0, y: 2, w: g.cols, h: 11 }, () =>
            g.blit(
              x + p.x,
              5 + Math.floor((p.y - p.px.length + 1) / 2),
              toHalfBlocks(p.px, SPRITE_PALETTE),
            ),
          );
        }
        g.text(x, 13, names[i] ?? '', { fg: SPRITE_PALETTE[accent] ?? '#dfe6ea' });
      });
      if (opts.sheet) {
        // Every ordered palette pair: 16 columns x 16 rows, equal pairs included.
        const cells = [];
        for (let b = 0; b < 16; b++) {
          g.blit(
            1,
            16 + b,
            toHalfBlocks([SPRITE_PALETTE.map((_, i) => i), Array(16).fill(b)], SPRITE_PALETTE),
          );
          for (let t = 0; t < 16; t++)
            cells.push({
              x: 1 + t,
              y: 16 + b,
              ch: '▀',
              fg: SPRITE_PALETTE[t],
              bg: SPRITE_PALETTE[b],
            });
        }
        writeFileSync(
          opts.sheet,
          JSON.stringify({
            cols: g.cols,
            rows: g.rows,
            cells,
            focused: h.focused(),
            emoteMsRemaining: player ? player.durationMs - (h.now() - emoteStart) : 0,
            blink,
            lastInput,
          }),
        );
      }
      g.text(1, g.rows - 2, `ECHO: ${line}`, { fg: '#dfe6ea' }, g.cols - 2);
    },
    key(k, h) {
      if (k.name === 'escape' || (k.ctrl && k.name === 'c')) {
        h.quit();
        return false;
      }
      input(h);
      if (k.ctrl && k.name === 'e') {
        if (opts.motion === 'off' || player) return false;
        // Use an authored pack and the actual freeze/player API, no bespoke animation.
        const frozen = freezeEmote(packs[0] as AvatarPack, 'beep-boop');
        if (!frozen) throw new Error('example emote did not freeze');
        player = playEmote(frozen.emote, 'body', full ? 'full' : 'reduced');
        emoteStart = h.now();
        if (full && (!opts.frameMs || opts.frameMs === 125)) {
          emoteStart = h.animate(player.durationMs).start;
          return false; // The grid-aligned clock draws the start; input itself changed no cells.
        } else if (full) {
          // Probe-only adjustment: pace host requests without changing src's clock.
          // Every timeout is bounded by this emote's real end time.
          const end = emoteStart + player.durationMs;
          const tick = () => {
            h.requestFrame();
            const remaining = end - h.now();
            emoteTimer =
              remaining > 0
                ? setTimeout(tick, Math.min(opts.frameMs ?? 250, remaining))
                : undefined;
          };
          emoteTimer = setTimeout(tick, Math.min(opts.frameMs ?? 250, player.durationMs));
        } else
          emoteTimer = setTimeout(() => {
            player = undefined;
            h.requestFrame();
          }, player.durationMs);
        return true;
      }
      if (k.ctrl && k.name === 'u') line = '';
      else if (k.name === 'backspace') line = graphemes(line).slice(0, -1).join('');
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject terminal controls in typed text
      else if (!k.ctrl && !k.meta && k.sequence && !/[\x00-\x1f\x7f]/.test(k.sequence))
        line += k.sequence;
      else return false;
      return true;
    },
    paste(s, h) {
      input(h);
      line += s.replace(/\r\n|\r|\n/g, ' ');
      return true;
    },
    focus(focused, h) {
      host = h;
      if (focused) schedule();
      else {
        cancel();
        clearTimeout(restore);
        restore = undefined;
        if (blink !== -1) {
          blink = -1;
          return true;
        }
      }
      return false;
    },
  };
  return {
    scene,
    status() {
      return {
        focused: host?.focused(),
        lastInput,
        now: host?.now(),
        emoteMsRemaining:
          player && host ? Math.max(0, player.durationMs - (host.now() - emoteStart)) : 0,
      };
    },
    dispose() {
      cancel();
      clearTimeout(restore);
      clearTimeout(emoteTimer);
    },
  };
}
