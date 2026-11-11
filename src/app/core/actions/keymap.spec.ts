import { describe, expect, it } from 'vitest';
import { ACTIONS, ACTION_GROUPS, ACTION_IDS, isActionId } from './action-catalog';
import {
  DEFAULT_KEYMAPS,
  assignShortcut,
  checkCandidate,
  pruneOverride,
  reservedReason,
  resolveKeymap,
} from './keymap';
import { Platform } from './platform';

const PLATFORMS: Platform[] = ['macos', 'windows', 'linux'];

describe('action catalog', () => {
  it('has unique ids in known groups', () => {
    expect(new Set(ACTION_IDS).size).toBe(ACTION_IDS.length);
    for (const a of ACTIONS) {
      expect(a.id, a.id).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(ACTION_GROUPS, a.id).toContain(a.group);
      expect(a.label.trim(), a.id).not.toBe('');
    }
    expect(isActionId('RUN_STATEMENT')).toBe(true);
    expect(isActionId('NO_SUCH_ACTION')).toBe(false);
  });
});

describe('default keymaps', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: only known actions, valid shortcuts, no conflict, nothing reserved`, () => {
      const keymap = resolveKeymap(platform);
      expect(keymap.problems).toEqual([]);
      for (const id of Object.keys(DEFAULT_KEYMAPS[platform]))
        expect(isActionId(id), id).toBe(true);
      expect(keymap.bindings.RUN_STATEMENT).toEqual(['Mod+Enter']);
      expect(keymap.lookup.get('Mod+K Mod+S')).toEqual(['OPEN_SHORTCUTS']);
    });
  }

  it('leaves the keys of text fields and of the editor alone', () => {
    for (const key of ['Mod+C', 'Mod+V', 'Mod+Z', 'Mod+F', 'F3', 'Ctrl+Space']) {
      expect(reservedReason(key, 'global', 'linux'), key).not.toBeNull();
    }
    expect(reservedReason('Mod+Q', 'view', 'macos')).not.toBeNull();
    expect(reservedReason('Mod+Q', 'view', 'linux')).toBeNull();
    expect(reservedReason('Mod+Enter', 'global', 'macos')).toBeNull();
  });
});

describe('resolveKeymap with an override', () => {
  it('replaces the shortcuts of an action; an empty list removes them', () => {
    const keymap = resolveKeymap('linux', { TOGGLE_SIDEBAR: ['Mod+Shift+B'], COLOR_SCHEME: [] });
    expect(keymap.bindings.TOGGLE_SIDEBAR).toEqual(['Mod+Shift+B']);
    expect(keymap.bindings.COLOR_SCHEME).toEqual([]);
    expect(keymap.lookup.has('Mod+B')).toBe(false);
    expect(keymap.problems).toEqual([]);
  });

  it('lets the override win a conflict and reports it', () => {
    const keymap = resolveKeymap('linux', { COLOR_SCHEME: ['Mod+B'] });
    expect(keymap.bindings.COLOR_SCHEME).toEqual(['Mod+B']);
    expect(keymap.bindings.TOGGLE_SIDEBAR).toEqual([]);
    expect(keymap.problems.join('\n')).toContain('verliert es');
  });

  it('reports and skips unknown ids, invalid and reserved shortcuts', () => {
    const keymap = resolveKeymap('macos', {
      NO_SUCH_ACTION: ['K'],
      TOGGLE_SIDEBAR: ['Mod+Q', 'not a key+', 'Mod+Shift+B'],
      COLOR_SCHEME: 'Mod+T',
    });
    const text = keymap.problems.join('\n');
    expect(text).toContain('Unbekannte Aktion „NO_SUCH_ACTION“');
    expect(text).toContain('reserviert');
    expect(text).toContain('kein gültiges Kürzel');
    expect(text).toContain('keine Liste');
    expect(keymap.bindings.TOGGLE_SIDEBAR).toEqual(['Mod+Shift+B']);
  });

  it('says when a single stroke hides a chord', () => {
    const keymap = resolveKeymap('linux', { TOGGLE_SIDEBAR: ['Mod+K'] });
    expect(keymap.problems.join('\n')).toContain('verdeckt den Akkord');
  });
});

describe('recording a shortcut', () => {
  const keymap = resolveKeymap('linux');

  it('classifies a candidate', () => {
    expect(checkCandidate('COLOR_SCHEME', 'Mod+Alt+L', keymap, 'linux').kind).toBe('ok');
    expect(checkCandidate('COLOR_SCHEME', 'Mod+Alt+T', keymap, 'linux').kind).toBe('same');
    expect(checkCandidate('COLOR_SCHEME', 'Mod+B', keymap, 'linux')).toEqual({
      kind: 'conflict',
      shortcut: 'Mod+B',
      owner: 'TOGGLE_SIDEBAR',
    });
    expect(checkCandidate('COLOR_SCHEME', 'Mod+C', keymap, 'linux').kind).toBe('reserved');
  });

  it('stores only what differs from the default', () => {
    const taken = assignShortcut({}, keymap, 'COLOR_SCHEME', 'Mod+B', 'linux', 'TOGGLE_SIDEBAR');
    expect(taken).toEqual({ COLOR_SCHEME: ['Mod+B'], TOGGLE_SIDEBAR: [] });
    const added = assignShortcut({}, keymap, 'COLOR_SCHEME', 'Mod+Alt+L', 'linux', null, 'add');
    expect(added).toEqual({ COLOR_SCHEME: ['Mod+Alt+T', 'Mod+Alt+L'] });
    expect(pruneOverride({ COLOR_SCHEME: ['Mod+Alt+T'], NOPE: ['K'] }, 'linux')).toEqual({});
  });
});
