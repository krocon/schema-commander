import { SchemaApi } from '../../core/schema/schema-api';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEMO_PROFILE,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { SessionApi, TabMeta } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { QueryTab, TabEditor } from './query-tab';
import { TabsStore } from './tabs.store';

const meta = (id: string, over: Partial<TabMeta> = {}): TabMeta => ({
  id,
  title: `Tab ${id}`,
  customTitle: false,
  connection: 'demo',
  filePath: null,
  encoding: null,
  ...over,
});

/** An editor that holds a text, as the pane of a tab would attach it. */
function attachEditor(tab: QueryTab, text: string) {
  const editor: TabEditor & { text: string } = {
    text,
    getText: () => Promise.resolve(editor.text),
    setText: (t) => {
      editor.text = t;
      return Promise.resolve();
    },
    focus: vi.fn(),
    insert: (t) => {
      editor.text += t;
      return Promise.resolve();
    },
    runCurrent: () => Promise.resolve(),
    runScript: () => Promise.resolve(),
  };
  tab.attach(editor);
  return editor;
}

describe('TabsStore', () => {
  let session: FakeSessionApi;
  let files: FakeFileDialogApi;
  let connections: FakeConnectionsApi;
  let query: FakeQueryApi;
  let store: TabsStore;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
    session = new FakeSessionApi();
    files = new FakeFileDialogApi();
    connections = new FakeConnectionsApi();
    connections.profiles = [DEMO_PROFILE, { ...DEMO_PROFILE, id: 'pg', name: 'Shop', color: 1 }];
    query = new FakeQueryApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionApi, useValue: session },
        { provide: FileDialogApi, useValue: files },
        { provide: ConnectionsApi, useValue: connections },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  async function start() {
    await TestBed.inject(ConnectionsStore).load();
    store = TestBed.inject(TabsStore);
    await store.load();
    TestBed.tick();
    return store;
  }

  const ids = () => store.tabs().map((t) => t.id);

  it('starts with one empty tab and keeps the session', async () => {
    await start();
    expect(ids()).toEqual(['tab-1']);
    expect(store.active()?.title()).toBe('Abfrage');
    expect(store.active()?.mounted()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.session.tabs.map((t) => t.id)).toEqual(['tab-1']);
    expect(session.session.active).toBe('tab-1');
  });

  it('restores the tabs of the last run, building only the one in front', async () => {
    session.session = {
      version: 1,
      tabs: [meta('a'), meta('b', { connection: 'pg' }), meta('c', { connection: 'gone' })],
      active: 'b',
    };
    session.texts.set('b', 'SELECT 2');
    await start();
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(store.activeId()).toBe('b');
    expect(store.tabs().map((t) => t.mounted())).toEqual([false, true, false]);
    // a connection that is gone falls back to the demo
    expect(store.tabs()[2].connectionId()).toBe('demo');
    expect(await store.startText(store.tabs()[1])).toBe('SELECT 2');
    // the tab in front decides which connection shows as active
    expect(TestBed.inject(ConnectionsStore).activeId()).toBe('pg');
  });

  it('gives the tab in front the connection chosen in the list', async () => {
    await start();
    TestBed.inject(ConnectionsStore).activate('pg');
    TestBed.tick();
    expect(store.active()?.connectionId()).toBe('pg');
    const second = store.newTab();
    expect(second.connectionId()).toBe('pg');
  });

  it('keeps a connection chosen in the same turn as a tab switch', async () => {
    await start();
    const second = store.newTab();
    TestBed.inject(ConnectionsStore).activate('pg');
    TestBed.tick();
    expect(second.connectionId()).toBe('pg');
    expect(TestBed.inject(ConnectionsStore).activeId()).toBe('pg');
    // the first tab kept its own
    store.activate('tab-1');
    TestBed.tick();
    expect(TestBed.inject(ConnectionsStore).activeId()).toBe('demo');
  });

  it('backs up the text a moment after a change and names the tab after it', async () => {
    await start();
    const tab = store.active()!;
    const editor = attachEditor(tab, '');
    editor.text = 'SELECT * FROM orders';
    store.textChanged(tab, 20, true);
    expect(session.texts.has(tab.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(1300);
    expect(session.texts.get(tab.id)).toBe('SELECT * FROM orders');
    expect(tab.title()).toBe('orders');
    // typing on restarts the wait
    editor.text = 'SELECT 1';
    store.textChanged(tab, 8, true);
    await vi.advanceTimersByTimeAsync(600);
    store.textChanged(tab, 8, true);
    await vi.advanceTimersByTimeAsync(900);
    expect(session.texts.get(tab.id)).toBe('SELECT * FROM orders');
    await vi.advanceTimersByTimeAsync(400);
    expect(session.texts.get(tab.id)).toBe('SELECT 1');
  });

  it('writes waiting backups at once when asked to flush', async () => {
    await start();
    const tab = store.active()!;
    attachEditor(tab, 'SELECT 42');
    store.textChanged(tab, 9, true);
    store.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.texts.get(tab.id)).toBe('SELECT 42');
  });

  it('keeps a name the user gave and gives the title back to the text for an empty one', async () => {
    await start();
    const tab = store.active()!;
    attachEditor(tab, 'SELECT * FROM orders');
    store.rename(tab.id, '  Monatsbericht ');
    expect(tab.title()).toBe('Monatsbericht');
    store.textChanged(tab, 20, true);
    await vi.advanceTimersByTimeAsync(1300);
    expect(tab.title()).toBe('Monatsbericht');
    store.rename(tab.id, '   ');
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.customTitle()).toBe(false);
    expect(tab.title()).toBe('orders');
  });

  it('closes without a question and brings the tab back with its text', async () => {
    await start();
    const first = store.active()!;
    attachEditor(first, 'SELECT 1');
    const second = store.newTab();
    attachEditor(second, 'SELECT 2');
    store.rename(second.id, 'Zwei');
    await store.close(second.id);
    expect(ids()).toEqual(['tab-1']);
    expect(store.activeId()).toBe('tab-1');
    expect(session.texts.has(second.id)).toBe(false);
    expect(store.canReopen()).toBe(true);
    store.reopen();
    expect(ids()).toEqual(['tab-1', 'tab-2']);
    const back = store.active()!;
    expect(back.title()).toBe('Zwei');
    expect(await store.startText(back)).toBe('SELECT 2');
    expect(session.texts.get('tab-2')).toBe('SELECT 2');
    expect(store.canReopen()).toBe(false);
  });

  it('always leaves a tab, activates the neighbour and cycles', async () => {
    await start();
    await store.close('tab-1');
    expect(ids().length).toBe(1);
    store.newTab();
    store.newTab();
    const [a, b, c] = ids();
    store.activate(b);
    await store.close(b);
    expect(store.activeId()).toBe(c);
    store.cycle(1);
    expect(store.activeId()).toBe(a);
    store.cycle(-1);
    expect(store.activeId()).toBe(c);
    store.move(c, 0);
    expect(ids()).toEqual([c, a]);
    await store.closeOthers(c);
    expect(ids()).toEqual([c]);
  });

  it('stops the running statement of a tab that is closed', async () => {
    await start();
    const tab = store.active()!;
    attachEditor(tab, '');
    query.error = { code: 'cancelled', message: 'cancelled' };
    const run = tab.run('select sleep(60)');
    await store.close(tab.id);
    await run;
    expect(query.cancelled).toEqual(['demo']);
  });

  it('opens a file in a tab with its encoding and only once', async () => {
    await start();
    session.disk.set('/x/Bericht ä.sql', { text: 'SELECT 1;\r\n', encoding: 'windows-1252' });
    files.path = '/x/Bericht ä.sql';
    await store.openFiles();
    const tab = store.active()!;
    expect(tab.title()).toBe('Bericht ä.sql');
    expect(tab.encoding()).toBe('windows-1252');
    expect(await store.startText(tab)).toBe('SELECT 1;\r\n');
    expect(session.texts.get(tab.id)).toBe('SELECT 1;\r\n');
    store.activate('tab-1');
    await store.openFiles(['/x/Bericht ä.sql', '/x/fehlt.sql']);
    expect(ids().length).toBe(2);
    expect(store.activeId()).toBe(tab.id);
    expect(store.notice()).toContain('fehlt.sql');
  });

  it('saves to the file of the tab, asking for one first, and clears the changed mark', async () => {
    await start();
    const tab = store.active()!;
    attachEditor(tab, 'SELECT * FROM orders');
    tab.title.set('orders');
    tab.dirty.set(true);
    files.path = null;
    await store.save(tab.id);
    expect(session.disk.size).toBe(0);
    files.path = '/x/orders.sql';
    await store.save(tab.id);
    expect(files.asked[files.asked.length - 1]).toBe('SQL-Datei speichern: orders.sql');
    expect(session.disk.get('/x/orders.sql')).toEqual({
      text: 'SELECT * FROM orders',
      encoding: 'utf-8',
    });
    expect(tab.filePath()).toBe('/x/orders.sql');
    expect(tab.dirty()).toBe(false);
    // a second save needs no dialog
    const asked = files.asked.length;
    await store.save(tab.id);
    expect(files.asked.length).toBe(asked);
  });

  it('writes UTF-8 and says so when the old encoding cannot hold the text', async () => {
    await start();
    const tab = store.newTab('', { filePath: '/x/alt.sql', encoding: 'windows-1252' });
    attachEditor(tab, "SELECT '🚀'");
    session.refuses.add('windows-1252');
    await store.save(tab.id);
    expect(session.disk.get('/x/alt.sql')?.encoding).toBe('utf-8');
    expect(tab.encoding()).toBe('utf-8');
    expect(store.notice()).toContain('UTF-8');
  });

  it('duplicates a tab with its text and connection', async () => {
    await start();
    const tab = store.active()!;
    tab.connectionId.set('pg');
    attachEditor(tab, 'SELECT * FROM kunden');
    await store.duplicate(tab.id);
    const copy = store.active()!;
    expect(copy.id).not.toBe(tab.id);
    expect(copy.connectionId()).toBe('pg');
    expect(await store.startText(copy)).toBe('SELECT * FROM kunden');
  });
});
