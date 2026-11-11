import { TestBed } from '@angular/core/testing';
import { FakeConnectionsApi, FakeQueryApi } from '../../../testing/fake-apis';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { QueryTab } from '../tabs/query-tab';
import { ParamValue } from './param-logic';
import type { ParamRequest } from './param.service';

/** Parameters in the run of a tab (prompt 025). The demo connection is SQLite: placeholders `?1` … */
describe('running statements with parameters', () => {
  let api: FakeQueryApi;
  let store: ConnectionsStore;
  let tab: QueryTab;
  let asked: ParamRequest[];
  let answer: Record<string, ParamValue> | null;
  let enabled: boolean;
  let forms: readonly string[] | undefined;
  const recorded: string[] = [];
  const notices: string[] = [];

  beforeEach(async () => {
    api = new FakeQueryApi();
    asked = [];
    answer = { kunde: { type: 'auto', text: '42' } };
    enabled = true;
    forms = undefined;
    recorded.length = 0;
    notices.length = 0;
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectionsApi, useValue: new FakeConnectionsApi() }],
    });
    store = TestBed.inject(ConnectionsStore);
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
        record: (ran) => void recorded.push(ran.sql),
        notify: (m) => void notices.push(m),
        params: {
          enabled: () => enabled,
          forms: () => forms,
          ask: (request) => {
            asked.push(request);
            return Promise.resolve(answer);
          },
        },
      },
    );
  });

  it('asks for the values, sends them bound and keeps them out of the text and the history', async () => {
    answer = { kunde: { type: 'auto', text: "'; DROP TABLE x; --" } };
    await tab.run('select * from orders where customer = :kunde');
    expect(asked.map((a) => [a.dialect, a.sqls, a.values])).toEqual([
      ['sqlite', ['select * from orders where customer = :kunde'], {}],
    ]);
    // the driver gets a placeholder and the value apart
    expect(api.statements).toEqual([
      { connection: 'demo', sql: 'select * from orders where customer = ?1' },
    ]);
    expect(api.params).toEqual([[{ kind: 'text', value: "'; DROP TABLE x; --" }]]);
    // what the user sees and what the history notes is the statement as written
    expect(tab.runs()[0].sql).toBe('select * from orders where customer = :kunde');
    expect(recorded).toEqual(['select * from orders where customer = :kunde']);
    // the messages show the value
    expect(tab.log()[0].values).toBe("kunde = '''; DROP TABLE x; --'");
    expect(tab.state().kind).toBe('done');
  });

  it('remembers the values of the tab and offers them the next time', async () => {
    await tab.run('select :kunde');
    answer = { ab: { type: 'date', text: '1.2.2026' } };
    await tab.run('select :kunde, :ab');
    expect(asked[1].values).toEqual({ kunde: { type: 'auto', text: '42' } });
    // the dialog answered only for `ab`: `kunde` keeps its value
    expect(api.params[1]).toEqual([
      { kind: 'int', value: '42' },
      { kind: 'date', value: '2026-02-01' },
    ]);
    expect(tab.paramValues()).toEqual({
      kunde: { type: 'auto', text: '42' },
      ab: { type: 'date', text: '1.2.2026' },
    });
  });

  it('runs again with the same values without asking', async () => {
    expect(tab.runAgain()).toBe(false);
    await tab.run('select :kunde');
    expect(tab.runAgain()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(asked.length).toBe(1);
    expect(api.statements.map((s) => s.sql)).toEqual(['select ?1', 'select ?1']);
    expect(api.params[1]).toEqual([{ kind: 'int', value: '42' }]);
  });

  it('does not run when the question is answered with no', async () => {
    answer = null;
    await tab.run('select :kunde');
    expect(api.statements).toEqual([]);
    expect(tab.runs()[0].kind).toBe('cancelled');
    expect(tab.running()).toBe(false);
  });

  it('asks once for a whole script and binds each statement on its own', async () => {
    answer = { a: { type: 'auto', text: '1' }, b: { type: 'list', text: 'x, y' } };
    await tab.runAll(['select :a', 'select 2', 'select :b, :a']);
    expect(asked.length).toBe(1);
    expect(api.statements.map((s) => s.sql)).toEqual([
      'select ?1',
      'select 2',
      'select ?1, ?2, ?3',
    ]);
    expect(api.params).toEqual([
      [{ kind: 'int', value: '1' }],
      [],
      [
        { kind: 'text', value: 'x' },
        { kind: 'text', value: 'y' },
        { kind: 'int', value: '1' },
      ],
    ]);
    expect(tab.log().map((l) => l.values)).toEqual(['a = 1', null, "b = ('x', 'y') · a = 1"]);
  });

  it('leaves statements alone that have none, that the app wrote, or when it is switched off', async () => {
    await tab.run("select '12:30', x::int, ':kunde'");
    await tab.run('select :kunde', 'app');
    enabled = false;
    await tab.run('select :kunde');
    forms = [];
    enabled = true;
    await tab.run('select :kunde');
    expect(asked).toEqual([]);
    expect(api.statements.map((s) => s.sql)).toEqual([
      "select '12:30', x::int, ':kunde'",
      'select :kunde',
      'select :kunde',
      'select :kunde',
    ]);
    expect(api.params.every((p) => p.length === 0)).toBe(true);
  });

  it('puts the place of an error where it is in the statement as written', async () => {
    const marks: unknown[] = [];
    tab.attach({
      clearMarks: () => undefined,
      markRunning: () => undefined,
      markError: (_s: readonly string[], _i: number, _m: string, details: unknown) =>
        void marks.push(details),
    } as never);
    answer = { ids: { type: 'list', text: '1, 2, 3' } };
    const written = 'select :ids, nmae from t';
    // the statement the database got: `select ?1, ?2, ?3, nmae from t` – `nmae` is its character 20
    api.error = { code: 'invalid_query', message: 'no such column', details: { position: 20 } };
    await tab.run(written);
    expect(marks).toEqual([{ position: written.indexOf('nmae') + 1 }]);
  });

  it('says so when a value from elsewhere is not what its type says', async () => {
    answer = { kunde: { type: 'number', text: 'x' } };
    await tab.run('select :kunde');
    expect(api.statements).toEqual([]);
    expect(notices[0]).toContain('kunde');
  });
});
