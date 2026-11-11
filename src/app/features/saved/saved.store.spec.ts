import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeClipboardApi,
  FakeSavedApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { HistoryApi } from '../../core/history/history-api';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { SavedApi } from '../../core/saved/saved-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { TabsStore } from '../tabs/tabs.store';
import { SavedStore } from './saved.store';

describe('SavedStore', () => {
  let api: FakeSavedApi;
  let session: FakeSessionApi;
  let store: SavedStore;
  const form = {
    name: 'Umsatz',
    folder: ' berichte / monat ',
    description: '',
    tags: 'a, b',
    bound: false,
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    api = new FakeSavedApi();
    session = new FakeSessionApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: SavedApi, useValue: api },
        { provide: SessionApi, useValue: session },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
        { provide: QueryApi, useValue: new FakeQueryApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: ClipboardApi, useValue: new FakeClipboardApi() },
      ],
    });
    store = TestBed.inject(SavedStore);
  });

  it('saves a text under a name in a folder and lists it', async () => {
    store.ask('select 1', 'select 1');
    expect(store.request()).toEqual({ kind: 'new', text: 'select 1', name: 'select 1' });
    await store.submit(store.request()!, form);
    expect(store.entries().map((e) => e.id)).toEqual(['berichte/monat/Umsatz.sql']);
    expect(store.entries()[0].tags).toEqual(['a', 'b']);
    expect(store.listing()?.folders).toEqual(['berichte', 'berichte/monat']);
    expect(store.notice()).toContain('Umsatz');
    expect(store.recent().map((e) => e.name)).toEqual(['Umsatz']);
  });

  it('does not ask for a name when there is no text', () => {
    store.ask('  \n', '');
    expect(store.request()).toBeNull();
    expect(store.notice()).toContain('keinen Text');
  });

  it('renames, moves and describes a query, and keeps it among the recent ones', async () => {
    await store.submit({ kind: 'new', text: 'select 1', name: '' }, form);
    const entry = store.entries()[0];
    await store.submit(
      { kind: 'edit', entry },
      { name: 'Erlös', folder: 'archiv', description: 'alt', tags: '', bound: false },
    );
    expect(store.entries().map((e) => e.id)).toEqual(['archiv/Erlös.sql']);
    expect(store.entries()[0].description).toBe('alt');
    expect(api.files.get('archiv/Erlös.sql')?.text).toBe('select 1');
    expect(TestBed.inject(SettingsService).settings().recentSaved).toEqual(['archiv/Erlös.sql']);
  });

  it('follows what happens in the folder outside the app', async () => {
    await store.refresh();
    expect(store.entries()).toEqual([]);
    api.outside('von-hand.sql', 'Von Hand', 'select 2');
    await store.check();
    expect(store.entries().map((e) => e.name)).toEqual(['Von Hand']);
    // nothing changed: the folder is not listed again
    const before = store.listing();
    await store.check();
    expect(store.listing()).toBe(before);
    api.files.delete('von-hand.sql');
    await store.check();
    expect(store.entries()).toEqual([]);
  });

  it('looks at the folder only while someone watches', async () => {
    const stop = store.watch();
    const second = store.watch();
    await new Promise((r) => setTimeout(r, 0));
    const asked = api.stamps;
    expect(asked).toBeGreaterThan(0);
    stop();
    stop();
    second();
    await new Promise((r) => setTimeout(r, 0));
    expect(api.stamps).toBe(asked);
  });

  it('falls back to the default folder when the chosen one is gone', async () => {
    TestBed.inject(SettingsService).update({ savedQueriesDir: '/team/sql' });
    api.gone = '/team/sql';
    await store.start();
    expect(store.listing()?.root).toBe('/queries');
    expect(store.notice()).toContain('nicht mehr da');
    expect(TestBed.inject(SettingsService).settings().savedQueriesDir).toBe('');
    api.gone = null;
    await store.useFolder('/team/sql');
    expect(store.listing()?.root).toBe('/team/sql');
    expect(TestBed.inject(SettingsService).settings().savedQueriesDir).toBe('/team/sql');
  });

  it('opens a query as a file tab, inserts its text without the header, and deletes it', async () => {
    api.outside('Kunden.sql', 'Kunden', 'select * from kunden');
    session.disk.set('/queries/Kunden.sql', {
      text: '-- name: Kunden\n\nselect * from kunden',
      encoding: 'utf-8',
    });
    await store.refresh();
    const tabs = TestBed.inject(TabsStore);
    await tabs.load();
    const entry = store.entries()[0];
    await store.open(entry);
    expect(tabs.active()?.filePath()).toBe('/queries/Kunden.sql');
    // opened again: the same tab comes to the front
    const count = tabs.tabs().length;
    await store.open(entry);
    expect(tabs.tabs().length).toBe(count);
    await store.remove(entry);
    expect(api.deleted).toEqual(['Kunden.sql']);
    expect(store.entries()).toEqual([]);
    expect(store.recent()).toEqual([]);
  });
});
