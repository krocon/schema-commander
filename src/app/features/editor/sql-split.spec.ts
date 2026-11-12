import catalog from './sql-split.cases.json';
import {
  Dialect,
  offsetOf,
  positionOf,
  splitForRun,
  splitStatements,
  statementAt,
} from './sql-split';

const DIALECTS: Dialect[] = [
  'postgres',
  'mysql',
  'sqlserver',
  'sqlite',
  'oracle',
  'duckdb',
  'clickhouse',
  'trino',
];

describe('splitStatements (catalog)', () => {
  for (const c of catalog.cases) {
    const dialects = c.dialect === 'all' ? DIALECTS : [c.dialect as Dialect];
    for (const dialect of dialects) {
      it(`${dialect}: ${c.name}`, () => {
        expect(splitStatements(c.script, dialect).map((s) => s.text)).toEqual(c.statements);
      });
    }
  }
});

describe('splitStatements', () => {
  it('says where each statement stands', () => {
    const script = '  select 1 ;\n\n select 2';
    const [a, b] = splitStatements(script, 'postgres');
    expect(script.slice(a.start, a.end)).toBe('select 1 ');
    expect(script[a.end]).toBe(';');
    expect(script.slice(b.start, b.end)).toBe('select 2');
  });

  it('is quick on a big script', () => {
    const script = "insert into t values (1, 'a;b', $$c;d$$);\n".repeat(50_000);
    const started = performance.now();
    expect(splitStatements(script, 'postgres').length).toBe(50_000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('splitForRun', () => {
  it('sends SQL Server scripts batch by batch', () => {
    const script =
      'declare @n int = 1; select @n;\nGO\ncreate view v as select 1 as one\ngo 2\n-- nur ein Kommentar\nGO\nselect * from v';
    expect(splitForRun(script, 'sqlserver').map((s) => s.text)).toEqual([
      'declare @n int = 1; select @n;',
      'create view v as select 1 as one',
      'select * from v',
    ]);
  });

  it('sends other scripts statement by statement', () => {
    expect(splitForRun('select 1; select 2', 'postgres').map((s) => s.text)).toEqual([
      'select 1',
      'select 2',
    ]);
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

  it('takes a whole function when the caret is inside its body', () => {
    const fn =
      'select 1;\ncreate function f() returns int as $$\nbegin\n  return 1;\nend;\n$$ language plpgsql;\nselect 2';
    expect(statementAt(fn, offsetOf(fn, 4, 5), 'postgres')?.text).toContain('create function');
    expect(statementAt(fn, offsetOf(fn, 4, 5), 'postgres')?.text).toContain('language plpgsql');
  });
});

describe('offsetOf', () => {
  it('clamps beyond the text', () => {
    expect(offsetOf('ab\ncd', 2, 2)).toBe(4);
    expect(offsetOf('ab\ncd', 9, 1)).toBe(5);
  });

  it('takes the column as the editor counts it: an emoji is one', () => {
    const script = "select '😀😀'; select 2;\nselect '😀' ; select 4";
    // column 14 of line 1 is the `s` of `select 2` – 15 UTF-16 units into the text
    expect(offsetOf(script, 1, 14)).toBe(15);
    expect(statementAt(script, offsetOf(script, 1, 16))?.text).toBe('select 2');
    expect(offsetOf(script, 2, 13)).toBe(script.indexOf(' ; select 4') + 2);
    // a column behind the end of its line stays in the line
    expect(offsetOf('ab\ncd', 1, 99)).toBe(2);
  });
});

describe('positionOf', () => {
  it('answers in lines and columns of the editor and is the inverse of offsetOf', () => {
    const script = "select '😀😀'; select 2;\nselect '😀' ; select 4";
    expect(positionOf(script, script.indexOf('select 2'))).toEqual({ line: 1, ch: 14 });
    expect(positionOf(script, script.indexOf('select 4'))).toEqual({ line: 2, ch: 14 });
    expect(positionOf(script, script.indexOf('select 4'), 10)).toEqual({ line: 11, ch: 14 });
    for (const offset of [0, 7, 8, 10, 14, 26, 35, script.length]) {
      const at = positionOf(script, offset);
      expect(offsetOf(script, at.line, at.ch)).toBe(offset);
    }
  });
});
