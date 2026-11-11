import { TestBed } from '@angular/core/testing';
import { FakeConnectionsApi, FakeQueryApi } from '../../../testing/fake-apis';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { QueryTab } from './query-tab';
import { MAX_KEPT_RESULTS, runStatus, statusText } from './run-state';

describe('QueryTab', () => {
  let api: FakeQueryApi;
  let connections: FakeConnectionsApi;
  let store: ConnectionsStore;
  let tab: QueryTab;
  let options = { stopOnError: true, timeoutMs: 0 };

  beforeEach(async () => {
    options = { stopOnError: true, timeoutMs: 0 };
    api = new FakeQueryApi();
    connections = new FakeConnectionsApi();
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectionsApi, useValue: connections }],
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
      { api, connections: store, options: () => options },
    );
  });

  it('runs on its connection and shows the rows', async () => {
    await tab.run('select 1');
    expect(tab.state().kind).toBe('done');
    expect(api.statements).toEqual([{ connection: 'demo', sql: 'select 1' }]);
    expect(statusText(tab.state())).toBe('2 Zeilen · 3 ms');
    expect(tab.running()).toBe(false);
    expect(tab.log().map((l) => [l.kind, l.sql, l.text])).toEqual([['ok', 'select 1', '2 Zeilen']]);
  });

  it('opens a closed connection first', async () => {
    await store.disconnect('demo');
    await tab.run('select 1');
    expect(tab.state().kind).toBe('done');
    expect(store.state('demo').kind).toBe('open');
  });

  it('shows the message of the server on an error and keeps the connection', async () => {
    api.error = { code: 'invalid_query', message: 'near "selec": syntax error' };
    await tab.run('selec 1');
    expect(tab.state()).toEqual({
      kind: 'failed',
      sql: 'selec 1',
      message: 'Die Anweisung ist ungültig. near "selec": syntax error',
    });
    expect(store.state('demo').kind).toBe('open');
  });

  it('says why when the connection cannot be opened', async () => {
    await store.disconnect('demo');
    connections.failOpen = { code: 'connection_failed', message: 'refused' };
    await tab.run('select 1');
    expect(tab.state()).toMatchObject({
      kind: 'failed',
      message: 'Die Verbindung ist fehlgeschlagen. refused',
    });
    expect(api.statements).toEqual([]);
  });

  it('asks the backend to stop and shows a cancelled statement as such', async () => {
    api.error = { code: 'cancelled', message: 'cancelled' };
    const run = tab.run('select sleep(60)');
    expect(tab.running()).toBe(true);
    tab.cancel();
    await run;
    expect(api.cancelled).toEqual(['demo']);
    expect(tab.state()).toEqual({ kind: 'cancelled', sql: 'select sleep(60)' });
    expect(statusText(tab.state())).toBe('Abgebrochen');
    // the statement was cancelled on the server: the session is still there
    expect(store.state('demo').kind).toBe('open');
    api.error = null;
    await tab.run('select 1');
    expect(tab.state().kind).toBe('done');
  });

  it('opens the connection again when the backend lost it', async () => {
    api.errors.push({ code: 'not_connected', message: 'not connected' });
    await tab.run('select 1');
    expect(tab.state().kind).toBe('done');
    expect(api.statements.length).toBe(2);
    expect(connections.opened.filter((o) => o.id === 'demo').length).toBe(2);
  });

  it('lets a new run take the place of a running one', async () => {
    const first = tab.run('select 1');
    const second = tab.run('select 2');
    await Promise.all([first, second]);
    const state = tab.state();
    expect(state.kind === 'done' && state.sql).toBe('select 2');
    expect(tab.runs().length).toBe(1);
    // the older statement was asked to stop
    expect(api.cancelled).toEqual(['demo']);
  });

  it('runs a script in order and shows the first result with rows', async () => {
    await tab.runAll(['select 1', '  ', 'select 2', 'select 3']);
    expect(api.statements.map((s) => s.sql)).toEqual(['select 1', 'select 2', 'select 3']);
    expect(tab.runs().map((r) => r.kind)).toEqual(['done', 'done', 'done']);
    expect(tab.shown()).toBe(0);
    expect(tab.log().length).toBe(3);
    expect(runStatus(tab.runs(), 0)).toBe('3 Anweisungen · 3 ausgeführt · 9 ms');
  });

  it('leaves out the rest after an error and shows the error', async () => {
    api.errors.push(null, { code: 'invalid_query', message: 'no such table: x' });
    await tab.runAll(['select 1', 'select * from x', 'select 3']);
    expect(tab.runs().map((r) => r.kind)).toEqual(['done', 'failed', 'skipped']);
    expect(api.statements.length).toBe(2);
    expect(tab.shown()).toBe(1);
    expect(tab.state()).toMatchObject({ kind: 'failed' });
    expect(tab.log().map((l) => l.kind)).toEqual(['ok', 'error']);
    expect(runStatus(tab.runs(), 0)).toContain('1 mit Fehler · 1 nicht ausgeführt');
  });

  it('goes on after an error when the setting says so', async () => {
    options.stopOnError = false;
    api.errors.push({ code: 'invalid_query', message: 'boom' });
    await tab.runAll(['selec 1', 'select 2']);
    expect(tab.runs().map((r) => r.kind)).toEqual(['failed', 'done']);
    expect(tab.shown()).toBe(0);
  });

  it('stops a script where it was cancelled', async () => {
    api.errors.push(null, { code: 'cancelled', message: 'cancelled' });
    await tab.runAll(['select 1', 'select sleep(60)', 'select 3']);
    expect(tab.runs().map((r) => r.kind)).toEqual(['done', 'cancelled', 'cancelled']);
    expect(api.statements.length).toBe(2);
  });

  it('shows the messages when no statement of a script has rows', async () => {
    api.result = { ...api.result, columns: [], rows: [], rowsAffected: 3 };
    await tab.runAll(['update a set n = 1', 'delete from b']);
    expect(tab.shown()).toBe('messages');
    expect(tab.log().map((l) => l.text)).toEqual(['3 Zeilen geändert', '3 Zeilen geändert']);
  });

  it('keeps only the first results of a long script', async () => {
    await tab.runAll(Array.from({ length: MAX_KEPT_RESULTS + 2 }, (_, i) => `select ${i}`));
    const runs = tab.runs();
    expect(runs.filter((r) => r.result !== null).length).toBe(MAX_KEPT_RESULTS);
    const last = runs[runs.length - 1];
    expect(last.kind).toBe('done');
    expect(last.rows).toBe(2);
    tab.shown.set(runs.length - 1);
    expect(tab.state()).toMatchObject({ kind: 'failed' });
    expect(tab.log().length).toBe(MAX_KEPT_RESULTS + 2);
  });

  it('sends the time limit of the settings and names a timeout', async () => {
    options.timeoutMs = 5000;
    api.errors.push({ code: 'timeout', message: 'no answer within 5 s' });
    await tab.run('select sleep(60)');
    expect(api.timeouts).toEqual([5000]);
    expect(tab.state()).toMatchObject({
      kind: 'failed',
      message: 'Keine Antwort in der vorgesehenen Zeit.',
    });
    // the statement was ended on the server: the session is kept
    expect(store.state('demo').kind).toBe('open');
  });

  it('describes changed rows and cut off results', () => {
    const base = api.result;
    expect(
      statusText({ kind: 'done', sql: '', result: { ...base, rows: [], rowsAffected: 1 } }),
    ).toBe('1 Zeile geändert · 3 ms');
    expect(statusText({ kind: 'done', sql: '', result: { ...base, truncated: true } })).toBe(
      '2 Zeilen (abgeschnitten) · 3 ms',
    );
    expect(statusText({ kind: 'idle' })).toBe('Bereit');
  });

  it('remembers what it is', () => {
    tab.title.set('Kunden');
    tab.customTitle.set(true);
    tab.connectionId.set('pg');
    expect(tab.meta()).toEqual({
      id: 't',
      title: 'Kunden',
      customTitle: true,
      connection: 'pg',
      filePath: null,
      encoding: null,
    });
  });
});
