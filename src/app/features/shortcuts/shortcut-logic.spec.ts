import { describe, expect, it } from 'vitest';
import { ACTION_GROUPS } from '../../core/actions/action-catalog';
import { resolveKeymap } from '../../core/actions/keymap';
import { shortcutGroups } from './shortcut-logic';

describe('shortcutGroups', () => {
  const keymap = resolveKeymap('macos', { TOGGLE_SIDEBAR: ['Mod+Shift+B'] });
  const override = { TOGGLE_SIDEBAR: ['Mod+Shift+B'] };

  it('lists all actions by group and marks the changed ones', () => {
    const groups = shortcutGroups(keymap, override, '', 'macos');
    expect(groups.map((g) => g.name)).toEqual([...ACTION_GROUPS]);
    const view = groups.find((g) => g.name === 'View')!;
    const sidebar = view.rows.find((r) => r.id === 'TOGGLE_SIDEBAR')!;
    expect(sidebar.changed).toBe(true);
    expect(sidebar.keys).toEqual([{ value: 'Mod+Shift+B', text: '⇧⌘B' }]);
    expect(groups[0].rows[0].changed).toBe(false);
  });

  it('filters by name, id and shortcut as written and as shown', () => {
    const ids = (q: string) =>
      shortcutGroups(keymap, override, q, 'macos').flatMap((g) => g.rows.map((r) => r.id));
    expect(ids('farbschema wählen')).toEqual(['COLOR_SCHEME']);
    expect(ids('toggle_side')).toEqual(['TOGGLE_SIDEBAR']);
    expect(ids('mod+enter')).toEqual(['RUN_STATEMENT']);
    // as shown: ⌘↩ is also part of ⇧⌘↩
    expect(ids('⌘↩')).toEqual(['RUN_STATEMENT', 'RUN_SCRIPT']);
    expect(ids('zzz')).toEqual([]);
  });
});
