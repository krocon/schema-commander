import { computed } from '@angular/core';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/i18n';
import { ACTIONS, ACTION_GROUPS, ACTION_IDS } from './action-catalog';
import { ACTION_GROUPS_DE, ACTION_LABELS_DE } from './action-catalog.de';
import { actionLabel, groupLabel } from './action-texts';
import { reservedReason, resolveKeymap } from './keymap';
import { formatShortcut } from './shortcut';

describe('action texts', () => {
  afterEach(() => setLanguage('de'));

  it('has a German name for every action and every group, and no others', () => {
    expect(Object.keys(ACTION_LABELS_DE).sort()).toEqual([...ACTION_IDS].sort());
    expect(Object.keys(ACTION_GROUPS_DE).sort()).toEqual([...ACTION_GROUPS].sort());
    for (const text of [...Object.values(ACTION_LABELS_DE), ...Object.values(ACTION_GROUPS_DE)]) {
      expect(text.trim()).not.toBe('');
    }
  });

  it('follows the language, also inside a computed', () => {
    const label = computed(() => actionLabel('TOGGLE_SIDEBAR'));
    const group = computed(() => groupLabel('View'));
    expect(label()).toBe('Seitenleiste ein-/ausblenden');
    expect(group()).toBe('Ansicht');
    setLanguage('en');
    expect(label()).toBe('Show or hide the sidebar');
    expect(group()).toBe('View');
    // English is the catalog itself
    for (const a of ACTIONS) expect(actionLabel(a.id)).toBe(a.label);
  });

  it('names keys and the notices of the keymap in the current language', () => {
    expect(formatShortcut('Mod+Shift+Space', 'windows')).toBe('Strg+Umschalt+Leertaste');
    expect(reservedReason('Alt+F4', 'global', 'linux')).toBe('Fenster schließen');
    const german = resolveKeymap('linux', { NOPE: [] }).problems;
    expect(german).toContain('Unbekannte Aktion „NOPE“ in der eigenen Belegung, übergangen.');
    setLanguage('en');
    expect(formatShortcut('Mod+Shift+Space', 'windows')).toBe('Ctrl+Shift+Space');
    expect(formatShortcut('Space', 'macos')).toBe('Space');
    expect(reservedReason('Alt+F4', 'global', 'linux')).toBe('closes the window');
    const english = resolveKeymap('linux', { NOPE: [] }).problems;
    expect(english).toContain('Unknown action “NOPE” in your own bindings, skipped.');
  });
});
