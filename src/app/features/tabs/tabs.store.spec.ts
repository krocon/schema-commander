import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEMO_PROFILE,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeQueryApi,
  FakeHistoryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { SessionApi, TabMeta } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { QueryTab, TabEditor } from './query-tab';
import { SettingsService } from '../../core/settings/settings.service';
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
    goTo: () => Promise.resolve(),
    getText: () => Promise.resolve(editor.text),
    selectedText: () => Promise.resolve(''),
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
    expandStar: () => Promise.resolve(false),
    format: () => Promise.resolve('nothing'),
    toggleComment: () => Promise.resolve(),
    clearMarks: () => undefined,
    markRunning: () => undefined,
    markError: () => undefined,
    goToError: () => undefined,
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
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
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

  describe('split view (prompt 016)', () => {
    const layout = () =>
      store
        .groups()
        .map((g) => g.map((t) => t.id).join(' '))
        .join(' | ');

    async function three() {
      await start();
      store.newTab();
      store.newTab();
      store.activate('tab-2');
      return store;
    }

    it('splits by moving the tab in front to a second group, which gets the focus', async () => {
      await three();
      expect(store.isSplit()).toBe(false);
      store.split('row');
      expect(layout()).toBe('tab-1 tab-3 | tab-2');
      expect(store.activeId()).toBe('tab-2');
      expect(store.focusedGroup()).toBe(1);
      expect(store.shownIds()).toEqual(['tab-3', 'tab-2']);
      // both tabs on screen have their editor
      expect(
        store
          .tabs()
          .find((t) => t.id === 'tab-3')
          ?.mounted(),
      ).toBe(false);
      TestBed.tick();
      expect(
        store
          .tabs()
          .find((t) => t.id === 'tab-3')
          ?.mounted(),
      ).toBe(true);
      // a second split only changes how the groups lie
      store.split('column');
      expect(layout()).toBe('tab-1 tab-3 | tab-2');
      expect(store.splitDir()).toBe('column');
    });

    it('gives the only tab of the window a neighbour to split with', async () => {
      await start();
      store.split('row');
      expect(layout()).toBe('tab-1 | tab-2');
      expect(store.activeId()).toBe('tab-2');
    });

    it('changes the focused group, cycles inside it and opens new tabs there', async () => {
      await three();
      store.split('row');
      store.focusOtherGroup();
      expect(store.activeId()).toBe('tab-3');
      expect(store.shownIds()).toEqual(['tab-3', 'tab-2']);
      store.cycle(1);
      expect(store.activeId()).toBe('tab-1');
      store.cycle(1);
      expect(store.activeId()).toBe('tab-3');
      store.activate('tab-2');
      const tab = store.newTab();
      expect(tab.group()).toBe(1);
      expect(layout()).toBe('tab-1 tab-3 | tab-2 tab-4');
    });

    it('runs two tabs side by side on their own connections', async () => {
      await three();
      store.split('row');
      TestBed.inject(ConnectionsStore).activate('pg');
      store.focusOtherGroup();
      TestBed.tick();
      expect(store.active()?.connectionId()).toBe('demo');
      expect(TestBed.inject(ConnectionsStore).activeId()).toBe('demo');
      store.focusOtherGroup();
      TestBed.tick();
      // the connection shown as active follows the focused group
      expect(store.active()?.connectionId()).toBe('pg');
      expect(TestBed.inject(ConnectionsStore).activeId()).toBe('pg');
    });

    it('ends the split when a group is emptied, by closing or by moving', async () => {
      await three();
      store.split('row');
      await store.close('tab-2');
      expect(store.isSplit()).toBe(false);
      expect(layout()).toBe('tab-1 tab-3 | ');
      expect(store.activeId()).toBe('tab-3');
      expect(store.otherId()).toBeNull();
      store.split('row');
      expect(layout()).toBe('tab-1 | tab-3');
      store.moveToOtherGroup('tab-3');
      expect(layout()).toBe('tab-1 tab-3 | ');
      expect(store.activeId()).toBe('tab-3');
    });

    it('unsplits on request and keeps the tab in front', async () => {
      await three();
      store.split('row');
      store.unsplit();
      expect(layout()).toBe('tab-1 tab-2 tab-3 | ');
      expect(store.activeId()).toBe('tab-2');
    });

    it('drops a dragged tab at a place of its own or of the other group', async () => {
      await three();
      store.move('tab-1', 2);
      expect(ids()).toEqual(['tab-2', 'tab-3', 'tab-1']);
      store.move('tab-1', 0);
      expect(ids()).toEqual(['tab-1', 'tab-2', 'tab-3']);
      store.split('row');
      // onto the first place of the other group
      store.move('tab-1', 0, 1);
      expect(layout()).toBe('tab-3 | tab-1 tab-2');
      expect(store.activeId()).toBe('tab-1');
      // behind its last tab
      store.move('tab-1', 9);
      expect(layout()).toBe('tab-3 | tab-2 tab-1');
      // the last tab of a group leaves it: one group again
      store.move('tab-3', 0, 1);
      expect(store.isSplit()).toBe(false);
      // the only tab of the window has nowhere to go
      await store.closeOthers('tab-3');
      store.move('tab-3', 0, 1);
      expect(layout()).toBe('tab-3 | ');
    });

    it('keeps groups, shown tabs and direction over a restart', async () => {
      await three();
      store.split('column');
      store.focusOtherGroup();
      await vi.advanceTimersByTimeAsync(500);
      expect(session.session).toMatchObject({ active: 'tab-3', other: 'tab-2', split: 'column' });
      expect(session.session.tabs.map((t) => t.group)).toEqual([0, 1, 0]);
    });

    it('restores a split view and repairs a broken one', async () => {
      session.session = {
        version: 1,
        tabs: [meta('a'), meta('b', { group: 1 }), meta('c', { group: 1 })],
        active: 'c',
        other: 'a',
        split: 'column',
      };
      await start();
      expect(layout()).toBe('a | b c');
      expect(store.shownIds()).toEqual(['a', 'c']);
      expect(store.splitDir()).toBe('column');
      expect(store.focusedGroup()).toBe(1);
    });

    it('repairs a stored layout that names what is gone', async () => {
      session.session = {
        version: 1,
        tabs: [meta('a', { group: 1 }), meta('b', { group: 1 })],
        active: 'gone',
        other: 'gone',
        split: 'diagonal',
      };
      await start();
      // a second group alone is the first group
      expect(layout()).toBe('a b | ');
      expect(store.activeId()).toBe('a');
      expect(store.otherId()).toBeNull();
      expect(store.splitDir()).toBe('row');
    });
  });

  it('starts new and restored tabs with the commit mode of the settings', async () => {
    session.session = { version: 1, tabs: [meta('a')], active: 'a' };
    TestBed.inject(SettingsService).update({ autoCommit: false });
    await start();
    expect(store.active()?.manual()).toBe(true);
    expect(store.newTab().manual()).toBe(true);
    TestBed.inject(SettingsService).update({ autoCommit: true });
    expect(store.newTab().manual()).toBe(false);
    // a tab that is open keeps the mode it has
    expect(store.tabs()[0].manual()).toBe(true);
  });

  it('moves the result on screen into a tab of its own, kept there (prompt 041)', async () => {
    await start();
    const from = store.active()!;
    await from.runAll(['select * from a', 'select * from b']);
    from.show(1);
    const id = from.runs()[1].result!.resultId;
    store.detachResult(false);
    const to = store.active()!;
    expect(to).not.toBe(from);
    expect(to.startText).toBe('select * from b');
    expect(to.shownKept()).toMatchObject({ pinned: true, title: 'b' });
    expect(to.state()).toMatchObject({ kind: 'done', result: { resultId: id } });
    // the tab it came from has it no more – and did not free it
    expect(from.subTabs().map((t) => t.target)).toEqual([0]);
    expect(from.kept()).toEqual([]);
    expect(query.freed).toEqual([]);
  });
});
