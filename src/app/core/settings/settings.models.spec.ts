import { DEFAULT_SETTINGS, mergeKeymap, mergeSettings } from './settings.models';

describe('mergeSettings', () => {
  it('falls back to the defaults for nothing or nonsense', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ sidebarWidth: 'wide', resultHeight: -5, sidebarVisible: 1 })).toEqual(
      DEFAULT_SETTINGS,
    );
  });

  it('keeps valid values', () => {
    const s = mergeSettings({
      sidebarWidth: 300.4,
      resultHeight: 120,
      sidebarVisible: false,
      themeSelection: { mode: 'fixed', theme: 'one-dark', light: 'light', dark: 'dark' },
    });
    expect(s.sidebarWidth).toBe(300);
    expect(s.resultHeight).toBe(120);
    expect(s.sidebarVisible).toBe(false);
    expect(s.themeSelection.theme).toBe('one-dark');
  });
});

describe('the style of the formatter (prompt 023)', () => {
  it('keeps what is valid and falls back for the rest', () => {
    const s = mergeSettings({
      formatKeywordCase: 'preserve',
      formatIndent: 2,
      formatComma: 'leading',
      formatWidth: 80,
      formatAndOr: 'trailing',
      formatBlankLines: 0,
    });
    expect(s.formatKeywordCase).toBe('preserve');
    expect(s.formatIndent).toBe(2);
    expect(s.formatComma).toBe('leading');
    expect(s.formatWidth).toBe(80);
    expect(s.formatAndOr).toBe('trailing');
    expect(s.formatBlankLines).toBe(0);
    const broken = mergeSettings({
      formatKeywordCase: 'Title',
      formatIndent: 0,
      formatComma: 'middle',
      formatWidth: 39,
      formatAndOr: 1,
      formatBlankLines: 4,
    });
    expect(broken).toEqual(DEFAULT_SETTINGS);
  });
});

describe('mergeKeymap', () => {
  it('keeps well-formed own shortcuts, bounded', () => {
    const { keymap, notice } = mergeKeymap({
      version: 1,
      bindings: { TOGGLE_SIDEBAR: ['Mod+Shift+B', 7, 'x'.repeat(100)], BROKEN: 'Mod+B' },
    });
    expect(notice).toBeNull();
    expect(keymap.bindings['TOGGLE_SIDEBAR']).toEqual(['Mod+Shift+B', 'x'.repeat(60)]);
    expect(keymap.bindings['BROKEN']).toBeUndefined();
  });

  it('falls back to the defaults with a notice for a broken value', () => {
    for (const raw of ['x', [], { version: 2, bindings: {} }, { version: 1, bindings: [] }]) {
      const { keymap, notice } = mergeKeymap(raw);
      expect(keymap.bindings, JSON.stringify(raw)).toEqual({});
      expect(notice, JSON.stringify(raw)).toContain('nicht lesbar');
    }
    expect(mergeKeymap(undefined).notice).toBeNull();
  });

  it('keeps only plausible recently used action ids', () => {
    const s = mergeSettings({ recentActions: ['COLOR_SCHEME', 'nope', 3, 'X'.repeat(80)] });
    expect(s.recentActions).toEqual(['COLOR_SCHEME']);
  });

  it('keeps the places of the tables of a diagram, and only what has their shape (prompt 037)', () => {
    const merged = mergeSettings({
      diagramPlaces: {
        'demo|public|': { a: [10.4, -20], b: [1, 'x'], c: [1, 2, 3], d: [Infinity, 0], e: 'no' },
        nonsense: 'x',
        list: [1, 2],
      },
    });
    expect(merged.diagramPlaces).toEqual({ 'demo|public|': { a: [10, -20] } });
    expect(mergeSettings({ diagramPlaces: 'x' }).diagramPlaces).toEqual({});
  });
});
