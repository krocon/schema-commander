import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEMO_PROFILE,
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { ForeignKey } from '../../core/schema/schema.models';
import { SessionApi } from '../../core/session/session-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { EMPTY_SPEC } from '../filter/filter-logic';
import { ResultGridHandle } from '../results/column-layout';
import { CopyService } from '../results/copy.service';
import { QueryTab } from '../tabs/query-tab';
import { TabsStore } from '../tabs/tabs.store';
import { RelationsService } from './relations.service';

const fk = (
  table: string,
  columns: string[],
  refTable: string,
  refColumns: string[],
): ForeignKey => ({
  name: `${table}_fk`,
  schema: 'public',
  table,
  columns,
  refSchema: 'public',
  refTable,
  refColumns,
});

describe('RelationsService', () => {
  let query: FakeQueryApi;
  let schema: FakeSchemaApi;
  let tabs: TabsStore;
  let relations: RelationsService;
  let copier: CopyService;
  const CUSTOMER = fk('orders', ['customer_id'], 'customer', ['id']);
  const LINES = fk('lines', ['order_id'], 'orders', ['id']);
  const AUDIT = fk('audit', ['order_id'], 'orders', ['id']);

  beforeEach(async () => {
    TestBed.resetTestingModule();
    query = new FakeQueryApi();
    schema = new FakeSchemaApi();
    schema.relationsOf = {
      'public.orders': { outgoing: [CUSTOMER], incoming: [LINES, AUDIT] },
      'public.customer': { outgoing: [], incoming: [CUSTOMER] },
    };
    const connections = new FakeConnectionsApi();
    connections.profiles = [DEMO_PROFILE];
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: connections },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: schema },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: ClipboardApi, useValue: new FakeClipboardApi() },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    tabs = TestBed.inject(TabsStore);
    await tabs.load();
    relations = TestBed.inject(RelationsService);
    copier = TestBed.inject(CopyService);
  });

  /** Opens `orders` as a table view in the active tab, with a cursor in its grid. */
  async function orders(cursor: [number, number] = [0, 1]): Promise<QueryTab> {
    const tab = tabs.active()!;
    query.columns = [
      { name: 'id', kind: 'int', typeName: 'int4' },
      { name: 'customer_id', kind: 'int', typeName: 'int4' },
    ];
    query.rows = [
      [1, 42],
      [2, 42],
      [3, null],
      [4, 7],
    ];
    await tab.openTable({ schema: 'public', table: 'orders', spec: EMPTY_SPEC });
    tab.grid = grid(cursor);
    return tab;
  }

  function grid(cursor: [number, number]): ResultGridHandle {
    return {
      cursor: () => cursor,
      goTo: () => undefined,
      fitWidths: () => undefined,
      focusGrid: () => undefined,
    };
  }

  it('reads the keys of a table once and marks the cells that are links', async () => {
    const tab = await orders();
    expect(relations.relationsOf(tab)).toBeUndefined();
    await relations.ensure(tab);
    await relations.ensure(tab);
    expect(schema.calls.filter((c) => c.startsWith('relations'))).toEqual([
      'relations public.orders',
    ]);
    expect([...relations.links(tab, copier.current()!.result.columns)]).toEqual([1]);
  });

  it('keeps the keys of tables apart whose names join to the same text (review 030)', async () => {
    schema.relationsOf['a.b.c'] = { outgoing: [], incoming: [] };
    const tab = await orders();
    tab.tableView.set({ schema: 'a.b', table: 'c', spec: EMPTY_SPEC });
    await relations.ensure(tab);
    tab.tableView.set({ schema: 'a', table: 'b.c', spec: EMPTY_SPEC });
    await relations.ensure(tab);
    expect(schema.calls.filter((c) => c.startsWith('relations'))).toHaveLength(2);
  });

  it('frees the result of a look also when its rows cannot be read, and counts one at a time', async () => {
    const tab = await orders([0, 0]);
    await relations.referencedBy(tab);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const run = query.run.bind(query);
    let running = 0;
    let most = 0;
    query.run = async (...args: Parameters<typeof run>) => {
      most = Math.max(most, ++running);
      await gate;
      running--;
      return run(...args);
    };
    relations.countAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(most).toBe(1);
    // closing the list ends the counting: the second key is never asked
    relations.close();
    open();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(most).toBe(1);
    expect(query.tableQueries.filter((q) => q.query.count)).toHaveLength(1);
    query.run = run;
    // a look whose rows cannot be read leaves no result behind
    const freed = query.freed.length;
    const shown = copier.current()!.result.resultId;
    const window = query.window.bind(query);
    query.window = (id: number, from: number, count: number) =>
      id === shown ? window(id, from, count) : Promise.reject({ code: 'io', message: 'gone' });
    tab.grid = grid([0, 1]);
    await relations.follow(tab, 'peek').catch(() => undefined);
    expect(query.freed.length).toBeGreaterThan(freed);
    expect(relations.dialog()).toBeNull();
  });

  it('follows a cell forward in the tab: the target filtered by the key, bound by the backend', async () => {
    const tab = await orders([0, 1]);
    await relations.follow(tab, 'here');
    const asked = query.tableQueries.at(-1)!;
    expect(asked.query).toMatchObject({
      schema: 'public',
      table: 'customer',
      conditions: [],
      keys: { columns: [{ column: 'id', kind: 'number', typeName: 'int4' }], rows: [['42']] },
    });
    expect(tab.tableView()).toMatchObject({ table: 'customer' });
    // the path: where the user came from, and where they are
    expect(tab.nav().entries.map((e) => e.title)).toEqual(['orders', 'customer']);
    expect(tab.nav().index).toBe(1);
    expect(relations.dialog()).toBeNull();
  });

  it('follows all marked rows at once and leaves out those without a key', async () => {
    const tab = await orders([0, 1]);
    copier.register(copier.current()!.result.resultId, () => ({ rows: [[0, 3]], columns: [1] }));
    await relations.follow(tab, 'here');
    expect(query.tableQueries.at(-1)!.query.keys?.rows).toEqual([['42'], ['7']]);
  });

  it('says so when the key of the row is NULL, and when the tab shows no table', async () => {
    const tab = await orders([2, 1]);
    await relations.follow(tab, 'here');
    expect(tabs.notice()).toContain('NULL');
    expect(tab.tableView()).toMatchObject({ table: 'orders' });
    tab.tableView.set(null);
    tabs.notice.set(null);
    await relations.follow(tab, 'here');
    expect(tabs.notice()).toContain('Daten öffnen');
  });

  it('goes back and forward along the path, and on from the middle', async () => {
    const tab = await orders([0, 1]);
    await relations.follow(tab, 'here');
    expect([relations.canBack(tab), relations.canForward(tab)]).toEqual([true, false]);
    await relations.back(tab);
    expect(tab.tableView()).toMatchObject({ table: 'orders' });
    expect(tab.tableView()?.spec.keys ?? null).toBeNull();
    expect([relations.canBack(tab), relations.canForward(tab)]).toEqual([false, true]);
    await relations.forward(tab);
    expect(tab.tableView()).toMatchObject({
      table: 'customer',
      spec: { keys: { rows: [['42']] } },
    });
    await relations.go(tab, 0);
    expect(tab.nav().index).toBe(0);
    await relations.go(tab, 9);
    expect(tab.nav().index).toBe(0);
  });

  it('lists who points to the row, counts on request and opens the choice', async () => {
    const tab = await orders([0, 0]);
    await relations.referencedBy(tab);
    const d = relations.dialog();
    expect(d).toMatchObject({ kind: 'list', direction: 'backward', table: 'orders' });
    if (d?.kind !== 'list') throw new Error('no list');
    expect(d.items.map((i) => i.label)).toEqual(['lines (order_id)', 'audit (order_id)']);
    expect(d.items[0].view?.spec.keys).toMatchObject({
      columns: [{ column: 'order_id' }],
      rows: [['1']],
    });
    // counting asks the backend for the same rows, counted
    query.columns = [{ name: 'count', kind: 'int', typeName: 'int8' }];
    query.rows = [[3]];
    await relations.count(0);
    expect(query.tableQueries.at(-1)!.query).toMatchObject({ table: 'lines', count: true });
    const counted = relations.dialog();
    expect(counted?.kind === 'list' && counted.items[0].count).toBe(3);
    await relations.open(tab, d.items[1], 'here');
    expect(tab.tableView()).toMatchObject({ table: 'audit' });
    expect(relations.dialog()).toBeNull();
  });

  it('opens the relatives in a new tab with a path of its own', async () => {
    const tab = await orders([0, 1]);
    const before = tabs.tabs().length;
    await relations.follow(tab, 'tab');
    expect(tabs.tabs()).toHaveLength(before + 1);
    const next = tabs.active()!;
    expect(next).not.toBe(tab);
    expect(next.tableView()).toMatchObject({ table: 'customer' });
    expect(next.nav().entries.map((e) => e.title)).toEqual(['customer']);
    expect(tab.tableView()).toMatchObject({ table: 'orders' });
    expect(tab.nav().entries).toEqual([]);
  });

  it('shows a look at the referenced row without leaving the table', async () => {
    const tab = await orders([0, 1]);
    query.columns = [
      { name: 'id', kind: 'int', typeName: 'int4' },
      { name: 'name', kind: 'text', typeName: 'text' },
    ];
    query.rows = [[42, 'Ada']];
    await relations.follow(tab, 'peek');
    expect(relations.dialog()).toMatchObject({
      kind: 'peek',
      title: 'customer',
      rows: [[42, 'Ada']],
      more: false,
    });
    expect(tab.tableView()).toMatchObject({ table: 'orders' });
    // the look ran with the values bound, and its result is freed
    expect(query.params.at(-1)).toEqual([{ kind: 'text', value: '42' }]);
    expect(query.freed.length).toBeGreaterThan(0);
    await relations.openPeek('here');
    expect(tab.tableView()).toMatchObject({ table: 'customer' });
  });

  it('follows relations the user defined, kept per connection', async () => {
    schema.relationsOf['public.orders'] = { outgoing: [], incoming: [] };
    const tab = await orders([0, 1]);
    await relations.follow(tab, 'here');
    expect(tabs.notice()).toContain('keinen Fremdschlüssel');
    relations.define(tab);
    expect(relations.dialog()).toMatchObject({
      kind: 'define',
      table: 'orders',
      column: 'customer_id',
    });
    const connection = tab.connectionId();
    expect(
      relations.addVirtual(
        connection,
        { schema: 'public', table: 'orders', column: 'customer_id' },
        { schema: '', table: ' customer ', column: 'id' },
      ),
    ).toBe(true);
    expect(
      relations.addVirtual(
        connection,
        { schema: 'public', table: 'orders', column: 'customer_id' },
        { schema: '', table: '', column: 'id' },
      ),
    ).toBe(false);
    const stored = TestBed.inject(SettingsService).settings().virtualRelations[connection];
    expect(stored).toHaveLength(1);
    expect(relations.ownOf(connection, 'public', 'orders')[0]).toMatchObject({
      name: '',
      refSchema: 'public',
      refTable: 'customer',
    });
    relations.close();
    await relations.follow(tab, 'here');
    expect(tab.tableView()).toMatchObject({ table: 'customer' });
    relations.removeVirtual(connection, relations.virtual(connection)[0]);
    expect(TestBed.inject(SettingsService).settings().virtualRelations[connection]).toBeUndefined();
  });
});
