/**
 * The help card's commands (finish review, fix 6): with every plug-in loaded, each registered
 * command has a real description, not just its usage line, and the card draws it.
 */
import { describe, expect, it } from 'vitest';
import '../../src/app/plugins.ts';
import { registerCoreCommands } from '../../src/app/commands.ts';
import { commandHelp, createHelp } from '../../src/app/overlays/help.ts';
import { allCommands } from '../../src/app/registry.ts';
import { Grid } from '../../src/grid/grid.ts';
import { GROUND, lines, Rig } from '../stage/rig.ts';

registerCoreCommands();

describe('help: commands', () => {
  it('every command has a form and a description of what it does', () => {
    const commands = allCommands();
    expect(commands.length).toBeGreaterThan(10);
    for (const c of commands) {
      const { form, what } = commandHelp(c.usage);
      expect(form.startsWith(`/${c.name}`), c.usage).toBe(true);
      expect(what.split(/\s+/).length, `/${c.name} needs a description`).toBeGreaterThanOrEqual(2);
    }
  });

  it('the card draws each description beside or under its command', () => {
    const o = createHelp();
    const s = new Rig().state(160, 44);
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      const g = new Grid(160, 44, GROUND);
      o.draw(g, { x: 0, y: 0, w: 160, h: 44 }, s);
      seen.push(...lines(g));
      o.key({ name: 'down', ctrl: false, alt: false, shift: false }, s);
    }
    for (const c of allCommands()) {
      const { form, what } = commandHelp(c.usage);
      const first = what.split(/\s+/).slice(0, 2).join(' ');
      const at = seen.findIndex(
        (l, i) => l.includes(form) && (l.includes(first) || (seen[i + 1] ?? '').includes(first)),
      );
      expect(at, `/${c.name}`).toBeGreaterThanOrEqual(0);
    }
  });
});
