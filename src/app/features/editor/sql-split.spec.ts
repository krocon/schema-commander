import { offsetOf, splitStatements, statementAt } from './sql-split';

describe('splitStatements', () => {
  it('splits at semicolons and drops empty parts', () => {
    expect(splitStatements('select 1; select 2;;\n').map((s) => s.text)).toEqual([
      'select 1',
      'select 2',
    ]);
  });

  it('ignores semicolons in strings, quoted names and comments', () => {
    const script = `select 'a;b', "c;d", \`e;f\` -- no; split\nfrom t /* nor; here */; select 'it''s; fine'`;
    expect(splitStatements(script).map((s) => s.text)).toEqual([
      `select 'a;b', "c;d", \`e;f\` -- no; split\nfrom t /* nor; here */`,
      `select 'it''s; fine'`,
    ]);
  });

  it('survives unterminated strings and comments', () => {
    expect(splitStatements("select 'open; x").length).toBe(1);
    expect(splitStatements('select 1 /* open; x').length).toBe(1);
  });
});

describe('statementAt', () => {
  const script = 'select 1;\nselect 2;\n\nselect 3';

  it('finds the statement of a line and column', () => {
    expect(statementAt(script, offsetOf(script, 1, 3))?.text).toBe('select 1');
    expect(statementAt(script, offsetOf(script, 2, 1))?.text).toBe('select 2');
    expect(statementAt(script, offsetOf(script, 4, 9))?.text).toBe('select 3');
  });

  it('takes the statement in front of a caret right behind its semicolon', () => {
    expect(statementAt(script, offsetOf(script, 1, 10))?.text).toBe('select 1');
  });

  it('takes the next statement on an empty line, the last one at the end', () => {
    expect(statementAt(script, offsetOf(script, 3, 1))?.text).toBe('select 3');
    expect(statementAt('select 1;\n\n', 11)?.text).toBe('select 1');
    expect(statementAt('  ', 0)).toBeNull();
  });
});

describe('offsetOf', () => {
  it('clamps beyond the text', () => {
    expect(offsetOf('ab\ncd', 2, 2)).toBe(4);
    expect(offsetOf('ab\ncd', 9, 1)).toBe(5);
  });
});
