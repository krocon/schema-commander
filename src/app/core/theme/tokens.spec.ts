import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/i18n';
import { THEME_LABELS_DE } from './theme-labels.de';
import { THEME_LABEL_SOURCES, tokenDef } from './tokens';

describe('token labels', () => {
  afterEach(() => setLanguage('de'));

  it('has a German text for every English name of a token or group, and no others', () => {
    expect(Object.keys(THEME_LABELS_DE).sort()).toEqual([...THEME_LABEL_SOURCES].sort());
  });

  it('reads label and group in the current language', () => {
    const def = tokenDef('--bg-app')!;
    expect(def.label).toBe('Hintergrund (Editor, Ergebnis)');
    expect(def.groupLabel).toBe('Flächen');
    expect(def.group).toBe('Surfaces');
    setLanguage('en');
    expect(def.label).toBe('Background (editor, result)');
    expect(def.groupLabel).toBe('Surfaces');
    expect(tokenDef('--conn-3')!.label).toBe('Connection colour 3');
  });
});
