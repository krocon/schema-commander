import { DEFAULT_SETTINGS, mergeSettings } from './settings.models';

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
