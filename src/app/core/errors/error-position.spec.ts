import { describe, expect, it } from 'vitest';
import { ErrorDetails, toAppError } from './app-error';
import cases from './error-position.cases.json';
import { errorRange, errorSpan, offsetOfCharacter, placeOf } from './error-position';

interface Case {
  name: string;
  sql: string;
  details: ErrorDetails | null;
  /** The text that must be marked. */
  marked: string;
  exact: boolean;
  /** Where the statement starts in the editor (default: line 1, column 1). */
  start?: [number, number];
  /** The range of the editor: start line, column, end line, column. */
  range?: [number, number, number, number];
}

describe('where a failed statement is marked (catalog)', () => {
  for (const c of cases as Case[]) {
    it(c.name, () => {
      const span = errorSpan(c.sql, c.details);
      expect(c.sql.slice(span.from, span.to)).toBe(c.marked);
      expect(span.exact).toBe(c.exact);
      if (c.range) {
        const start = c.start ? { line: c.start[0], ch: c.start[1] } : { line: 1, ch: 1 };
        const r = errorRange(c.sql, start, c.details);
        expect([r.start.line, r.start.ch, r.end.line, r.end.ch]).toEqual(c.range);
      }
    });
  }

  it('counts characters as the databases do and units as the editor does', () => {
    expect(offsetOfCharacter('a😀b', 1)).toBe(0);
    expect(offsetOfCharacter('a😀b', 2)).toBe(1);
    expect(offsetOfCharacter('a😀b', 3)).toBe(3);
    expect(offsetOfCharacter('a😀b', 99)).toBe(4);
    expect(placeOf('ab\ncd', { line: 5, ch: 10 }, 1)).toEqual({ line: 5, ch: 11 });
    expect(placeOf('ab\ncd', { line: 5, ch: 10 }, 4)).toEqual({ line: 6, ch: 2 });
  });
});

describe('the details of an error', () => {
  it('are read as far as they are what they must be', () => {
    const e = toAppError({
      code: 'invalid_query',
      message: 'column "nmae" does not exist (42703)',
      details: {
        sqlstate: '42703',
        hint: 'Perhaps you meant "name".',
        position: 8,
        line: -1,
        detail: 7,
        somethingElse: 'x',
        constraint: '',
      },
    });
    expect(e.details).toEqual({
      sqlstate: '42703',
      hint: 'Perhaps you meant "name".',
      position: 8,
    });
    // an error of the app itself has none
    expect(toAppError({ code: 'io', message: 'x' }).details).toBeUndefined();
    expect(toAppError({ code: 'io', message: 'x', details: {} }).details).toBeUndefined();
    expect(toAppError({ code: 'io', message: 'x', details: 'nope' }).details).toBeUndefined();
  });
});
