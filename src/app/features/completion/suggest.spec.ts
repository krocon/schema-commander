import { describe, expect, it } from 'vitest';
import { Dialect } from '../editor/sql-split';
import { analyse } from './sql-context';
import contextCases from './sql-context.cases.json';
import { ColumnMeta, Meta, NO_META, TableMeta, aliasFor, needsOf, suggest } from './suggest';
import cases from './suggest.cases.json';

interface Case {
  sql: string;
  /** The list starts with these, in this order. */
  first?: string[];
  /** The list is exactly this. */
  exact?: string[];
  has?: string[];
  notHas?: string[];
  /** What is put into the text for a label. */
  insert?: Record<string, string>;
  lower?: boolean;
  dialects?: Dialect[];
}

const DIALECTS: Dialect[] = ['postgres', 'mysql', 'sqlserver', 'sqlite'];

/** Quotes as the backend does it, as far as the test schema needs it. */
function quote(name: string, dialect: Dialect): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name) && name !== 'select') return name;
  if (dialect === 'mysql') return `\`${name}\``;
  if (dialect === 'sqlserver') return `[${name}]`;
  return `"${name}"`;
}

/** A small shop: two schemas, foreign keys, a name that must be quoted. */
function shop(dialect: Dialect): Meta {
  const col = (name: string, type: string, key = ''): ColumnMeta => ({
    name,
    quoted: quote(name, dialect),
    type,
    key,
  });
  const table = (schema: string, name: string, over: Partial<TableMeta>): TableMeta => ({
    schema,
    name,
    kind: 'table',
    quoted: `${quote(schema, dialect)}.${quote(name, dialect)}`,
    quotedName: quote(name, dialect),
    ...over,
  });
  return {
    currentSchema: 'shop',
    schemas: [
      { name: 'archive', quoted: 'archive' },
      { name: 'shop', quoted: 'shop' },
    ],
    tables: [
      table('shop', 'customer', {
        columns: [col('id', 'integer', 'pk'), col('name', 'text')],
        referencedBy: [
          {
            schema: 'shop',
            name: 'orders',
            columns: ['customer_id'],
            refSchema: 'shop',
            refName: 'customer',
            refColumns: ['id'],
          },
        ],
      }),
      table('shop', 'order_items', {
        columns: [col('order_id', 'integer', 'fk'), col('product', 'text'), col('qty', 'integer')],
        references: [
          { columns: ['order_id'], refSchema: 'shop', refName: 'orders', refColumns: ['id'] },
        ],
      }),
      table('shop', 'orders', {
        columns: [
          col('id', 'integer', 'pk'),
          col('customer_id', 'integer', 'fk'),
          col('total', 'numeric(10,2)'),
          col('note', 'text'),
        ],
        references: [
          { columns: ['customer_id'], refSchema: 'shop', refName: 'customer', refColumns: ['id'] },
        ],
        referencedBy: [
          {
            schema: 'shop',
            name: 'order_items',
            columns: ['order_id'],
            refSchema: 'shop',
            refName: 'orders',
            refColumns: ['id'],
          },
        ],
      }),
      table('shop', 'open_orders', { kind: 'view', columns: [col('id', 'integer')] }),
      table('shop', 'Odd Name', { columns: [col('select', 'text'), col('Größe 1', 'numeric')] }),
      table('archive', 'orders', { columns: [col('id', 'integer'), col('old', 'boolean')] }),
    ],
    routines: [
      {
        schema: 'shop',
        name: 'order_total',
        detail: 'id integer',
        quoted: 'shop.order_total',
        quotedName: 'order_total',
      },
    ],
  };
}

describe('what the completion offers (catalog)', () => {
  const catalog = cases as Case[];

  it('has, with the catalog of contexts, at least 150 cases for every dialect', () => {
    for (const dialect of DIALECTS) {
      const fits = (c: { dialects?: string[] }) => !c.dialects || c.dialects.includes(dialect);
      const count =
        catalog.filter(fits).length +
        (contextCases as { dialects?: string[] }[]).filter(fits).length;
      expect(count, dialect).toBeGreaterThanOrEqual(150);
    }
  });

  for (const dialect of DIALECTS) {
    it(`offers the expected entries as ${dialect}`, () => {
      const meta = shop(dialect);
      const wrong: string[] = [];
      for (const c of catalog) {
        if (c.dialects && !c.dialects.includes(dialect)) continue;
        const caret = c.sql.indexOf('▮');
        const context = analyse(c.sql.replace('▮', ''), caret, dialect);
        const list = suggest(context, meta, { dialect, keywordCase: c.lower ? 'lower' : 'upper' });
        const labels = list.map((s) => s.label);
        const problems: string[] = [];
        if (c.exact && labels.join('|') !== c.exact.join('|'))
          problems.push(`is ${labels.join(' | ')}`);
        if (c.first && labels.slice(0, c.first.length).join('|') !== c.first.join('|')) {
          problems.push(`starts ${labels.slice(0, c.first.length + 2).join(' | ')}`);
        }
        for (const label of c.has ?? [])
          if (!labels.includes(label)) problems.push(`lacks ${label}`);
        for (const label of c.notHas ?? [])
          if (labels.includes(label)) problems.push(`has ${label}`);
        for (const [label, text] of Object.entries(c.insert ?? {})) {
          const found = list.find((s) => s.label === label);
          if (found?.insertText !== text) problems.push(`${label} inserts ${found?.insertText}`);
        }
        if (problems.length) wrong.push(`${c.sql}  →  ${problems.join('; ')}`);
      }
      expect(wrong, wrong.join('\n')).toEqual([]);
    });
  }
});

describe('suggestions', () => {
  const options = { dialect: 'postgres' as Dialect, keywordCase: 'upper' as const };
  const at = (sql: string) => analyse(sql.replace('▮', ''), sql.indexOf('▮'), 'postgres');

  it('offers keywords and nothing else without a connection, and never fails', () => {
    for (const c of contextCases as { sql: string }[]) {
      const caret = c.sql.includes('▮') ? c.sql.indexOf('▮') : c.sql.length;
      const context = analyse(c.sql.replace('▮', ''), caret, 'postgres');
      const list = suggest(context, NO_META, options);
      expect(
        list.every((s) => ['keyword', 'function', 'type', 'alias', 'column'].includes(s.kind)),
      ).toBe(true);
    }
    expect(suggest(at('SELECT * FROM ▮'), NO_META, options)).toEqual([]);
    expect(suggest(at('▮'), NO_META, options)[0].label).toBe('SELECT');
  });

  it('shows types, tables and signatures beside the names', () => {
    const meta = shop('postgres');
    const one = suggest(at('SELECT ▮ FROM orders'), meta, options);
    expect(one.find((s) => s.label === 'total')).toMatchObject({
      kind: 'column',
      detail: 'numeric(10,2)',
    });
    const two = suggest(at('SELECT ▮ FROM orders o JOIN customer c ON true'), meta, options);
    expect(two.find((s) => s.label === 'name')?.detail).toBe('text · c');
    expect(two.find((s) => s.label === 'o.id')).toMatchObject({
      filterText: 'id',
      insertText: 'o.id',
    });
    expect(one.find((s) => s.label === 'order_total')?.documentation).toBe(
      'order_total(id integer)',
    );
    expect(one.find((s) => s.label === 'coalesce')?.documentation).toBe('coalesce(value, …)');
    const tables = suggest(at('SELECT * FROM ▮'), meta, options);
    expect(tables.find((s) => s.label === 'open_orders')?.kind).toBe('view');
    expect(tables.find((s) => s.label === 'archive.orders')).toMatchObject({
      filterText: 'orders',
      detail: 'archive',
    });
  });

  it('says what must be read before it can answer in full', () => {
    expect(needsOf(at('SELECT * FROM ▮'))).toMatchObject({ tablesIn: null, joins: false });
    expect(needsOf(at('SELECT * FROM archive.▮'))).toMatchObject({ tablesIn: 'archive' });
    expect(needsOf(at('SELECT * FROM orders o JOIN ▮'))).toMatchObject({
      tablesIn: null,
      joins: true,
    });
    const some = needsOf(at('SELECT o.▮ FROM orders o JOIN customer c ON true'));
    expect(some.columnsOf.map((t) => t.name)).toEqual(['orders']);
    const all = needsOf(at('SELECT ▮ FROM orders o JOIN customer c ON true'));
    expect(all.columnsOf.map((t) => t.name)).toEqual(['orders', 'customer']);
    expect(all.routines).toBe(true);
    // a derived table needs nothing of the database
    expect(needsOf(at('SELECT x.▮ FROM (SELECT 1 AS a) x')).columnsOf).toEqual([]);
    // a name that is no table of the statement: a schema or a table named in full
    const other = needsOf(at('SELECT archive.▮'));
    expect(other).toMatchObject({ tablesIn: 'archive' });
    expect(other.columnsOf.map((t) => t.name)).toEqual(['archive']);
    expect(needsOf(at("SELECT '▮"))).toEqual({ columnsOf: [], joins: false, routines: false });
  });

  it('makes aliases from the starts of the words, unlike the ones in use', () => {
    expect(aliasFor('order_items', [])).toBe('oi');
    expect(aliasFor('OrderItems', [])).toBe('oi');
    expect(aliasFor('customer', ['c'])).toBe('c2');
    expect(aliasFor('customer', ['c', 'C2'])).toBe('c3');
    expect(aliasFor('Größe 1', [])).toBe('g1');
    expect(aliasFor('_', [])).toBe('_');
  });
});
