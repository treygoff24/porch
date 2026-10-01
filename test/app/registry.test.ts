import type { DisplayRecord } from '@estate/post-kit';
import { describe, expect, it } from 'vitest';
import {
  allCommands,
  command,
  type MessageRenderer,
  registerCommand,
  registerMessageRenderer,
  registerOverlay,
  rendererFor,
} from '../../src/app/registry.ts';

const record = (kind: DisplayRecord['kind'], text: string) => ({ kind, text }) as DisplayRecord;
const renderer = (
  kind: MessageRenderer['kind'],
  match?: (r: DisplayRecord) => boolean,
): MessageRenderer => ({
  kind,
  ...(match === undefined ? {} : { match }),
  measure: () => 1,
  draw: () => {},
});

describe('registries (I6)', () => {
  it('finds a command by exact name or alias, and refuses repeats', () => {
    const c = {
      name: 'reg-test',
      aliases: ['reg-alias'],
      usage: '/reg-test',
      needsChannel: false,
      run: async () => {},
    };
    registerCommand(c);
    expect(command('reg-test')).toBe(c);
    expect(command('reg-alias')).toBe(c);
    expect(command('reg')).toBeUndefined();
    expect(allCommands().filter((x) => x === c)).toHaveLength(1);
    expect(() => registerCommand({ ...c, name: 'reg-other', aliases: ['reg-alias'] })).toThrow(
      /already registered/,
    );
    expect(command('reg-other')).toBeUndefined();
  });

  it('refuses a repeated overlay id', () => {
    const o = { id: 'reg-overlay', draw: () => {}, key: () => 'pass' as const };
    registerOverlay(o);
    expect(() => registerOverlay(o)).toThrow(/already registered/);
  });

  it('draws a record with the newest matching renderer of its kind', () => {
    const plain = renderer('event');
    const special = renderer('event', (r) => r.text === 'special');
    registerMessageRenderer(plain);
    registerMessageRenderer(special);
    expect(rendererFor(record('event', 'special'))).toBe(special);
    expect(rendererFor(record('event', 'ordinary'))).toBe(plain);
  });
});
