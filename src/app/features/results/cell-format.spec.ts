/* eslint-disable no-control-regex -- control characters are what this file is about */
import { Cell, ColKind } from '../../core/sql/query.models';
import cases from './cell-format.cases.json';
import {
  SHOWN_CHARS,
  byteSize,
  cut,
  defuse,
  groupDigits,
  showCell,
  typeLabel,
} from './cell-format';

interface Case {
  name: string;
  cell: unknown;
  kind: string;
  group?: boolean;
  text: string;
  cls: string;
}

describe('showCell', () => {
  for (const c of cases as Case[]) {
    it(c.name, () => {
      expect(
        showCell(c.cell as Cell, c.kind as ColKind, { groupDigits: c.group === true }),
      ).toEqual({ text: c.text, cls: c.cls });
    });
  }

  it('NULL, the empty text and the text NULL are three different pictures', () => {
    const shown = [null, '', 'NULL'].map((cell) => showCell(cell, 'text'));
    const pictures = new Set(shown.map((s) => `${s.text}|${s.cls}`));
    expect(pictures.size).toBe(3);
  });

  it('cuts a long text and says so', () => {
    const shown = showCell('x'.repeat(5000), 'text').text;
    expect(shown).toHaveLength(SHOWN_CHARS + 1);
    expect(shown.endsWith('…')).toBe(true);
  });
});

describe('cut', () => {
  it('leaves a short text alone', () => {
    expect(cut('abc', 3)).toBe('abc');
  });

  it('never cuts a character in two', () => {
    expect(cut('ab🙂cd', 3)).toBe('ab…');
    expect(cut('ab🙂cd', 4)).toBe('ab🙂…');
  });
});

describe('defuse', () => {
  it('returns plain text as it is', () => {
    const text = 'SELECT 1 -- ok';
    expect(defuse(text)).toBe(text);
  });

  it('works twice in a row (the pattern keeps no position)', () => {
    expect(defuse('a\nb')).toBe('a↵b');
    expect(defuse('a\nb')).toBe('a↵b');
  });

  it('leaves no character that reorders or hides text', () => {
    const all =
      Array.from({ length: 0x2070 }, (_, i) => String.fromCharCode(i)).join('') + '\ufeff';
    expect(defuse(all)).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
  });
});

describe('groupDigits', () => {
  it('groups whole numbers and the part before the point', () => {
    expect(groupDigits('1000')).toBe('1\u202f000');
    expect(groupDigits('-1234567.1234567')).toBe('-1\u202f234\u202f567.1234567');
  });

  it('leaves everything else', () => {
    for (const s of ['999', '1e+21', 'Infinity', '12a45', '']) expect(groupDigits(s)).toBe(s);
  });
});

describe('byteSize', () => {
  it('names the unit', () => {
    expect(byteSize(0)).toBe('0 B');
    expect(byteSize(1023)).toBe('1023 B');
    expect(byteSize(1536)).toBe('1,5 kB');
    expect(byteSize(20 * 1024 * 1024)).toBe('20 MB');
  });
});

describe('typeLabel', () => {
  it('is lower case and short', () => {
    expect(typeLabel('VARCHAR')).toBe('varchar');
    expect(typeLabel('')).toBe('');
    expect(typeLabel('X'.repeat(40))).toHaveLength(25);
  });
});
