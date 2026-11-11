import { TestBed } from '@angular/core/testing';
import { FakeConnectionsApi, FakeQueryApi } from '../../../testing/fake-apis';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { QueryColumn } from '../../core/sql/query.models';
import { QueryTab } from '../tabs/query-tab';
import { EMPTY_SPEC, TableView } from './filter-logic';

/** Table views and local views in a tab (prompt 027). */
describe('sorting and filtering in a tab', () => {
  let api: FakeQueryApi;
  let tab: QueryTab;
  const applied: string[] = [];
  const notices: string[] = [];
  const view: TableView = { schema: 'shop', table: 'orders', spec: EMPTY_SPEC };
  const id: QueryColumn = { name: 'id', kind: 'int', typeName: 'INT4' };
  const name: QueryColumn = { name: 'name', kind: 'text', typeName: 'TEXT' };

  beforeEach(async () => {
    api = new FakeQueryApi();
    applied.length = 0;
    notices.length = 0;
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectionsApi, useValue: new FakeConnectionsApi() }],
    });
    const store = TestBed.inject(ConnectionsStore);
    await store.load();
    tab = new QueryTab(
      {
        id: 't',
        title: 'T',
        customTitle: false,
        connection: 'demo',
        filePath: null,
        encoding: null,
      },
      {
        api,
        connections: store,
        options: () => ({ stopOnError: true, timeoutMs: 0 }),
        notify: (m) => void notices.push(m),
        tableApplied: (c, v) => void applied.push(`${c}: ${v.spec.conditions.length}`),
      },
    );
  });

  const eq = (value: string) => ({
    column: 'name',
    op: 'eq' as const,
    values: [value],
    kind: 'text' as const,
    typeName: 'TEXT',
  });

  it('runs the statement the backend built, with its values bound', async () => {
    const evil = "'; DROP TABLE orders; --";
    await tab.openTable(view);
    await tab.applyTable({ ...EMPTY_SPEC, conditions: [eq(evil)] });
    // the backend was asked with what the user typed, and what ran is what it built: placeholders
    expect(api.tableQueries.at(-1)).toEqual({
      connection: 'demo',
      query: {
        schema: 'shop',
        table: 'orders',
        conditions: [eq(evil)],
        any: false,
        whereSql: null,
        order: [],
        limit: 1000,
        keys: null,
      },
    });
    expect(api.statements.at(-1)?.sql).toBe('SELECT * FROM shop.orders WHERE name eq ?');
    expect(api.statements.at(-1)?.sql).not.toContain('DROP');
    expect(api.params.at(-1)).toEqual([{ kind: 'text', value: evil }]);
    // what is shown is the readable form
    expect(tab.runs()[0].sql).toContain(`'${evil}'`);
    expect(tab.tableView()?.spec.conditions).toEqual([eq(evil)]);
    expect(applied).toEqual(['demo: 0', 'demo: 1']);
  });

  it('is an ordinary query tab again as soon as the user runs something', async () => {
    await tab.openTable(view);
    expect(tab.tableView()).not.toBeNull();
    await tab.run('select 1');
    expect(tab.tableView()).toBeNull();
    await tab.applyTable(EMPTY_SPEC);
    expect(api.statements.at(-1)?.sql).toBe('select 1');
  });

  it('leaves everything as it is when the backend refuses a condition', async () => {
    await tab.openTable(view);
    const ran = api.statements.length;
    api.error = { code: 'unsupported', message: 'no `;`' };
    await tab.applyTable({ ...EMPTY_SPEC, whereSql: '1=1; drop table x' });
    api.error = null;
    expect(api.statements.length).toBe(ran);
    expect(tab.tableView()?.spec).toEqual(EMPTY_SPEC);
    expect(notices.length).toBe(1);
  });

  it('adds a condition from a cell – a NULL cell becomes IS NULL, a long value none', async () => {
    await tab.openTable(view);
    api.values.set('1:0:1', { text: 'Köln' });
    expect(await tab.quickFilter('eq', { resultId: 1, row: 0, col: 1, column: name })).toBe(true);
    expect(tab.tableView()?.spec.conditions).toEqual([eq('Köln')]);
    expect(await tab.quickFilter('ne', { resultId: 1, row: 5, col: 0, column: id })).toBe(true);
    expect(tab.tableView()?.spec.conditions[1]).toMatchObject({ column: 'id', op: 'isNotNull' });
    api.values.set('1:1:1', { text: 'x'.repeat(5000) });
    expect(await tab.quickFilter('eq', { resultId: 1, row: 1, col: 1, column: name })).toBe(false);
    api.values.set('1:2:1', { bytes: new Uint8Array(3) });
    expect(await tab.quickFilter('gt', { resultId: 1, row: 2, col: 1, column: name })).toBe(false);
    expect(tab.tableView()?.spec.conditions.length).toBe(2);
    await tab.run('select 1');
    expect(await tab.quickFilter('null', { resultId: 1, row: 0, col: 0, column: id })).toBe(false);
  });

  it('looks at a result through a view of the store and frees it', async () => {
    await tab.run('select 1');
    const state = tab.state();
    const base = state.kind === 'done' ? state.result!.resultId : -1;
    await tab.setLocal({ text: 'ann', column: null, sort: [{ column: 0, desc: true }] });
    expect(api.views.at(-1)).toMatchObject({
      resultId: base,
      spec: { text: 'ann', column: null, sort: [{ column: 0, desc: true }] },
    });
    const first = tab.localView()!;
    expect(first).toMatchObject({ base, rows: 2 });
    // another spec: a new view, the old one is freed
    await tab.setLocal({ text: 'bob', column: 1, sort: [] });
    expect(api.freed).toContain(first.resultId);
    const second = tab.localView()!;
    // nothing to filter or sort by: the result as it is
    await tab.setLocal({ text: ' ', column: null, sort: [] });
    expect(tab.localView()).toBeNull();
    expect(api.freed).toContain(second.resultId);
    // a new run shows its result unfiltered
    await tab.setLocal({ text: 'x', column: null, sort: [] });
    const third = tab.localView()!;
    await tab.run('select 2');
    expect(tab.localView()).toBeNull();
    expect(tab.localSpec().text).toBe('');
    expect(api.freed).toContain(third.resultId);
  });

  it('says when a result is too big to sort here and keeps showing it', async () => {
    await tab.run('select 1');
    api.viewError = { code: 'too_large', message: '9000000 rows are too many to sort here' };
    await tab.setLocal({ text: '', column: null, sort: [{ column: 0, desc: false }] });
    expect(tab.localView()).toBeNull();
    expect(tab.viewProblem()).toContain('zu groß');
    expect(tab.viewBusy()).toBe(false);
  });
});
