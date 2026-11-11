import { TestBed } from '@angular/core/testing';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SettingsService } from '../../core/settings/settings.service';
import { DEMO_PROFILE, FakeConnectionsApi, FakeHistoryApi } from '../../../testing/fake-apis';
import { HistoryService, RanStatement } from './history.service';

const ran = (over: Partial<RanStatement> = {}): RanStatement => ({
  at: 1000,
  connectionId: 'demo',
  sql: 'SELECT 1',
  elapsedMs: 5,
  rows: 1,
  outcome: 'ok',
  message: null,
  tab: 't1',
  origin: 'user',
  ...over,
});

describe('HistoryService', () => {
  let api: FakeHistoryApi;
  let history: HistoryService;
  let settings: SettingsService;

  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new FakeHistoryApi();
    const connections = new FakeConnectionsApi();
    connections.profiles = [
      { ...DEMO_PROFILE, database: 'shop' },
      { ...DEMO_PROFILE, id: 'prod', name: 'Produktion' },
    ];
    TestBed.configureTestingModule({
      providers: [
        { provide: ConnectionsApi, useValue: connections },
        { provide: HistoryApi, useValue: api },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    history = TestBed.inject(HistoryService);
    settings = TestBed.inject(SettingsService);
  });

  it('notes a statement with the name of its connection and how much to keep', async () => {
    history.record(ran({ outcome: 'failed', message: 'no such table', rows: null }));
    await settle();
    expect(api.added).toHaveLength(1);
    expect(api.added[0].entry).toMatchObject({
      connectionId: 'demo',
      connectionName: DEMO_PROFILE.name,
      database: 'shop',
      sql: 'SELECT 1',
      outcome: 'failed',
      message: 'no such table',
      origin: 'user',
    });
    expect(api.added[0].keep).toEqual({ maxEntries: 100_000, maxDays: 365 });
    expect(history.changed()).toBe(1);
  });

  it('notes nothing while the history is off, for all or for the connection', async () => {
    history.toggleConnection('prod');
    expect(history.enabled('prod')).toBe(false);
    expect(history.enabled('demo')).toBe(true);
    history.record(ran({ connectionId: 'prod' }));
    history.record(ran());
    await settle();
    expect(api.added.map((a) => a.entry.connectionId)).toEqual(['demo']);
    history.toggleConnection('prod');
    expect(history.enabled('prod')).toBe(true);
    settings.update({ historyEnabled: false });
    history.record(ran());
    await settle();
    expect(api.added).toHaveLength(1);
  });

  it('survives a history that cannot be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    api.add = () => Promise.reject({ code: 'io', message: 'disk full' });
    history.record(ran());
    await settle();
    expect(history.changed()).toBe(0);
    // the statement itself is never logged
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SELECT');
    warn.mockRestore();
  });

  it('walks back and forth through the statements of the connection', async () => {
    for (const [i, sql] of ['SELECT 1', 'SELECT 2', 'SELECT 3'].entries()) {
      history.record(ran({ sql, at: 1000 + i }));
    }
    history.record(ran({ sql: 'SELECT * FROM t LIMIT 200', origin: 'app' }));
    history.record(ran({ sql: 'SELECT prod', connectionId: 'prod' }));
    await settle();
    expect(await history.recalled('t1', 'demo', '', 1)).toBe('SELECT 3');
    expect(await history.recalled('t1', 'demo', 'SELECT 3', 1)).toBe('SELECT 2');
    expect(await history.recalled('t1', 'demo', 'SELECT 2', 1)).toBe('SELECT 1');
    // the oldest: nothing further
    expect(await history.recalled('t1', 'demo', 'SELECT 1', 1)).toBeNull();
    expect(await history.recalled('t1', 'demo', 'SELECT 1', -1)).toBe('SELECT 2');
    expect(await history.recalled('t1', 'demo', 'SELECT 2', -1)).toBe('SELECT 3');
    // forth beyond the latest: the empty editor it started with
    expect(await history.recalled('t1', 'demo', 'SELECT 3', -1)).toBe('');
    // the list was read once, without what the app wrote
    expect(api.filters).toEqual([{ connectionId: 'demo', userOnly: true, limit: 100 }]);
  });

  it('never replaces what was typed', async () => {
    history.record(ran({ sql: 'SELECT 1' }));
    await settle();
    expect(await history.recalled('t1', 'demo', 'DELETE FROM x', 1)).toBeNull();
    expect(await history.recalled('t1', 'demo', '', 1)).toBe('SELECT 1');
    expect(await history.recalled('t1', 'demo', 'SELECT 1 -- mine now', 1)).toBeNull();
  });

  it('starts over in another tab and after a new statement', async () => {
    history.record(ran({ sql: 'SELECT 1' }));
    await settle();
    expect(await history.recalled('t1', 'demo', '', 1)).toBe('SELECT 1');
    expect(await history.recalled('t2', 'demo', '', 1)).toBe('SELECT 1');
    history.record(ran({ sql: 'SELECT 2' }));
    await settle();
    expect(await history.recalled('t2', 'demo', '', 1)).toBe('SELECT 2');
  });
});
