import { TOKEN_NAMES } from '../../core/theme/tokens';
import { EDITOR_COLORS } from './editor-colors';

/** The variables `editlicious-editor` 1.2 documents (README „Colour variables“) as far as we map them. */
const DOCUMENTED = /^--(ed|syn|color)-[a-z0-9-]+$|^--font-editor$/;

describe('EDITOR_COLORS', () => {
  it('maps documented editor variables onto catalog tokens only', () => {
    for (const [name, value] of Object.entries(EDITOR_COLORS)) {
      expect(name, name).toMatch(DOCUMENTED);
      const tokens = [...value.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
      expect(tokens.length, `${name}: ${value}`).toBe(1);
      expect(TOKEN_NAMES.has(tokens[0]), `${name}: ${tokens[0]}`).toBe(true);
    }
  });

  it('covers text area, gutter, syntax and the bars of the editor', () => {
    for (const name of [
      '--ed-bg',
      '--ed-text',
      '--ed-gutter-bg',
      '--ed-selection',
      '--ed-caret',
      '--syn-keyword',
      '--syn-string',
      '--syn-number',
      '--syn-comment',
      '--color-surface',
      '--color-accent',
    ]) {
      expect(EDITOR_COLORS[name], name).toBeTruthy();
    }
  });

  it('never paints selection or matches solid', () => {
    for (const name of ['--ed-selection', '--ed-search-match', '--ed-search-current']) {
      expect(EDITOR_COLORS[name]).toContain('transparent');
    }
  });
});
