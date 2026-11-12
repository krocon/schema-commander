import { Dialect } from '../editor/sql-split';
import {
  DEFAULT_FORMS,
  PARAM_FORMS,
  ParamForm,
  bind,
  describeValue,
  findParams,
  formsOf,
  guess,
  listItems,
  paramKeys,
  resolve,
  writtenPosition,
} from './param-logic';

const keys = (sql: string, dialect: Dialect, forms?: readonly ParamForm[]) =>
  findParams(sql, dialect, forms ?? DEFAULT_FORMS[dialect]).map((u) => u.key);

describe('finding parameters (catalog)', () => {
  const cases: [string, Dialect, string, string[]][] = [
    [
      'named with a colon',
      'postgres',
      'select * from t where a = :kunde and b >= :ab',
      ['kunde', 'ab'],
    ],
    ['the same name twice', 'postgres', 'select :a, :a + 1', ['a', 'a']],
    ['glued to an operator or a bracket', 'postgres', 'select (:a),b=:b', ['a', 'b']],
    ['umlauts and digits in a name', 'mysql', 'select :größe_2', ['größe_2']],
    ['braces', 'mysql', 'select ${name}, ${other_1}', ['name', 'other_1']],
    ['numbered in PostgreSQL', 'postgres', 'select $1, $2 where x = $1', ['$1', '$2', '$1']],
    ['question marks count per statement', 'mysql', 'select ? + ?', ['?1', '?2']],
    ['all forms of SQLite', 'sqlite', 'select :a, @b, $c, ?, ${d}', ['a', 'b', 'c', '?1', 'd']],
    // --- what is none
    ['a cast is none', 'postgres', "select '2026-01-01'::date, x::text, :a::int", ['a']],
    ['an assignment is none', 'mysql', 'select @a := 1, b :=2', []],
    ['a slice of an array is none', 'postgres', 'select arr[1:n], arr[lo:hi], m[:k]', ['k']],
    ['a time is none', 'postgres', "select time '12:30:00', 12:30", []],
    [
      'in a string, a comment or a quoted name is none',
      'postgres',
      'select \':a\', ":b", $$ :c $$ -- :d\n/* :e */ from t',
      [],
    ],
    [
      'in a string of MySQL with an escaped quote',
      'mysql',
      "select 'it\\'s :a', `:b`, :c # :d",
      ['c'],
    ],
    [
      'a JSON operator of PostgreSQL is none',
      'postgres',
      "select j ? 'key', j ?| array['a'], j ?& array['b'], j->>'k'",
      [],
    ],
    ['a variable of MySQL is none', 'mysql', 'select @@version, @rownum, @a + 1', []],
    [
      'a variable of SQL Server is none',
      'sqlserver',
      'declare @id int = 1; select @@rowcount, @id',
      [],
    ],
    [
      'a bracket name of SQL Server holds none',
      'sqlserver',
      'select [:a], [?] from t where x = :b',
      ['b'],
    ],
    ['a dollar name is none in PostgreSQL', 'postgres', 'select $name, 5$', []],
    ['a lonely sign is none', 'sqlite', 'select : a, $ b, @, ${ c }', []],
    ['a number behind a colon is none', 'postgres', 'select :1, :a1', ['a1']],
  ];
  for (const [name, dialect, sql, expected] of cases) {
    it(`${dialect}: ${name}`, () => expect(keys(sql, dialect)).toEqual(expected));
  }

  it('says where a parameter stands', () => {
    const sql = "select '😀', :kunde, ${ab}";
    expect(
      findParams(sql, 'postgres', DEFAULT_FORMS.postgres).map((u) => sql.slice(u.start, u.end)),
    ).toEqual([':kunde', '${ab}']);
  });

  it('Oracle: :name is a value, := and the :new / :old of a trigger are not', () => {
    const sql =
      'begin if :new.total <> :old.total then x := :limit; end if; select :new from dual; end;';
    expect(
      findParams(sql, 'oracle', DEFAULT_FORMS.oracle).map((u) => sql.slice(u.start, u.end)),
    ).toEqual([':limit', ':new']);
    // a q-quote is one string: nothing in it is a value (review 035b 8)
    expect(
      findParams("select q'[it's :x]', :y from dual", 'oracle', DEFAULT_FORMS.oracle).map(
        (u) => u.key,
      ),
    ).toEqual(['y']);
    // a question mark means nothing there unless the user says so
    expect(findParams('select ? from dual', 'oracle', DEFAULT_FORMS.oracle)).toEqual([]);
  });

  it('takes the forms a connection is set to', () => {
    // `?` switched on for PostgreSQL: now it is a parameter – but the operators stay operators
    expect(keys("select ?, j ?| array['a']", 'postgres', ['question'])).toEqual(['?1']);
    // `@name` on SQL Server: parameters, except what the statement declares or sets itself
    const sql = 'declare @n int, @m int; set @k = 1; select @id, @n, @m, @k, @@rowcount';
    expect(keys(sql, 'sqlserver', ['at'])).toEqual(['id']);
    expect(keys('select @a := 1, @b', 'mysql', ['at'])).toEqual(['b']);
    expect(keys('select :a, ?', 'mysql', [])).toEqual([]);
    expect(formsOf('postgres', undefined)).toEqual(DEFAULT_FORMS.postgres);
    expect(formsOf('postgres', ['question', 'nonsense', 'colon'])).toEqual(['colon', 'question']);
    expect(formsOf('postgres', [])).toEqual([]);
    for (const dialect of ['postgres', 'mysql', 'sqlserver', 'sqlite'] as const) {
      expect(DEFAULT_FORMS[dialect].every((f) => PARAM_FORMS.includes(f))).toBe(true);
    }
  });

  it('knows a parameter that stands alone in the brackets of an IN', () => {
    const uses = findParams(
      'select * from t where a in (:ids) and b in (:x, :y) and c = (:z)',
      'postgres',
      ['colon'],
    );
    expect(uses.map((u) => [u.key, u.list])).toEqual([
      ['ids', true],
      ['x', false],
      ['y', false],
      ['z', false],
    ]);
    const bound = bind('select * from t where a IN (:ids) or b = :ids', 'postgres', ['colon'], {
      ids: { type: 'auto', text: '1, 2' },
    });
    // a list in the IN, the text as it is elsewhere
    expect(bound.ok && bound.statement.sql).toBe('select * from t where a IN ($1, $2) or b = $3');
    expect(bound.ok && bound.statement.params).toEqual([
      { kind: 'int', value: '1' },
      { kind: 'int', value: '2' },
      { kind: 'text', value: '1, 2' },
    ]);
  });

  it('lists the parameters of a script once, in their order', () => {
    expect(
      paramKeys(['select :b, :a', 'select :a, :c'], 'postgres', DEFAULT_FORMS.postgres),
    ).toEqual(['b', 'a', 'c']);
  });
});

describe('what a value is', () => {
  it('reads numbers, dates and booleans off a text – only when they are written as such', () => {
    expect(guess('42')).toEqual({ kind: 'int', value: '42' });
    expect(guess('-3.50')).toEqual({ kind: 'decimal', value: '-3.50' });
    expect(guess('0123')).toEqual({ kind: 'text', value: '0123' });
    expect(guess('1e5')).toEqual({ kind: 'text', value: '1e5' });
    expect(guess('true')).toEqual({ kind: 'bool', value: true });
    expect(guess('2026-11-11')).toEqual({ kind: 'date', value: '2026-11-11' });
    expect(guess('2026-11-11T08:05')).toEqual({ kind: 'datetime', value: '2026-11-11 08:05:00' });
    expect(guess('2026-13-01')).toEqual({ kind: 'text', value: '2026-13-01' });
    expect(guess('11.11.2026')).toEqual({ kind: 'text', value: '11.11.2026' });
    expect(guess("'; DROP TABLE x; --")).toEqual({ kind: 'text', value: "'; DROP TABLE x; --" });
    expect(guess('')).toEqual({ kind: 'text', value: '' });
  });

  it('takes a chosen type at its word and says when the text is none', () => {
    expect(resolve({ type: 'text', text: '42' })).toEqual({
      ok: true,
      values: [{ kind: 'text', value: '42' }],
    });
    expect(resolve({ type: 'number', text: ' +007 ' })).toEqual({
      ok: true,
      values: [{ kind: 'int', value: '7' }],
    });
    expect(resolve({ type: 'number', text: '.5' })).toEqual({
      ok: true,
      values: [{ kind: 'decimal', value: '0.5' }],
    });
    // more digits than an i64 holds: exact as a decimal
    expect(resolve({ type: 'number', text: '12345678901234567890' })).toEqual({
      ok: true,
      values: [{ kind: 'decimal', value: '12345678901234567890' }],
    });
    expect(resolve({ type: 'number', text: '12,5' })).toEqual({ ok: false, problem: 'number' });
    expect(resolve({ type: 'date', text: '1.2.2026' })).toEqual({
      ok: true,
      values: [{ kind: 'date', value: '2026-02-01' }],
    });
    expect(resolve({ type: 'date', text: '11.11.2026 7:30:15.5' })).toEqual({
      ok: true,
      values: [{ kind: 'datetime', value: '2026-11-11 07:30:15.5' }],
    });
    expect(resolve({ type: 'date', text: 'gestern' })).toEqual({ ok: false, problem: 'date' });
    expect(resolve({ type: 'date', text: '2026-11-11 25:00' })).toEqual({
      ok: false,
      problem: 'date',
    });
    expect(resolve({ type: 'bool', text: 'Ja' })).toEqual({
      ok: true,
      values: [{ kind: 'bool', value: true }],
    });
    expect(resolve({ type: 'bool', text: 'vielleicht' })).toEqual({ ok: false, problem: 'bool' });
    expect(resolve({ type: 'null', text: 'whatever' })).toEqual({ ok: true, values: null });
  });

  it('reads a list by lines or commas: numbers only when every entry is one', () => {
    expect(listItems('1, 2,,3 ')).toEqual(['1', '2', '3']);
    expect(listItems('a, b\nc\n')).toEqual(['a, b', 'c']);
    expect(resolve({ type: 'list', text: '1, 2.5' })).toEqual({
      ok: true,
      values: [
        { kind: 'int', value: '1' },
        { kind: 'decimal', value: '2.5' },
      ],
    });
    expect(resolve({ type: 'list', text: '1, a' })).toEqual({
      ok: true,
      values: [
        { kind: 'text', value: '1' },
        { kind: 'text', value: 'a' },
      ],
    });
    expect(resolve({ type: 'list', text: ' ' })).toEqual({ ok: true, values: [] });
  });
});

describe('writing a statement for the driver', () => {
  const values = {
    kunde: { type: 'auto', text: '42' },
    ab: { type: 'date', text: '1.1.2026' },
    name: { type: 'auto', text: "'; DROP TABLE x; --" },
    ids: { type: 'list', text: '1, 2, 3' },
    preis: { type: 'number', text: '9.99' },
    nichts: { type: 'null', text: '' },
    leer: { type: 'list', text: '' },
  } as const;
  const sql =
    'select * from t where k = :kunde and d >= :ab and n = :name and id in (:ids) and p < :preis and x is :nichts and y in (:leer)';
  const bound = (dialect: Dialect) => {
    const b = bind(sql, dialect, DEFAULT_FORMS[dialect], values);
    if (!b.ok) throw new Error(`${b.key}: ${b.problem}`);
    return b.statement;
  };

  it('PostgreSQL: numbered placeholders, casts for decimals and dates', () => {
    const s = bound('postgres');
    expect(s.sql).toBe(
      'select * from t where k = $1 and d >= CAST($2 AS date) and n = $3 and id in ($4, $5, $6) and p < CAST($7 AS numeric) and x is NULL and y in (NULL)',
    );
    expect(s.params).toEqual([
      { kind: 'int', value: '42' },
      { kind: 'date', value: '2026-01-01' },
      { kind: 'text', value: "'; DROP TABLE x; --" },
      { kind: 'int', value: '1' },
      { kind: 'int', value: '2' },
      { kind: 'int', value: '3' },
      { kind: 'decimal', value: '9.99' },
    ]);
    // the value that looks like SQL is nowhere in the text
    expect(s.sql).not.toContain('DROP');
  });

  it('the other databases: their placeholders', () => {
    expect(bound('mysql').sql).toBe(
      'select * from t where k = ? and d >= CAST(? AS DATE) and n = ? and id in (?, ?, ?) and p < CAST(? AS DECIMAL(65,30)) and x is NULL and y in (NULL)',
    );
    expect(bound('sqlserver').sql).toBe(
      'select * from t where k = @P1 and d >= CAST(@P2 AS date) and n = @P3 and id in (@P4, @P5, @P6) and p < @P7 and x is NULL and y in (NULL)',
    );
    expect(bound('sqlite').sql).toBe(
      'select * from t where k = ?1 and d >= ?2 and n = ?3 and id in (?4, ?5, ?6) and p < ?7 and x is NULL and y in (NULL)',
    );
    expect(bound('sqlite').params.length).toBe(7);
    expect(bound('duckdb').sql).toBe(
      'select * from t where k = $1 and d >= CAST($2 AS DATE) and n = $3 and id in ($4, $5, $6) and p < CAST($7 AS DECIMAL(38,10)) and x is NULL and y in (NULL)',
    );
    // Trino: plain marks – the driver writes each value as a literal of its type
    expect(bound('trino').sql).toBe(
      'select * from t where k = ? and d >= ? and n = ? and id in (?, ?, ?) and p < ? and x is NULL and y in (NULL)',
    );
    // ClickHouse: the placeholder names a type
    expect(bound('clickhouse').sql).toBe(
      'select * from t where k = {p1:Int64} and d >= {p2:String} and n = {p3:String} and id in ({p4:Int64}, {p5:Int64}, {p6:Int64}) and p < {p7:String} and x is NULL and y in (NULL)',
    );
    // Oracle: numbered, no casts – the driver binds numbers and dates as what they are
    expect(bound('oracle').sql).toBe(
      'select * from t where k = :1 and d >= :2 and n = :3 and id in (:4, :5, :6) and p < :7 and x is NULL and y in (NULL)',
    );
  });

  it('a name used twice is bound twice; numbered and anonymous ones keep their order', () => {
    const twice = bind('select :a, :a', 'postgres', ['colon'], { a: { type: 'auto', text: 'x' } });
    expect(twice.ok && twice.statement.sql).toBe('select $1, $2');
    expect(twice.ok && twice.statement.params.length).toBe(2);
    const numbered = bind('select $2, $1', 'postgres', ['dollarNumber'], {
      $1: { type: 'auto', text: 'one' },
      $2: { type: 'auto', text: 'two' },
    });
    expect(numbered.ok && numbered.statement.params.map((p) => p.value)).toEqual(['two', 'one']);
    const anonymous = bind('select ?, ?', 'mysql', ['question'], {
      '?1': { type: 'auto', text: '1' },
      '?2': { type: 'auto', text: 'b' },
    });
    expect(anonymous.ok && anonymous.statement.params.map((p) => p.kind)).toEqual(['int', 'text']);
  });

  it('leaves a statement without parameters as it is', () => {
    const plain = "select '2026-01-01'::date, j ? 'k' -- :x";
    const b = bind(plain, 'postgres', DEFAULT_FORMS.postgres, {});
    expect(b).toEqual({ ok: true, statement: { sql: plain, params: [], replaced: [] } });
  });

  it('says which parameter has no value or a wrong one', () => {
    expect(bind('select :a', 'postgres', ['colon'], {})).toEqual({
      ok: false,
      key: 'a',
      problem: 'missing',
    });
    expect(bind('select :a', 'postgres', ['colon'], { a: { type: 'number', text: 'x' } })).toEqual({
      ok: false,
      key: 'a',
      problem: 'number',
    });
  });

  it('finds the place of an error in the statement as it is written', () => {
    const written = "select '😀', :kunde, nmae, :ids from t";
    const b = bind(written, 'postgres', ['colon'], {
      kunde: { type: 'auto', text: '1' },
      ids: { type: 'list', text: '1,2,3' },
    });
    if (!b.ok) throw new Error('bind');
    const sent = b.statement.sql;
    expect(sent).toBe("select '😀', $1, nmae, $2, $3, $4 from t");
    const chars = (text: string, part: string) => [...text.slice(0, text.indexOf(part))].length + 1;
    // behind a parameter that got shorter
    expect(writtenPosition(written, b.statement, chars(sent, 'nmae'))).toBe(chars(written, 'nmae'));
    // behind a list that got longer
    expect(writtenPosition(written, b.statement, chars(sent, 'from'))).toBe(chars(written, 'from'));
    // inside a placeholder: the parameter
    expect(writtenPosition(written, b.statement, chars(sent, '$3'))).toBe(chars(written, ':ids'));
    // before everything
    expect(writtenPosition(written, b.statement, 1)).toBe(1);
  });

  it('describes values for the messages', () => {
    expect(describeValue('kunde', values.kunde)).toBe('kunde = 42');
    expect(describeValue('name', { type: 'auto', text: "it's" })).toBe("name = 'it''s'");
    expect(describeValue('ids', values.ids)).toBe('ids = (1, 2, 3)');
    expect(describeValue('x', values.nichts)).toBe('x = NULL');
    expect(describeValue('t', { type: 'text', text: 'x'.repeat(200) }).length).toBeLessThanOrEqual(
      84,
    );
  });
});
