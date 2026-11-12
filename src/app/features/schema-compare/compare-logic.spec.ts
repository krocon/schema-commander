import { CompareItem } from '../../core/compare/compare-api';
import {
  counts,
  filtered,
  inverted,
  itemLabel,
  lineDiff,
  readSnapshot,
  renameOf,
  reportMarkdown,
} from './compare-logic';

const item = (
  id: string,
  state: CompareItem['state'],
  left: string | null = null,
  right: string | null = null,
): CompareItem => {
  const [kind, rest] = id.split(':');
  const [table, name] = rest.includes('.') ? rest.split('.') : [null, rest];
  return { id, kind: kind as CompareItem['kind'], table, name, state, left, right };
};

const ITEMS: CompareItem[] = [
  item('table:audit', 'onlyRight'),
  item('table:customer', 'same'),
  item('table:orders', 'different', 'TABLE orders\n  id integer', 'TABLE orders\n  id bigint'),
  item('column:orders.total', 'different', 'total numeric(12,2)', 'total numeric(10,2)'),
  item('column:orders.note', 'onlyLeft'),
  item('view:big', 'different', 'SELECT 1', 'SELECT 2'),
];

describe('compare logic', () => {
  it('reads a snapshot from a file, or says that it is none', () => {
    expect(readSnapshot('{"kind":"postgres","schema":"s","tables":[]}')).toMatchObject({
      schema: 's',
    });
    for (const bad of [
      '',
      'x',
      '[]',
      '{}',
      '{"kind":"oracle","schema":"s","tables":[]}',
      '{"kind":"postgres","schema":1,"tables":[]}',
      '{"kind":"postgres","schema":"s"}',
    ]) {
      expect(readSnapshot(bad), bad).toBeNull();
    }
  });

  it('filters and counts the items', () => {
    expect(counts(ITEMS)).toEqual({ same: 1, onlyLeft: 1, onlyRight: 1, different: 3 });
    const all = { onlyDifferences: false, kind: '', text: '' } as const;
    expect(filtered(ITEMS, all).length).toBe(6);
    expect(filtered(ITEMS, { ...all, onlyDifferences: true }).length).toBe(5);
    expect(filtered(ITEMS, { ...all, kind: 'column' }).map(itemLabel)).toEqual([
      'orders.total',
      'orders.note',
    ]);
    expect(filtered(ITEMS, { ...all, text: 'ORD' }).map((i) => i.id)).toEqual([
      'table:orders',
      'column:orders.total',
      'column:orders.note',
    ]);
  });

  it('knows which two items may be one thing that was renamed', () => {
    const gone = item('table:client', 'onlyRight');
    const come = item('table:customer', 'onlyLeft');
    expect(renameOf(gone, come, 'right')).toEqual({ table: null, from: 'client', to: 'customer' });
    expect(renameOf(come, gone, 'right')).toEqual({ table: null, from: 'client', to: 'customer' });
    const oldColumn = item('column:orders.label', 'onlyRight');
    const newColumn = item('column:orders.note', 'onlyLeft');
    expect(renameOf(oldColumn, newColumn, 'right')).toEqual({
      table: 'orders',
      from: 'label',
      to: 'note',
    });
    // not: two on the same side, two kinds, columns of two tables, something that is on both sides
    expect(renameOf(gone, item('table:other', 'onlyRight'), 'right')).toBeNull();
    expect(renameOf(gone, newColumn, 'right')).toBeNull();
    expect(renameOf(oldColumn, item('column:audit.note', 'onlyLeft'), 'right')).toBeNull();
    expect(renameOf(gone, item('table:orders', 'different'), 'right')).toBeNull();
    expect(renameOf(item('view:a', 'onlyLeft'), item('view:b', 'onlyRight'), 'right')).toBeNull();
    // for the other direction the names change sides; a column names its table as that side has it
    expect(
      inverted([
        { table: null, from: 'client', to: 'customer' },
        { table: 'client', from: 'label', to: 'name' },
        { table: 'orders', from: 'a', to: 'b' },
      ]),
    ).toEqual([
      { table: null, from: 'customer', to: 'client' },
      { table: 'customer', from: 'name', to: 'label' },
      { table: 'orders', from: 'b', to: 'a' },
    ]);
  });

  it('lays two texts side by side, line by line', () => {
    const rows = lineDiff(
      'TABLE orders\n  id integer\n  total numeric(12,2)\n  note text\n  PRIMARY KEY (id)',
      'TABLE orders\n  id bigint\n  total numeric(12,2)\n  PRIMARY KEY (id)\n  CHECK (total >= 0)',
    );
    expect(rows.map((r) => `${r.state}: ${r.left ?? '∅'} | ${r.right ?? '∅'}`)).toEqual([
      'same: TABLE orders | TABLE orders',
      'changed:   id integer |   id bigint',
      'same:   total numeric(12,2) |   total numeric(12,2)',
      'left:   note text | ∅',
      'same:   PRIMARY KEY (id) |   PRIMARY KEY (id)',
      'right: ∅ |   CHECK (total >= 0)',
    ]);
    expect(lineDiff('a', null).map((r) => r.state)).toEqual(['left']);
    expect(lineDiff(null, 'a\nb').map((r) => r.state)).toEqual(['right', 'right']);
    expect(lineDiff(null, null)).toEqual([]);
    // white space at the ends of a line is no difference
    expect(lineDiff('  a  ', 'a').map((r) => r.state)).toEqual(['same']);
  });

  it('writes a report', () => {
    const md = reportMarkdown('dev · shop', 'prod | shop', ITEMS);
    expect(md).toContain('# Schemata verglichen: dev · shop und prod | shop');
    expect(md).toContain('Nur links: 1 · nur rechts: 1 · verschieden: 3 · gleich: 1');
    expect(md).toContain('| Tabelle | audit | nur rechts |');
    expect(md).toContain('| Spalte | orders.total | verschieden |');
    expect(md).not.toContain('| Tabelle | customer |');
    expect(md).toContain(
      '## View big\n\n**dev · shop**\n\n```\nSELECT 1\n```\n\n**prod \\| shop**\n\n```\nSELECT 2\n```',
    );
    expect(reportMarkdown('a', 'b', [item('table:t', 'same')])).toContain('Keine Unterschiede.');
  });
});
