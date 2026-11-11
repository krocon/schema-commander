import { describe, expect, it } from 'vitest';
import { DetailSection } from '../../core/schema/schema.models';
import { quickInfoLines } from '../schema/schema-logic';
import {
  DetailTarget,
  filterRows,
  linkTarget,
  linksOf,
  orderSections,
  sameTarget,
} from './details-logic';

const section = (id: string, columns: string[], rows: (string | null)[][]): DetailSection => ({
  id,
  columns,
  rows,
  cut: false,
});

describe('object details', () => {
  it('shows the lists in a fixed order, unknown ones last', () => {
    const lists = ['stats', 'somethingNew', 'usedBy', 'columns', 'indexes'].map((id) =>
      section(id, [], []),
    );
    expect(orderSections(lists).map((s) => s.id)).toEqual([
      'columns',
      'indexes',
      'usedBy',
      'stats',
      'somethingNew',
    ]);
  });

  it('filters rows by words that may stand in any cell', () => {
    const rows = [
      ['id', 'integer', null],
      ['customer_id', 'integer', 'who ordered'],
      ['note', 'TEXT', null],
    ];
    expect(filterRows(rows, '')).toBe(rows);
    expect(filterRows(rows, 'INTEGER').length).toBe(2);
    expect(filterRows(rows, 'integer who')).toEqual([rows[1]]);
    expect(filterRows(rows, 'text')).toEqual([rows[2]]);
    expect(filterRows(rows, 'nothing')).toEqual([]);
  });

  it('finds the objects a list leads to, each once', () => {
    const refs = section(
      'references',
      ['name', 'refSchema', 'refName'],
      [
        ['a', 'public', 'customer'],
        ['b', 'public', 'customer'],
        ['c', 'archive', 'customer'],
        ['d', null, null],
      ],
    );
    expect(linksOf(refs)).toEqual([
      { schema: 'public', name: 'customer' },
      { schema: 'archive', name: 'customer' },
    ]);
    expect(linksOf(section('columns', ['name', 'type'], [['id', 'int']]))).toEqual([]);
    // a list without a schema column leads into the schema one is in
    const from: DetailTarget = {
      connectionId: 'pg',
      schema: 'main',
      name: 'book',
      kind: 'view',
      detail: '',
    };
    expect(linkTarget(from, { schema: '', name: 'author' })).toEqual({
      connectionId: 'pg',
      schema: 'main',
      name: 'author',
      kind: 'table',
      detail: '',
    });
    expect(sameTarget(from, { ...from })).toBe(true);
    expect(sameTarget(from, { ...from, kind: 'table' })).toBe(false);
  });

  it('writes a quick info of columns, bounded', () => {
    const column = (name: string, key = '', nullable = true) => ({
      name,
      quoted: name,
      typeName: 'integer',
      nullable,
      default: null,
      key,
    });
    expect(
      quickInfoLines([column('id', 'pk', false), column('author_id', 'fk'), column('n')]),
    ).toEqual(['id  integer  (PK, NOT NULL)', 'author_id  integer  (FK)', 'n  integer']);
    const many = Array.from({ length: 1500 }, (_, i) => column(`c${i}`));
    const lines = quickInfoLines(many);
    expect(lines.length).toBe(31);
    expect(lines.at(-1)).toBe('… +1470');
  });
});
