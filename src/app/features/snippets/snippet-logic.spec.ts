import {
  BUILTIN_SNIPPETS,
  PREFIX,
  resolveVars,
  snippetProblem,
  snippetRows,
  snippetsFor,
  withSnippet,
} from './snippet-logic';

const none = { table: null, schema: null };

describe('snippets', () => {
  it('fills in the table and the schema of the tree, as literal text', () => {
    const vars = { table: '"my}table$"', schema: 'public' };
    expect(resolveVars('FROM ${1:$TABLE} -- ${SCHEMA}', vars)).toBe(
      'FROM ${1:"my\\}table\\$"} -- public',
    );
    // nothing chosen: a word to type over
    expect(resolveVars('FROM ${1:$TABLE}', none)).toBe('FROM ${1:table}');
    // an escaped dollar is the user's; other variables are the editor's
    expect(resolveVars('\\$TABLE $TABLES $SELECTION ${DATE}', vars)).toBe(
      '\\$TABLE $TABLES $SELECTION ${DATE}',
    );
  });

  it('offers the built-in snippets of a dialect, own ones on top', () => {
    const pg = snippetsFor('postgres', [], none);
    const mssql = snippetsFor('sqlserver', [], none);
    expect(pg.find((s) => s.prefix === 'sell')).toBeDefined();
    expect(pg.find((s) => s.prefix === 'selt')).toBeUndefined();
    expect(mssql.find((s) => s.prefix === 'selt')).toBeDefined();
    expect(pg.find((s) => s.prefix === 'exp')?.body).toContain('ANALYZE');
    expect(snippetsFor('sqlite', [], none).find((s) => s.prefix === 'exp')?.body).toContain(
      'QUERY PLAN',
    );
    // one snippet per prefix, sorted
    expect(new Set(pg.map((s) => s.prefix)).size).toBe(pg.length);
    expect(pg.map((s) => s.prefix)).toEqual([...pg.map((s) => s.prefix)].sort());
    const own = [{ prefix: 'sel', description: 'mine', body: 'SELECT 1' }];
    expect(snippetsFor('postgres', own, none).find((s) => s.prefix === 'sel')?.body).toBe(
      'SELECT 1',
    );
    expect(snippetsFor('postgres', [], { table: 'orders', schema: null })[0]).toBeDefined();
    expect(
      snippetsFor('postgres', [], { table: 'orders', schema: null }).find((s) => s.prefix === 'sel')
        ?.body,
    ).toBe('SELECT ${1:*}\nFROM ${2:orders}$0');
  });

  it('ships snippets with valid prefixes, a body and an end', () => {
    for (const s of BUILTIN_SNIPPETS) {
      expect(PREFIX.test(s.prefix), s.prefix).toBe(true);
      expect(s.body, s.prefix).toContain('$0');
      expect(s.description).not.toBe('');
    }
  });

  it('lists own snippets and the built-in ones they do not replace', () => {
    const rows = snippetRows([{ prefix: 'sel', description: 'mine', body: 'x' }]);
    expect(rows.filter((r) => r.prefix === 'sel')).toEqual([
      { prefix: 'sel', description: 'mine', body: 'x', builtin: false, where: '' },
    ]);
    expect(rows.filter((r) => r.prefix === 'exp').map((r) => r.where)).toEqual([
      'mysql',
      'postgres',
      'sqlite',
    ]);
  });

  it('checks a snippet as typed', () => {
    const own = [{ prefix: 'a', description: '', body: 'x' }];
    const draft = (prefix: string, body = 'x') => ({ prefix, description: '', body });
    expect(snippetProblem(draft('bad prefix'), own, null)).toBe('prefix');
    expect(snippetProblem(draft(''), own, null)).toBe('prefix');
    expect(snippetProblem(draft('a'), own, null)).toBe('taken');
    expect(snippetProblem(draft('a'), own, 'a')).toBeNull();
    expect(snippetProblem(draft('b', '  '), own, null)).toBe('body');
    expect(snippetProblem(draft('größe_1'), own, null)).toBeNull();
  });

  it('adds, replaces and renames an own snippet', () => {
    const own = [
      { prefix: 'b', description: '', body: '1' },
      { prefix: 'a', description: '', body: '2' },
    ];
    expect(
      withSnippet(own, { prefix: 'c', description: '', body: '3' }, null).map((s) => s.prefix),
    ).toEqual(['a', 'b', 'c']);
    expect(withSnippet(own, { prefix: 'z', description: '', body: '9' }, 'a')).toEqual([
      { prefix: 'b', description: '', body: '1' },
      { prefix: 'z', description: '', body: '9' },
    ]);
  });
});
