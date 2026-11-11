import { afterEach, describe, expect, it } from 'vitest';
import { ACTIONS, ActionId } from '../../core/actions/action-catalog';
import { setLanguage } from '../../core/i18n/i18n';
import { NativeMenuNode } from '../../core/menu/menu.models';
import {
  CONNECTION_MENU,
  MENU_BAR,
  MenuDef,
  MenuSource,
  RESULT_MENU,
  TAB_MENU,
  actionsOf,
  nativeLabel,
  nativeStates,
  nativeStructureKey,
  resolveMenu,
  resolveMenuBar,
  stateChanges,
  toNativeSpec,
} from './menu-model';

function source(over: Partial<MenuSource> = {}): MenuSource {
  return {
    canRun: () => true,
    isChecked: () => undefined,
    shortcuts: (id) => (id === 'NEW_TAB' ? ['Mod+T', 'Mod+N'] : []),
    shortcutLabel: (id) => (id === 'NEW_TAB' ? 'Ctrl+T' : ''),
    ...over,
  };
}

const items = (nodes: readonly NativeMenuNode[]): NativeMenuNode[] =>
  nodes.flatMap((n) => (n.kind === 'submenu' ? items(n.items) : [n]));

describe('menu definitions', () => {
  it('offers every action of the catalog in the menu bar', () => {
    const inBar = new Set(MENU_BAR.flatMap((m) => actionsOf(m.items)));
    const missing = ACTIONS.map((a) => a.id).filter((id) => !inBar.has(id));
    expect(missing).toEqual([]);
  });

  it('names only actions of the catalog, each once per menu', () => {
    const known = new Set<string>(ACTIONS.map((a) => a.id));
    const menus: [string, readonly MenuDef[]][] = [
      ...MENU_BAR.map((m): [string, readonly MenuDef[]] => [m.id, m.items]),
      ['tab', TAB_MENU],
      ['result', RESULT_MENU],
      ['connection', CONNECTION_MENU],
    ];
    for (const [name, defs] of menus) {
      const ids = actionsOf(defs);
      expect(
        ids.filter((id) => !known.has(id)),
        name,
      ).toEqual([]);
      expect(new Set(ids).size, name).toBe(ids.length);
    }
  });

  it('has the menus the prompt asks for, in their order', () => {
    expect(MENU_BAR.map((m) => m.id)).toEqual([
      'app',
      'file',
      'edit',
      'view',
      'query',
      'connection',
      'tools',
      'window',
      'help',
    ]);
  });
});

describe('a menu in the window', () => {
  afterEach(() => setLanguage('de'));

  it('shows name, shortcut, grey and ticks from the actions', () => {
    const src = source({
      canRun: (id) => id !== 'CLOSE_OTHER_TABS',
      isChecked: (id) => (id === 'TOGGLE_RESULT' ? true : undefined),
    });
    const menu = resolveMenu(['NEW_TAB', '-', 'CLOSE_OTHER_TABS', 'TOGGLE_RESULT'], src, 'linux');
    expect(menu).toEqual([
      { id: 'NEW_TAB', label: 'Neuer Tab', disabled: false, shortcut: 'Ctrl+T' },
      { id: '-1', label: '', separator: true },
      { id: 'CLOSE_OTHER_TABS', label: 'Andere Tabs schließen', disabled: true },
      {
        id: 'TOGGLE_RESULT',
        label: 'Ergebnisbereich ein-/ausblenden',
        disabled: false,
        checked: true,
      },
    ]);
    setLanguage('en');
    expect(resolveMenu(['NEW_TAB'], src, 'linux')[0].label).toBe('New tab');
  });

  it('drops lines at the ends and doubled ones, native items and empty submenus', () => {
    const defs: MenuDef[] = [
      '-',
      { native: 'copy' },
      'NEW_TAB',
      '-',
      { when: 'macos', items: ['OPEN_FILE'] },
      '-',
      { sub: () => 'Leer', items: [{ native: 'cut' }] },
      { when: 'notMacos', items: ['QUIT_APP', '-'] },
    ];
    expect(resolveMenu(defs, source(), 'windows').map((i) => i.id)).toEqual([
      'NEW_TAB',
      '-2',
      'QUIT_APP',
    ]);
    expect(resolveMenu(defs, source(), 'macos').map((i) => i.id)).toEqual([
      'NEW_TAB',
      '-2',
      'OPEN_FILE',
    ]);
  });

  it('greys a submenu whose entries are all grey', () => {
    const defs: MenuDef[] = [{ sub: () => 'Kopieren als', items: ['COPY_AS_CSV', 'COPY_AS_JSON'] }];
    const on = resolveMenu(defs, source(), 'linux')[0];
    expect(on.children?.map((c) => c.id)).toEqual(['COPY_AS_CSV', 'COPY_AS_JSON']);
    expect(on.disabled).toBe(false);
    expect(resolveMenu(defs, source({ canRun: () => false }), 'linux')[0].disabled).toBe(true);
  });

  it('has no application and no window menu outside macOS', () => {
    expect(resolveMenuBar(source(), 'windows').map((m) => m.label)).toEqual([
      'Datei',
      'Bearbeiten',
      'Ansicht',
      'Abfrage',
      'Verbindung',
      'Werkzeuge',
      'Hilfe',
    ]);
    const file = resolveMenuBar(source(), 'linux')[0].items.map((i) => i.id);
    expect(file.at(-1)).toBe('QUIT_APP');
    const tools = resolveMenuBar(source(), 'linux').find((m) => m.id === 'tools')!;
    expect(tools.items.map((i) => i.id)).toContain('OPEN_SETTINGS');
  });
});

describe('the native menu', () => {
  afterEach(() => setLanguage('de'));

  it('carries the macOS menus with the words of the language', () => {
    const spec = toNativeSpec(source(), 'macos');
    expect(spec.menus.map((m) => (m.kind === 'submenu' ? m.label : '?'))).toEqual([
      'Schema Commander',
      'Datei',
      'Bearbeiten',
      'Ansicht',
      'Abfrage',
      'Verbindung',
      'Werkzeuge',
      'Fenster',
      'Hilfe',
    ]);
    const all = items(spec.menus);
    // what macOS needs for its own keys in text fields
    const native = all.filter((n) => n.kind === 'predefined').map((n) => n.name);
    for (const name of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'quit', 'hide']) {
      expect(native, name).toContain(name);
    }
    expect(all.find((n) => n.kind === 'predefined' && n.name === 'copy')).toEqual({
      kind: 'predefined',
      name: 'copy',
      label: 'Kopieren',
    });
    // the settings sit in the application menu, quit is the system's
    const ids = all.filter((n) => n.kind === 'item').map((n) => n.id);
    expect(ids).toContain('OPEN_SETTINGS');
    expect(ids).not.toContain('QUIT_APP');
    setLanguage('en');
    const english = toNativeSpec(source(), 'macos');
    expect(english.menus[1]).toMatchObject({ label: 'File' });
  });

  it('gives each action its first shortcut in the notation of the keymap, none while recording', () => {
    const find = (quiet: boolean) =>
      items(toNativeSpec(source(), 'macos', { quiet }).menus).find(
        (n) => n.kind === 'item' && n.id === 'NEW_TAB',
      );
    expect(find(false)).toMatchObject({ accelerator: 'Mod+T', enabled: true });
    expect(find(true)).toMatchObject({ accelerator: null });
  });

  it('greys every action while a dialog is open', () => {
    const all = items(toNativeSpec(source(), 'macos', { blocked: true }).menus);
    expect(all.filter((n) => n.kind === 'item').every((n) => !n.enabled)).toBe(true);
    // the items of the OS stay: copy and paste work in a dialog
    expect(all.some((n) => n.kind === 'predefined')).toBe(true);
  });

  it('builds the menu again only when its structure changed', () => {
    let on = true;
    let ticked = false;
    const src = source({
      canRun: (id: ActionId) => id !== 'TX_COMMIT' || on,
      isChecked: (id: ActionId) => (id === 'TOGGLE_RESULT' ? ticked : undefined),
    });
    const before = toNativeSpec(src, 'macos');
    on = false;
    ticked = true;
    const after = toNativeSpec(src, 'macos');
    expect(nativeStructureKey(after)).toBe(nativeStructureKey(before));
    expect(stateChanges(nativeStates(before), nativeStates(after))).toEqual([
      { id: 'TOGGLE_RESULT', enabled: true, checked: true },
      { id: 'TX_COMMIT', enabled: false, checked: null },
    ]);
    expect(stateChanges(nativeStates(after), nativeStates(after))).toEqual([]);
    // another language or another shortcut is another menu
    setLanguage('en');
    expect(nativeStructureKey(toNativeSpec(src, 'macos'))).not.toBe(nativeStructureKey(after));
    setLanguage('de');
    const rebound = source({ shortcuts: () => ['Mod+Y'] });
    expect(nativeStructureKey(toNativeSpec(rebound, 'macos'))).not.toBe(nativeStructureKey(after));
  });

  it('stays inside the limits of the backend', () => {
    const spec = toNativeSpec(source(), 'macos');
    const count = (nodes: readonly NativeMenuNode[]): number =>
      nodes.reduce((n, node) => n + 1 + (node.kind === 'submenu' ? count(node.items) : 0), 0);
    expect(count(spec.menus)).toBeLessThan(600);
    for (const node of items(spec.menus)) {
      if (node.kind === 'item') expect(node.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('cleans labels', () => {
    expect(nativeLabel('  Zeile\n\tzwei\u0007 ')).toBe('Zeile zwei');
    expect(nativeLabel('')).toBe('?');
    expect([...nativeLabel('x'.repeat(500))].length).toBe(120);
  });
});
