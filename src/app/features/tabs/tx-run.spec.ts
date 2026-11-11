import { TestBed } from '@angular/core/testing';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { ConfirmService } from '../../shared/confirm';
import {
  DEMO_PROFILE,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { TabsStore } from './tabs.store';

describe('transactions of a tab', () => {
  let query: FakeQueryApi;
  let tabs: TabsStore;
  let confirm: ConfirmService;
  let connections: ConnectionsStore;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    query = new FakeQueryApi();
    const api = new FakeConnectionsApi();
    api.profiles = [DEMO_PROFILE, { ...DEMO_PROFILE, id: 'pg', name: 'Shop' }];
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: api },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
      ],
    });
    connections = TestBed.inject(ConnectionsStore);
    await connections.load();
    tabs = TestBed.inject(TabsStore);
    await tabs.load();
    confirm = TestBed.inject(ConfirmService);
  });

  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it('runs on the session of the tab, in the mode of the tab', async () => {
    const tab = tabs.active()!;
    await tab.run('SELECT 1');
    tab.manual.set(true);
    await tab.run('UPDATE t SET a = 1 WHERE b = 2');
    expect(query.sessions).toEqual([
      { session: tab.id, manual: false },
      { session: tab.id, manual: true },
    ]);
  });

  it('follows what the server says: open, counted, closed', async () => {
    const tab = tabs.active()!;
    await tab.run('SELECT 1');
    expect(tab.tx()).toBe('idle');
    expect(tab.txSince()).toBeNull();
    query.tx = 'active';
    await tab.run('BEGIN');
    await tab.run('UPDATE t SET a = 1 WHERE b = 2');
    expect(tab.tx()).toBe('active');
    expect(tab.txStatements()).toBe(2);
    expect(tab.txSince()).not.toBeNull();
    // the user types COMMIT (or MySQL commits with a DDL): the server says idle
    query.tx = 'idle';
    await tab.run('COMMIT');
    expect(tab.tx()).toBe('idle');
    expect(tab.txStatements()).toBe(0);
    expect(tab.txSince()).toBeNull();
  });

  it('asks the server after a failed statement and shows a poisoned transaction', async () => {
    const tab = tabs.active()!;
    query.tx = 'active';
    await tab.run('BEGIN');
    query.tx = 'failed';
    query.errors.push({ code: 'invalid_query', message: 'relation "x" does not exist' });
    await tab.run('SELECT * FROM x');
    await settle();
    expect(tab.tx()).toBe('failed');
  });

  it('commits and rolls back, and says so in the messages', async () => {
    const tab = tabs.active()!;
    query.tx = 'active';
    await tab.run('UPDATE t SET a = 1 WHERE b = 2');
    expect(await tab.endTransaction(true)).toBeNull();
    expect(query.ended).toEqual([{ connection: 'demo', session: tab.id, commit: true }]);
    expect(tab.tx()).toBe('idle');
    expect(tab.log().at(-1)?.text).toBe('Transaktion bestätigt');
    query.tx = 'active';
    await tab.run('UPDATE t SET a = 1 WHERE b = 2');
    await tab.endTransaction(false);
    expect(query.ended[1].commit).toBe(false);
    expect(tab.log().at(-1)?.text).toBe('Transaktion zurückgerollt');
  });

  it('says why a commit failed and keeps what the server says', async () => {
    const tab = tabs.active()!;
    query.tx = 'active';
    await tab.run('UPDATE t SET a = 1 WHERE b = 2');
    query.error = { code: 'invalid_query', message: 'could not serialize access' };
    const problem = await tab.endTransaction(true);
    await settle();
    expect(problem).toContain('could not serialize access');
    expect(tab.tx()).toBe('active');
  });

  it('says so when the connection is lost in the middle of a transaction', async () => {
    const tab = tabs.active()!;
    query.tx = 'active';
    await tab.run('UPDATE t SET a = 1 WHERE b = 2');
    query.errors.push({ code: 'connection_failed', message: 'server closed the connection' });
    await tab.run('SELECT 1');
    expect(tab.tx()).toBe('idle');
    expect(tabs.notice()).toContain('mitten in einer Transaktion verloren');
  });

  it('closes its session with the tab', async () => {
    const tab = tabs.active()!;
    await tab.run('SELECT 1');
    await tabs.close(tab.id);
    expect(query.closedSessions).toEqual([tab.id]);
  });

  it('asks before a tab with an open transaction closes: stay', async () => {
    const tab = tabs.active()!;
    query.tx = 'active';
    await tab.run('UPDATE t SET a = 1 WHERE b = 2');
    const closing = tabs.close(tab.id);
    await settle();
    expect(confirm.request()).toMatchObject({ confirm: 'Commit', second: 'Rollback' });
    expect(confirm.request()?.message).toContain(tab.title());
    confirm.answer('no');
    await closing;
    expect(tabs.tabs()).toContain(tab);
    expect(query.ended).toEqual([]);
  });

  it('commits or rolls back as answered, then closes', async () => {
    for (const [answer, commit] of [
      ['yes', true],
      ['second', false],
    ] as const) {
      const tab = tabs.newTab('');
      query.tx = 'active';
      await tab.run('UPDATE t SET a = 1 WHERE b = 2');
      const closing = tabs.close(tab.id);
      await settle();
      confirm.answer(answer);
      await closing;
      expect(query.ended.at(-1)).toEqual({ connection: 'demo', session: tab.id, commit });
      expect(tabs.tabs()).not.toContain(tab);
    }
  });

  it('offers only a rollback for a failed transaction and stays when ending it fails', async () => {
    const tab = tabs.active()!;
    query.tx = 'failed';
    await tab.run('SELECT 1');
    const closing = tabs.close(tab.id);
    await settle();
    expect(confirm.request()).toMatchObject({ confirm: 'Rollback' });
    expect(confirm.request()?.second).toBeUndefined();
    query.error = { code: 'connection_failed', message: 'gone' };
    confirm.answer('yes');
    await closing;
    expect(query.ended.at(-1)?.commit).toBe(false);
    expect(tabs.tabs()).toContain(tab);
    expect(tabs.notice()).toContain('ließ sich nicht beenden');
  });

  it('settles every open tab before the window closes', async () => {
    const a = tabs.active()!;
    const b = tabs.newTab('');
    const idle = tabs.newTab('');
    query.tx = 'active';
    await a.run('UPDATE t SET a = 1 WHERE b = 2');
    await b.run('UPDATE t SET a = 1 WHERE b = 2');
    a.tx.set('active');
    const closing = tabs.settleTransactions(tabs.tabs(), 'Das Fenster');
    await settle();
    expect(confirm.request()?.message).toContain('2 Tabs mit offener Transaktion');
    confirm.answer('second');
    expect(await closing).toBe(true);
    expect(query.ended.map((e) => [e.session, e.commit])).toEqual([
      [a.id, false],
      [b.id, false],
    ]);
    // nothing is open: no question
    expect(await tabs.settleTransactions([idle], 'x')).toBe(true);
  });

  it('keeps a tab on its connection while its transaction is open', async () => {
    const tab = tabs.active()!;
    query.tx = 'active';
    await tab.run('UPDATE t SET a = 1 WHERE b = 2');
    connections.activate('pg');
    await settle();
    expect(tab.connectionId()).toBe('demo');
    expect(connections.activeId()).toBe('demo');
    expect(tabs.notice()).toContain('erst Commit oder Rollback');
    // afterwards the tab moves and leaves its old session
    await tab.endTransaction(true);
    connections.activate('pg');
    await settle();
    expect(tab.connectionId()).toBe('pg');
    expect(query.closedSessions).toContain(tab.id);
  });
});
