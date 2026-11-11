import { DARK, LIGHT } from '../../core/theme/builtin-themes';
import { Theme } from '../../core/theme/theme.models';
import {
  copyName,
  draftOf,
  failingPairs,
  importDraft,
  nameProblem,
  newUserId,
  swatchHex,
  themeOf,
  tokenContrast,
  withBrightness,
} from './theme-editor-logic';

const OWN: Theme = {
  id: 'user-gruen',
  name: 'Grün',
  dark: true,
  tokens: { '--bg-app': '#001100', '--accent': '#00ff00' },
};

describe('scheme editor logic', () => {
  it('makes ids from names, unique and with the prefix', () => {
    expect(newUserId('Mein Schema – Grün!', new Set())).toBe('user-mein-schema-grun');
    expect(newUserId('Grün', new Set(['user-grun', 'user-grun-2']))).toBe('user-grun-3');
    expect(newUserId('日本', new Set())).toBe('user-schema');
    expect(newUserId('x'.repeat(300), new Set()).length).toBeLessThanOrEqual(64);
  });

  it('names copies', () => {
    expect(copyName('Dunkel', new Set(['Dunkel']))).toBe('Dunkel (Kopie)');
    expect(copyName('Dunkel (Kopie)', new Set(['Dunkel (Kopie)']))).toBe('Dunkel (Kopie 2)');
  });

  it('checks names', () => {
    expect(nameProblem('  ')).not.toBeNull();
    expect(nameProblem('x'.repeat(101))).not.toBeNull();
    expect(nameProblem('a\u0007b')).not.toBeNull();
    expect(nameProblem('Mein Schema')).toBeNull();
  });

  it('completes a scheme for editing and stores only what differs', () => {
    const draft = draftOf(OWN, LIGHT, DARK, OWN.id);
    expect(Object.keys(draft.tokens).length).toBe(Object.keys(DARK.tokens).length);
    expect(draft.tokens['--bg-app']).toBe('#001100');
    expect(draft.tokens['--text']).toBe(DARK.tokens['--text']);
    expect(themeOf(draft, OWN.id, LIGHT, DARK)).toEqual(OWN);
    // back to the base value = no longer stored
    const reset = { ...draft, tokens: { ...draft.tokens, '--accent': DARK.tokens['--accent'] } };
    expect(themeOf(reset, OWN.id, LIGHT, DARK).tokens).toEqual({ '--bg-app': '#001100' });
  });

  it('moves the own values onto the other base', () => {
    const light = withBrightness(draftOf(OWN, LIGHT, DARK, OWN.id), false, LIGHT, DARK);
    expect(light.dark).toBe(false);
    expect(light.tokens['--bg-app']).toBe('#001100');
    expect(light.tokens['--text']).toBe(LIGHT.tokens['--text']);
    expect(withBrightness(light, false, LIGHT, DARK)).toBe(light);
  });

  it('imports a scheme file and says what it dropped', () => {
    const { draft, dropped } = importDraft(
      {
        id: 'dark',
        name: 'Grün',
        dark: true,
        tokens: {
          '--bg-app': '#001100',
          '--text': 'red; background: url(x)',
          '--ge-table-bg': '#ffffff',
          '--accent': 42,
        },
      },
      LIGHT,
      DARK,
      new Set(['Grün']),
    );
    expect(draft?.id).toBeNull();
    expect(draft?.name).toBe('Grün (Kopie)');
    expect(draft?.tokens['--bg-app']).toBe('#001100');
    expect(draft?.tokens['--text']).toBe(DARK.tokens['--text']);
    expect([...dropped].sort()).toEqual(['--accent', '--ge-table-bg', '--text']);
  });

  it('guesses the brightness and the name when a file leaves them out', () => {
    const light = importDraft({ tokens: { '--bg-app': '#fafafa' } }, LIGHT, DARK, new Set());
    expect(light.draft?.dark).toBe(false);
    expect(light.draft?.name).toBe('Importiertes Schema');
    expect(
      importDraft({ tokens: { '--bg-app': '#101010' } }, LIGHT, DARK, new Set()).draft?.dark,
    ).toBe(true);
  });

  it('refuses what is no scheme', () => {
    for (const raw of [null, 'x', [1], {}, { tokens: [] }, { tokens: 'x' }]) {
      expect(importDraft(raw, LIGHT, DARK, new Set()).draft, JSON.stringify(raw)).toBeNull();
    }
  });

  it('finds the weakest contrast pair of a token', () => {
    expect(failingPairs(DARK.tokens)).toBe(0);
    const weak = { ...DARK.tokens, '--text': '#333333' };
    const c = tokenContrast('--text', weak);
    expect(c?.ok).toBe(false);
    expect(c?.min).toBe(4.5);
    expect(failingPairs(weak)).toBeGreaterThan(0);
    expect(tokenContrast('--chart-grid', DARK.tokens)).toBeNull();
    expect(tokenContrast('--text', DARK.tokens)?.ok).toBe(true);
  });

  it('gives the colour picker a plain hex value', () => {
    expect(swatchHex('--bg-app', { '--bg-app': 'rgb(1 2 3 / 50%)' })).toBe('#010203');
    expect(swatchHex('--bg-app', { '--bg-app': 'var(--text)', '--text': '#ABCDEF' })).toBe(
      '#abcdef',
    );
    expect(swatchHex('--bg-app', {})).toBe('#000000');
  });
});
