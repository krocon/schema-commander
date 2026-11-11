import { TestBed } from '@angular/core/testing';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { QueryApi } from '../../core/sql/query-api';
import { FakeConnectionsApi, FakeQueryApi } from '../../../testing/fake-apis';
import { QuerySession, statusText } from './query-session';

describe('QuerySession', () => {
  let api: FakeQueryApi;
  let connections: FakeConnectionsApi;
  let store: ConnectionsStore;
  let session: QuerySession;

  beforeEach(async () => {
    api = new FakeQueryApi();
    connections = new FakeConnectionsApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: QueryApi, useValue: api },
        { provide: ConnectionsApi, useValue: connections },
      ],
    });
    store = TestBed.inject(ConnectionsStore);
    session = TestBed.inject(QuerySession);
    await store.load();
  });

  it('runs on the active connection and shows the rows', async () => {
    await session.run('select 1');
    const state = session.state();
    expect(state.kind).toBe('done');
    expect(api.statements).toEqual([{ connection: 'demo', sql: 'select 1' }]);
    expect(statusText(state)).toBe('2 Zeilen · 3 ms');
  });

  it('opens a closed connection first', async () => {
    await store.disconnect('demo');
    await session.run('select 1');
    expect(session.state().kind).toBe('done');
    expect(store.state('demo').kind).toBe('open');
  });

  it('shows the message of the server on an error and keeps the connection', async () => {
    api.error = { code: 'invalid_query', message: 'near "selec": syntax error' };
    await session.run('selec 1');
    expect(session.state()).toEqual({
      kind: 'failed',
      sql: 'selec 1',
      message: 'Die Anweisung ist ungültig. near "selec": syntax error',
    });
    expect(store.state('demo').kind).toBe('open');
  });

  it('says why when the connection cannot be opened', async () => {
    await store.disconnect('demo');
    connections.failOpen = { code: 'connection_failed', message: 'refused' };
    await session.run('select 1');
    expect(session.state()).toMatchObject({
      kind: 'failed',
      message: 'Die Verbindung ist fehlgeschlagen. refused',
    });
    expect(api.statements).toEqual([]);
  });

  it('asks the backend to stop and shows a cancelled statement as such', async () => {
    api.error = { code: 'cancelled', message: 'cancelled' };
    const run = session.run('select sleep(60)');
    session.cancel();
    await run;
    expect(api.cancelled).toEqual(['demo']);
    expect(session.state()).toEqual({ kind: 'cancelled', sql: 'select sleep(60)' });
    expect(statusText(session.state())).toBe('Abgebrochen');
    // the backend dropped the connection: it shows as closed and is opened again by the next run
    expect(store.state('demo').kind).toBe('closed');
    api.error = null;
    await session.run('select 1');
    expect(session.state().kind).toBe('done');
  });

  it('opens the connection again when the backend lost it', async () => {
    api.errors.push({ code: 'not_connected', message: 'not connected' });
    await session.run('select 1');
    expect(session.state().kind).toBe('done');
    expect(api.statements.length).toBe(2);
    expect(connections.opened.filter((o) => o.id === 'demo').length).toBe(2);
  });

  it('drops the answer of an older statement', async () => {
    const first = session.run('select 1');
    const second = session.run('select 2');
    await Promise.all([first, second]);
    const state = session.state();
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
});
