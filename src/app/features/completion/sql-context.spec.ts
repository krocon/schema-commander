import { describe, expect, it } from 'vitest';
import { Dialect } from '../editor/sql-split';
import { analyse } from './sql-context';
import cases from './sql-context.cases.json';

interface Case {
  sql: string;
  /** What is expected; `a_or_b` where both are right for a text that ends without a blank. */
  expect: string;
  word?: string;
  clause?: string;
  qualifier?: string[];
  /** `alias=schema.name`, `alias=name` or `name`: these must be in reach, in this order from the start. */
  tables?: string[];
  ctes?: string[];
  selected?: string[];
  /** The columns of derived tables and CTEs by alias. */
  derived?: Record<string, string[]>;
  dialects?: Dialect[];
}

const DIALECTS: Dialect[] = ['postgres', 'mysql', 'sqlserver', 'sqlite'];

describe('what the completion may offer (catalog)', () => {
  const catalog = cases as Case[];

  it('is large enough for every dialect', () => {
    for (const dialect of DIALECTS) {
      const count = catalog.filter((c) => !c.dialects || c.dialects.includes(dialect)).length;
      expect(count, dialect).toBeGreaterThanOrEqual(110);
    }
  });

  for (const dialect of DIALECTS) {
    it(`reads every case as ${dialect}`, () => {
      const wrong: string[] = [];
      for (const c of catalog) {
        if (c.dialects && !c.dialects.includes(dialect)) continue;
        const caret = c.sql.includes('▮') ? c.sql.indexOf('▮') : c.sql.length;
        const sql = c.sql.replace('▮', '');
        const got = analyse(sql, caret, dialect);
        const refs = got.tables.map((t) =>
          t.alias === t.name && !t.schema
            ? t.name
            : `${t.alias}=${t.schema ? `${t.schema}.` : ''}${t.name}`,
        );
        const problems: string[] = [];
        if (!c.expect.split('_or_').includes(got.expect)) problems.push(`expect ${got.expect}`);
        if (c.word !== undefined && got.word !== c.word) problems.push(`word ${got.word}`);
        if (c.clause !== undefined && got.clause !== c.clause) problems.push(`clause ${got.clause}`);
        if (c.qualifier && got.qualifier.join('.') !== c.qualifier.join('.')) {
          problems.push(`qualifier ${got.qualifier.join('.')}`);
        }
        if (c.tables) {
          const names = (list: string[]) => list.map((r) => r.replace(/^(.*)=\1$/, '$1'));
          const want = names(c.tables);
          if (want.some((w, i) => names(refs)[i] !== w) && want.join() !== names(refs).join()) {
            problems.push(`tables ${refs.join(', ')}`);
          }
        }
        if (c.ctes && got.ctes.map((t) => t.name).join() !== c.ctes.join()) {
          problems.push(`ctes ${got.ctes.map((t) => t.name).join()}`);
        }
        if (c.selected && got.selected.join() !== c.selected.join()) {
          problems.push(`selected ${got.selected.join()}`);
        }
        for (const [alias, columns] of Object.entries(c.derived ?? {})) {
          const ref = got.tables.find((t) => t.alias === alias);
          if (ref?.columns?.join() !== columns.join()) {
            problems.push(`columns of ${alias}: ${ref?.columns?.join() ?? 'none'}`);
          }
        }
        if (problems.length) wrong.push(`${c.sql.replace(/\n/g, '⏎')}  →  ${problems.join('; ')}`);
      }
      expect(wrong, wrong.join('\n')).toEqual([]);
    });
  }
});
