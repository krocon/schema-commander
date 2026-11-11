import { TestBed } from '@angular/core/testing';
import { FakeConnectionsApi, FakeQueryApi } from '../../../testing/fake-apis';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { QueryTab } from './query-tab';
import { statusText } from './run-state';

describe('QueryTab', () => {
  let api: FakeQueryApi;
  let connections: FakeConnectionsApi;
  let store: ConnectionsStore;
  let tab: QueryTab;

  beforeEach(async () => {
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
      { api, connections: store },
    );
  });

  it('runs on its connection and shows the rows', async () => {
    await tab.run('select 1');
    expect(tab.state().kind).toBe('done');
    expect(api.statements).toEqual([{ connection: 'demo', sql: 'select 1' }]);
    expect(statusText(tab.state())).toBe('2 Zeilen · 3 ms');
    expect(tab.running()).toBe(false);
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
    // the backend dropped the connection: it shows as closed and is opened again by the next run
    expect(store.state('demo').kind).toBe('closed');
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

  it('drops the answer of an older statement', async () => {
    const first = tab.run('select 1');
    const second = tab.run('select 2');
    await Promise.all([first, second]);
    const state = tab.state();
    expect(state.kind === 'done' && state.sql).toBe('select 2');
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
