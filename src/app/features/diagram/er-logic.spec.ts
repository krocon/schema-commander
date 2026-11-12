import { DiagramData, ForeignKey } from '../../core/schema/schema.models';
import { toDbml, toMermaid, toSvg } from './er-export';
import { Rect, anchor, bounds, edgePath, layers, layout, nodeSize, overlaps } from './er-layout';
import {
  ErModel,
  buildModel,
  cardinality,
  mostConnected,
  neighbourhood,
  nodeId,
  shownColumns,
  subModel,
} from './er-model';

const col = (name: string, typeName = 'integer', nullable = false, pk = false) => ({
  name,
  typeName,
  nullable,
  pk,
});
const fk = (
  table: string,
  columns: string[],
  refTable: string,
  refColumns: string[],
  name = `${table}_fk`,
): ForeignKey => ({ name, schema: 's', table, columns, refSchema: 's', refTable, refColumns });

/** A small shop: a key of a table to itself, a key of two columns, a one-to-one, a table alone. */
const SHOP: DiagramData = {
  tables: [
    {
      schema: 's',
      name: 'author',
      columns: [
        col('id', 'integer', false, true),
        col('name', 'text'),
        col('boss', 'integer', true),
      ],
    },
    {
      schema: 's',
      name: 'book',
      columns: [
        col('isbn', 'text', false, true),
        col('edition', 'integer', false, true),
        col('author_id'),
        col('title', 'character varying(200)', true),
      ],
    },
    {
      schema: 's',
      name: 'copy',
      columns: [
        col('id', 'integer', false, true),
        col('isbn', 'text', true),
        col('edition', 'integer', true),
      ],
    },
    {
      schema: 's',
      name: 'profile',
      columns: [col('author_id', 'integer', false, true), col('bio', 'text', true)],
    },
    { schema: 's', name: 'Odd "name"', columns: [col('id', 'integer', false, true)] },
  ],
  keys: [
    fk('author', ['boss'], 'author', ['id'], 'author_boss'),
    fk('book', ['author_id'], 'author', ['id']),
    fk('copy', ['isbn', 'edition'], 'book', ['isbn', 'edition']),
    fk('profile', ['author_id'], 'author', ['id']),
    // into a table the schema does not have
    { ...fk('book', ['author_id'], 'elsewhere', ['id'], 'out'), refSchema: 'other' },
  ],
  unique: [
    { table: 'author', columns: ['id'] },
    { table: 'book', columns: ['isbn', 'edition'] },
    { table: 'profile', columns: ['author_id'] },
  ],
  cut: false,
};
const id = (name: string) => nodeId('s', name);

function rectsOf(model: ErModel, detail: 'names' | 'keys' | 'all'): Map<string, Rect> {
  const places = layout(model, detail);
  return new Map(
    model.nodes.map((n) => [
      n.id,
      { ...(places.get(n.id) ?? { x: 0, y: 0 }), ...nodeSize(n, detail) },
    ]),
  );
}

describe('er model', () => {
  it('builds tables and keys and says what a key means', () => {
    const { model, outside } = buildModel(SHOP);
    expect(outside).toBe(1);
    expect(model.nodes.map((n) => n.name)).toEqual([
      'author',
      'book',
      'copy',
      'profile',
      'Odd "name"',
    ]);
    const edge = (from: string) => model.edges.find((e) => e.from === id(from))!;
    // many books, exactly one author
    expect(cardinality(edge('book'))).toEqual({ to: 'one', from: 'many' });
    // a copy may point to no book: its key takes NULL
    expect(cardinality(edge('copy'))).toEqual({ to: 'zeroOrOne', from: 'many' });
    expect(edge('copy').columns).toEqual(['isbn', 'edition']);
    // the key of a profile is unique: at most one profile per author
    expect(cardinality(edge('profile'))).toEqual({ to: 'one', from: 'zeroOrOne' });
    // a key of a table to itself
    expect(edge('author')).toMatchObject({ to: id('author'), optional: true, many: true });
    // columns know that they are part of a key
    const book = model.nodes[1];
    expect(book.columns.filter((c) => c.fk).map((c) => c.name)).toEqual(['author_id']);
    expect(shownColumns(book, 'names')).toEqual([]);
    expect(shownColumns(book, 'keys').map((c) => c.name)).toEqual(['isbn', 'edition', 'author_id']);
    expect(shownColumns(book, 'all').length).toBe(4);
  });

  it('draws relations the user defined, and leaves out those that fit nothing', () => {
    const { model, outside } = buildModel(SHOP, [
      fk('copy', ['id'], 'author', ['id'], ''),
      fk('copy', ['nope'], 'author', ['id'], ''),
      fk('ghost', ['id'], 'author', ['id'], ''),
    ]);
    const virtual = model.edges.filter((e) => e.virtual);
    expect(virtual.map((e) => `${e.from === id('copy')}:${e.columns}`)).toEqual(['true:id']);
    expect(outside).toBe(3);
  });

  it('finds the neighbourhood of a table and the core of a large schema', () => {
    const { model } = buildModel(SHOP);
    expect([...neighbourhood(model, id('copy'), 1)].sort()).toEqual(
      [id('book'), id('copy')].sort(),
    );
    expect(neighbourhood(model, id('copy'), 2).size).toBe(3);
    expect(neighbourhood(model, id('copy'), 5).size).toBe(4);
    expect(neighbourhood(model, id('nope'), 2).size).toBe(0);
    const part = subModel(model, neighbourhood(model, id('copy'), 1));
    expect(part.edges.map((e) => e.name)).toEqual(['copy_fk']);
    expect([...mostConnected(model, 2)].sort()).toEqual([id('author'), id('book')].sort());
    expect(mostConnected(model, 50).size).toBe(5);
  });
});

describe('er layout', () => {
  it('puts a table right of what it points to', () => {
    const { model } = buildModel(SHOP);
    const rank = layers(model);
    expect(rank.get(id('author'))).toBe(0);
    expect(rank.get(id('book'))).toBe(1);
    expect(rank.get(id('profile'))).toBe(1);
    expect(rank.get(id('copy'))).toBe(2);
    expect(rank.has(id('Odd "name"'))).toBe(false);
    const places = layout(model, 'keys');
    const x = (name: string) => places.get(id(name))!.x;
    expect(x('author')).toBeLessThan(x('book'));
    expect(x('book')).toBeLessThan(x('copy'));
    // a circle of keys does not hang the arrangement
    const circle = buildModel({
      ...SHOP,
      keys: [...SHOP.keys, fk('author', ['id'], 'copy', ['id'], 'back')],
    }).model;
    expect(layout(circle, 'keys').size).toBe(5);
  });

  it('never lays two tables over each other and is the same for the same input', () => {
    // a table with 12 neighbours, and 300 tables in chains and alone
    const tables = Array.from({ length: 300 }, (_, i) => ({
      schema: 's',
      name: `t${String(i).padStart(3, '0')}`,
      columns: [
        col('id', 'integer', false, true),
        col('ref', 'integer', true),
        col('note', 'text', true),
      ],
    }));
    const keys = [
      ...Array.from({ length: 12 }, (_, i) =>
        fk(`t${String(i + 1).padStart(3, '0')}`, ['ref'], 't000', ['id']),
      ),
      ...Array.from({ length: 150 }, (_, i) =>
        fk(
          `t${String(i + 20).padStart(3, '0')}`,
          ['ref'],
          `t${String((i * 7) % 20).padStart(3, '0')}`,
          ['id'],
        ),
      ),
    ];
    const { model } = buildModel({ tables, keys, unique: [], cut: false });
    for (const detail of ['names', 'keys', 'all'] as const) {
      const rects = [...rectsOf(model, detail).values()];
      expect(rects.length).toBe(300);
      for (let a = 0; a < rects.length; a++) {
        for (let b = a + 1; b < rects.length; b++) {
          expect(overlaps(rects[a], rects[b]), `${detail}: ${a} over ${b}`).toBe(false);
        }
      }
    }
    expect([...layout(model, 'keys')]).toEqual([...layout(model, 'keys')]);
    // the order of the input does not matter
    const shuffled = buildModel({
      tables: [...tables].reverse(),
      keys: [...keys].reverse(),
      unique: [],
      cut: false,
    }).model;
    const a = layout(model, 'keys');
    const b = layout(shuffled, 'keys');
    expect(
      [...a.keys()].every((k) => a.get(k)?.x === b.get(k)?.x && a.get(k)?.y === b.get(k)?.y),
    ).toBe(true);
    expect(bounds(rects0(model))!.w).toBeGreaterThan(0);
    expect(bounds([])).toBeNull();
  });

  it('finds the row of a column in a table as it is drawn', () => {
    const book = buildModel(SHOP).model.nodes[1];
    // keys shown: isbn, edition, author_id – the third row
    expect(anchor(book, 'keys', ['author_id'])).toBe(26 + 14 + 2 * 18 - 4);
    expect(anchor(book, 'all', ['title'])).toBe(26 + 14 + 3 * 18 - 4);
    // not shown: the head of the table
    expect(anchor(book, 'names', ['author_id'])).toBeNull();
    expect(anchor(book, 'keys', ['title'])).toBeNull();
  });

  it('draws a key as a line between the facing sides, and a key to itself as a loop', () => {
    const a = { x: 0, y: 0, w: 100, h: 60 };
    const b = { x: 300, y: 100, w: 100, h: 60 };
    // from b (right) to a (left): leaves b on its left side, arrives at the right side of a
    expect(edgePath(b, a, false)).toMatch(/^M300,113 C.* 100,13$/);
    expect(edgePath(a, b, false)).toMatch(/^M100,13 C.* 300,113$/);
    const loop = edgePath(a, a, true);
    expect(loop.startsWith('M100,13')).toBe(true);
    expect(loop.endsWith('100,35')).toBe(true);
    // where the columns of the key are shown, the line starts and ends at them
    expect(edgePath(b, a, false, 0, 40, 31)).toMatch(/^M300,140 C.* 100,31$/);
    // two keys between the same tables do not lie on each other
    expect(edgePath(b, a, false, 1)).not.toBe(edgePath(b, a, false, 0));
  });
});

function rects0(model: ErModel): Rect[] {
  return [...rectsOf(model, 'names').values()];
}

describe('er export', () => {
  it('writes Mermaid', () => {
    const { model } = buildModel(SHOP);
    const text = toMermaid(model);
    expect(text.startsWith('erDiagram\n')).toBe(true);
    expect(text).toContain(
      '  book {\n    text isbn PK\n    integer edition PK\n    integer author_id FK\n    character_varying_200 title\n  }',
    );
    expect(text).toContain('  author ||--o{ book : "author_id"');
    expect(text).toContain('  book |o--o{ copy : "isbn, edition"');
    expect(text).toContain('  author ||--o| profile : "author_id"');
    expect(text).toContain('  author |o--o{ author : "boss"');
    // a name that is no word is quoted, a quote in it cannot break out
    expect(text).toContain(`  "Odd 'name'" {`);
    const dashed = toMermaid(buildModel(SHOP, [fk('copy', ['id'], 'author', ['id'], '')]).model);
    expect(dashed).toContain('  author ||..o{ copy : "id"');
  });

  it('writes DBML', () => {
    const text = toDbml(buildModel(SHOP).model);
    expect(text).toContain(
      'Table s.author {\n  id integer [pk, not null]\n  name text [not null]\n  boss integer\n}',
    );
    expect(text).toContain('  title "character varying(200)"');
    expect(text).toContain('Ref: s.book.author_id > s.author.id');
    expect(text).toContain('Ref: s.copy.(isbn, edition) > s.book.(isbn, edition)');
    expect(text).toContain('Ref: s.profile.author_id - s.author.id');
    expect(text).toContain(`Table s."Odd 'name'" {`);
  });

  it('writes an SVG with its colours and with names as text', () => {
    const data: DiagramData = {
      ...SHOP,
      tables: [
        ...SHOP.tables,
        { schema: 's', name: '<script>alert(1)</script>', columns: [col('a&b')] },
      ],
    };
    const { model } = buildModel(data);
    const palette = {
      background: '#101418',
      panel: '#1b2027',
      border: '#39424e',
      text: '#e6edf3',
      dim: '#8b98a5',
      accent: '#5aa2f7',
    };
    const svg = toSvg(model, rectsOf(model, 'all'), 'all', palette);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="')).toBe(true);
    // no token is left: the file is to look the same anywhere
    expect(svg).not.toContain('var(');
    expect(svg).toContain('fill="#101418"');
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('a&amp;b');
    expect(svg.match(/marker-start="/g)?.length).toBe(4);
    expect(svg).toContain('marker-start="url(#er-many)" marker-end="url(#er-one)"');
    expect(svg).toContain('PK isbn');
    expect(svg).toContain('character varying(200)');
  });
});
