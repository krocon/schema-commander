import { DEFAULT_SETTINGS } from '../../core/settings/settings.models';
import { mapOffset, offsetAt, placeIn, styleOf, toggleComment, trimmedSpan } from './format-logic';

describe('format-logic', () => {
  it('takes the style from the settings', () => {
    expect(styleOf({ ...DEFAULT_SETTINGS, formatIndent: 2, formatComma: 'leading' })).toEqual({
      keywordCase: 'upper',
      indent: 2,
      comma: 'leading',
      width: 100,
      andOr: 'leading',
      blankLines: 1,
    });
  });

  describe('places', () => {
    it('counts lines from 1 and columns in code points', () => {
      const text = 'a😀b\r\nçd\nxyz';
      expect(placeIn(text, 0)).toEqual({ line: 1, ch: 1 });
      // behind the emoji: three UTF-16 units, two characters
      expect(placeIn(text, 3)).toEqual({ line: 1, ch: 3 });
      expect(placeIn(text, text.indexOf('d'))).toEqual({ line: 2, ch: 2 });
      expect(placeIn(text, text.length)).toEqual({ line: 3, ch: 4 });
      expect(placeIn(text, 999)).toEqual({ line: 3, ch: 4 });
    });

    it('starts where the piece starts in the editor', () => {
      const start = { line: 7, ch: 5 };
      expect(placeIn('😀x\ny', 2, start)).toEqual({ line: 7, ch: 6 });
      expect(placeIn('😀x\ny', 4, start)).toEqual({ line: 8, ch: 1 });
    });

    it('finds the offset of a place and is the inverse of placeIn', () => {
      const text = 'a😀b\r\nçd\nxyz';
      for (const offset of [0, 1, 3, 4, 7, 8, 10, text.length]) {
        expect(offsetAt(text, placeIn(text, offset))).toBe(offset);
      }
      expect(offsetAt(text, { line: 9, ch: 1 })).toBe(text.length);
      // a column behind the end of a line stays in the line
      expect(offsetAt('ab\ncd', { line: 1, ch: 99 })).toBe(2);
    });

    it('finds the text without the blanks around it', () => {
      expect(trimmedSpan('  select 1 \n')).toEqual({ from: 2, to: 10 });
      expect(trimmedSpan('   ')).toEqual({ from: 3, to: 3 });
    });
  });

  describe('the caret after formatting', () => {
    const before = "select a,b from t where x='a  b'";
    const after = "SELECT a, b\nFROM t\nWHERE x = 'a  b'";

    it('stays behind the same characters', () => {
      // behind `a,`
      expect(mapOffset(before, after, 9)).toBe(after.indexOf(',') + 1);
      // inside the string, where blanks are text
      expect(mapOffset(before, after, before.indexOf("  b'") + 2)).toBe(after.indexOf("  b'") + 2);
      expect(mapOffset(before, after, before.length)).toBe(after.length);
      expect(mapOffset(before, after, 999)).toBe(after.length);
    });

    it('stays before the word it stood before', () => {
      expect(mapOffset(before, after, before.indexOf('from'))).toBe(after.indexOf('FROM'));
      expect(mapOffset(before, after, 0)).toBe(0);
      expect(mapOffset('  select 1', 'SELECT 1', 2)).toBe(0);
      // behind a word, before a blank: behind that word
      expect(mapOffset(before, after, before.indexOf(' from'))).toBe(after.indexOf('\nFROM'));
    });
  });

  describe('toggleComment', () => {
    it('comments lines out where the least indented one starts', () => {
      expect(toggleComment('  select a\n    , b\n\n  from t', 'postgres')).toBe(
        '  -- select a\n  --   , b\n\n  -- from t',
      );
    });

    it('comments in again when every line with text is a comment', () => {
      expect(toggleComment('  -- select a\n  --   , b\n\n  --from t', 'postgres')).toBe(
        '  select a\n    , b\n\n  from t',
      );
    });

    it('is its own inverse and keeps the line breaks', () => {
      const text = 'select 1\r\n  from t\r\n';
      const out = toggleComment(text, 'sqlserver');
      expect(out).toBe('-- select 1\r\n--   from t\r\n');
      expect(toggleComment(out, 'sqlserver')).toBe(text);
    });

    it('comments a mixed block out as a whole', () => {
      expect(toggleComment('-- a\nb', 'sqlite')).toBe('-- -- a\n-- b');
    });

    it('knows # in MySQL only', () => {
      expect(toggleComment('# a', 'mysql')).toBe('a');
      expect(toggleComment('# a', 'postgres')).toBe('-- # a');
    });

    it('leaves empty text alone', () => {
      expect(toggleComment(' \n', 'postgres')).toBe(' \n');
    });
  });
});
