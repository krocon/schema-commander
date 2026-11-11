import { TestBed } from '@angular/core/testing';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import {
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { TabsStore } from '../tabs/tabs.store';

describe('what a tab runs is in the history', () => {
  let history: FakeHistoryApi;
  let query: FakeQueryApi;
  let tabs: TabsStore;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    history = new FakeHistoryApi();
    query = new FakeQueryApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: HistoryApi, useValue: history },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    tabs = TestBed.inject(TabsStore);
    await tabs.load();
  });

  it('notes every statement of a script with its outcome, and a failure with its message', async () => {
    const tab = tabs.active()!;
    query.errors.push(null, { code: 'invalid_query', message: 'no such table: nope' });
    await tab.runAll(['SELECT 1', 'SELECT * FROM nope', 'SELECT 3']);
    const noted = history.added.map((a) => a.entry);
    expect(noted.map((e) => [e.sql, e.outcome])).toEqual([
      ['SELECT 1', 'ok'],
      ['SELECT * FROM nope', 'failed'],
    ]);
    expect(noted[1].message).toContain('no such table: nope');
    expect(noted[0]).toMatchObject({ connectionId: 'demo', tab: tab.id, origin: 'user' });
    expect(noted[0].rows).toBe(2);
    // what did not run is not in the history
    expect(noted.some((e) => e.sql === 'SELECT 3')).toBe(false);
  });

  it('marks what the app wrote itself', async () => {
    await tabs.active()!.run('SELECT * FROM orders LIMIT 200', 'app');
    expect(history.added[0].entry.origin).toBe('app');
  });
});
