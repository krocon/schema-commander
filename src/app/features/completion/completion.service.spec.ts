import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeConnectionsApi, FakeSchemaApi } from '../../../testing/fake-apis';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { NameHit } from '../../core/schema/schema.models';
import { SettingsService } from '../../core/settings/settings.service';
import { positionOf } from '../editor/sql-split';
import { CompletionService, ProviderContext, foreignKeys, toItem } from './completion.service';

/** The editor's question for a text with `▮` at the caret. */
function ask(text: string, aborted = false): ProviderContext & { slices: [number, number][] } {
  const offset = text.indexOf('▮');
  const plain = text.replace('▮', '');
  const lines = plain.split('\n');
  const slices: [number, number][] = [];
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    position: positionOf(plain, offset),
    word: /[\p{L}\p{N}_]*$/u.exec(plain.slice(0, offset))![0],
    signal: controller.signal,
    slices,
    getSlice: (from, to) => {
      slices.push([from, to]);
      return Promise.resolve(lines.slice(from - 1, to).join('\n'));
    },
  };
}

const name = (kind: NameHit['kind'], n: string, detail = ''): NameHit => ({
  kind,
  schema: 'public',
  name: n,
  parent: null,
  detail,
  quoted: `public.${n}`,
  quotedName: n,
  marks: [],
});

describe('CompletionService', () => {
  let api: FakeSchemaApi;
  let service: CompletionService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    api = new FakeSchemaApi();
    api.nameList = [
      name('table', 'orders'),
      name('table', 'customer'),
      name('view', 'big_orders'),
      name('routine', 'twice', 'n integer'),
    ];
    TestBed.configureTestingModule({
      providers: [
        { provide: SchemaApi, useValue: api },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
      ],
    });
    service = TestBed.inject(CompletionService);
  });

  const labels = async (text: string, connection: string | null = 'pg') =>
    (await service.provide(connection, 'postgres', ask(text)))?.items.map((i) => i.label) ?? [];

  it('offers the tables of the database behind FROM, narrowed by the word begun', async () => {
    const result = await service.provide('pg', 'postgres', ask('SELECT * FROM ord▮'));
    // the tables the backend found for the word, then the schemas (the editor filters them by the word)
    expect(result?.items.map((i) => i.label)).toEqual([
      'orders',
      'big_orders',
      'archive',
      'public',
    ]);
    expect(api.nameQueries.at(-1)?.query).toBe('t:ord');
    // the backend chose by the word: the editor must ask again when it changes
    expect(result?.incomplete).toBe(true);
    expect(result?.items[0]).toMatchObject({
      kind: 'table',
      insertText: 'orders',
      sortText: '00000',
    });
  });

  it('offers only the columns of the table an alias names', async () => {
    expect(
      await labels('SELECT o.▮ FROM orders o JOIN customer c ON c.id = o.customer_id'),
    ).toEqual(['id', 'customer_id', 'note']);
    // one table was read, not two
    expect(api.calls.filter((c) => c.startsWith('table'))).toEqual(['table public.orders']);
  });

  it('reads a table once and keeps it, until told to forget', async () => {
    await labels('SELECT o.▮ FROM orders o');
    await labels('SELECT * FROM orders o WHERE o.▮');
    expect(api.calls.filter((c) => c.startsWith('table')).length).toBe(1);
    service.forget();
    await labels('SELECT o.▮ FROM orders o');
    expect(api.calls.filter((c) => c.startsWith('table')).length).toBe(2);
  });

  it('proposes the join a foreign key gives', async () => {
    const list = await labels('SELECT * FROM orders o JOIN ▮');
    expect(list[0]).toBe('customer c ON c.id = o.customer_id');
    expect(list).toContain('customer');
  });

  it('gives keywords and nothing of a database without a connection, and never fails', async () => {
    expect((await labels('▮', null))[0]).toBe('SELECT');
    expect(await labels('SELECT * FROM ▮', null)).toEqual([]);
    expect(api.nameQueries.length).toBe(0);
    // a connection that answers with errors is the same as none
    api.fail = { code: 'not_connected', message: '' };
    expect(await labels('SELECT * FROM orders ▮')).toContain('WHERE');
    expect(await labels('SELECT o.▮ FROM orders o')).toEqual([]);
  });

  it('writes keywords as the settings say', async () => {
    TestBed.inject(SettingsService).update({ completionKeywordCase: 'lower' });
    expect((await labels('▮'))[0]).toBe('select');
  });

  it('offers nothing in a string or a comment and drops a question that was overtaken', async () => {
    expect(await service.provide('pg', 'postgres', ask("SELECT 'a ▮"))).toBeNull();
    expect(await service.provide('pg', 'postgres', ask('SELECT * FROM ▮', true))).toBeNull();
  });

  it('reads only the lines around the caret, and of them only the statement it is in', async () => {
    const before = Array.from({ length: 5000 }, (_, i) => `SELECT ${i} FROM customer;`).join('\n');
    const question = ask(`${before}\nSELECT o.▮ FROM orders o;\nSELECT 1 FROM customer c;`);
    const result = await service.provide('pg', 'postgres', question);
    expect(result?.items.map((i) => i.label)).toEqual(['id', 'customer_id', 'note']);
    // 400 lines back, 150 on – never the whole text
    expect(question.slices).toEqual([[4601, 5151]]);
  });

  it('writes a star out as the columns it stands for', async () => {
    const expand = (sql: string) =>
      service.expandStar('pg', 'postgres', sql.replace('▮', ''), sql.indexOf('▮'));
    expect(await expand('SELECT *▮ FROM orders')).toEqual({
      from: 7,
      to: 8,
      text: 'id, customer_id, note',
    });
    // behind an alias: its table only, every column with the alias
    expect((await expand('SELECT o.*▮ FROM orders o JOIN customer c ON true'))?.text).toBe(
      'id, o.customer_id, o.note',
    );
    // several tables: every column says where it is from
    expect((await expand('SELECT * FROM orders o▮ JOIN customer c ON true'))?.text).toBe(
      'o.id, o.customer_id, o.note, c.id, c.customer_id, c.note',
    );
    // a factor is no star of a select list
    expect(await expand('SELECT 2 * 3▮')).toBeNull();
    expect(await expand('SELECT id▮ FROM orders')).toBeNull();
    expect((await expand('SELECT x.* FROM (SELECT 1 AS a, 2 AS b) x▮'))?.text).toBe('a, x.b');
  });

  it('reads foreign keys from the lists of the object details', () => {
    expect(
      foreignKeys({
        id: 'references',
        columns: ['name', 'columns', 'refSchema', 'refName', 'refColumns'],
        rows: [
          ['fk', 'a, b', 'shop', 'target', 'x, y'],
          ['broken', 'a', null, null, null],
        ],
        cut: false,
      }),
    ).toEqual([
      { columns: ['a', 'b'], refSchema: 'shop', refName: 'target', refColumns: ['x', 'y'] },
    ]);
    expect(foreignKeys(undefined)).toEqual([]);
    expect(toItem({ label: 'a', insertText: 'a', kind: 'column', detail: '' }, 12)).toEqual({
      label: 'a',
      insertText: 'a',
      kind: 'column',
      sortText: '00012',
    });
  });
});
