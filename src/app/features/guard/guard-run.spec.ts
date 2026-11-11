import { TestBed } from '@angular/core/testing';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { Verdict } from '../../core/sql/query.models';
import {
  DEMO_PROFILE,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { TabsStore } from '../tabs/tabs.store';
import { GuardService } from './guard.service';

/** A stand-in for the backend's classifier: enough to tell the cases of these tests apart. */
function verdictOn(protection: 'free' | 'ask' | 'readonly') {
  return (sql: string): Verdict => {
    const s = sql.trim().toUpperCase();
    if (s.startsWith('SELECT')) return { class: 'read', need: 'nothing' };
    const dangerous = s.startsWith('DROP') || (s.startsWith('DELETE') && !s.includes('WHERE'));
    const cls = dangerous ? 'dangerous' : 'write';
    if (protection === 'readonly') return { class: cls, need: 'refused' };
    if (protection === 'ask') return { class: cls, need: dangerous ? 'type_name' : 'confirm' };
    return { class: cls, need: dangerous ? 'confirm' : 'nothing' };
  };
}

describe('running on a guarded connection', () => {
  let query: FakeQueryApi;
  let tabs: TabsStore;
  let guard: GuardService;

  async function setup(protection: 'free' | 'ask' | 'readonly') {
    TestBed.resetTestingModule();
    query = new FakeQueryApi();
    query.verdict = verdictOn(protection);
    query.connectionName = 'Kasse';
    const connections = new FakeConnectionsApi();
    connections.profiles = [{ ...DEMO_PROFILE, name: 'Kasse', protection, label: 'PROD' }];
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: connections },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    tabs = TestBed.inject(TabsStore);
    await tabs.load();
    guard = TestBed.inject(GuardService);
  }

  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const kinds = () =>
    tabs
      .active()!
      .runs()
      .map((r) => r.kind);

  it('runs what reads without a question', async () => {
    await setup('ask');
    await tabs.active()!.run('SELECT 1');
    expect(guard.request()).toBeNull();
    expect(kinds()).toEqual(['done']);
    expect(query.tokens).toEqual([null]);
  });

  it('asks once for a script and runs each guarded statement with its own token', async () => {
    await setup('ask');
    const sqls = ['SELECT 1', 'UPDATE t SET a = 1 WHERE b = 2', 'INSERT INTO t VALUES (1)'];
    const running = tabs.active()!.runAll(sqls);
    await settle();
    const request = guard.request()!;
    expect(request.connection.name).toBe('Kasse');
    expect(request.statements.map((s) => s.sql)).toEqual(sqls.slice(1));
    expect(request.total).toBe(3);
    // nothing ran yet
    expect(query.statements).toEqual([]);
    guard.answer({ typedName: null });
    await running;
    expect(kinds()).toEqual(['done', 'done', 'done']);
    expect(query.tokens[0]).toBeNull();
    expect(query.tokens[1]).toMatch(/^token-1-/);
    expect(query.tokens[2]).toMatch(/^token-2-/);
    expect(query.tokens[1]).not.toBe(query.tokens[2]);
  });

  it('runs nothing after a no', async () => {
    await setup('ask');
    const running = tabs.active()!.runAll(['SELECT 1', 'INSERT INTO t VALUES (1)']);
    await settle();
    guard.answer(null);
    await running;
    expect(query.statements).toEqual([]);
    expect(kinds()).toEqual(['cancelled', 'cancelled']);
    expect(tabs.active()!.running()).toBe(false);
  });

  it('wants the name of the connection for what destroys, and the backend checks it', async () => {
    await setup('ask');
    const running = tabs.active()!.run('DROP TABLE t');
    await settle();
    expect(guard.request()!.statements[0].verdict.need).toBe('type_name');
    // a window that sends a wrong name gets no token: the backend refuses the run
    guard.answer({ typedName: 'kasse' });
    await running;
    expect(kinds()).toEqual(['failed']);
    expect(query.tokens).toEqual([null]);

    const again = tabs.active()!.run('DROP TABLE t');
    await settle();
    guard.answer({ typedName: 'Kasse' });
    await again;
    expect(kinds()).toEqual(['done']);
  });

  it('shows the refusal of a read-only connection without asking', async () => {
    await setup('readonly');
    await tabs.active()!.runAll(['SELECT 1', 'INSERT INTO t VALUES (1)']);
    expect(guard.request()).toBeNull();
    expect(kinds()).toEqual(['done', 'failed']);
    expect(tabs.active()!.runs()[1].message).toContain('read only');
  });

  it('asks on a free connection only for what destroys, unless that is switched off', async () => {
    await setup('free');
    await tabs.active()!.run('UPDATE t SET a = 1 WHERE b = 2');
    expect(guard.request()).toBeNull();
    const running = tabs.active()!.run('DELETE FROM t');
    await settle();
    expect(guard.request()!.statements[0].verdict.class).toBe('dangerous');
    guard.answer({ typedName: null });
    await running;
    expect(kinds()).toEqual(['done']);
    // the setting travels to the backend with the run
    TestBed.inject(SettingsService).update({ confirmDangerous: false });
    const seen: boolean[] = [];
    const check = query.check.bind(query);
    query.check = (c, sqls, allow?: boolean) => {
      seen.push(allow === true);
      return check(c, sqls);
    };
    query.verdict = () => ({ class: 'dangerous', need: 'nothing' });
    await tabs.active()!.run('DELETE FROM t');
    expect(seen).toEqual([true]);
  });
});
