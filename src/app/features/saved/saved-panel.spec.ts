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
import { QueryApi } from '../../core/sql/query-api';
import { ConfirmService } from '../../shared/confirm';
import { TabsStore } from '../tabs/tabs.store';
import { SavedPanel } from './saved-panel';
import { SavedStore } from './saved.store';

describe('SavedPanel', () => {
  let api: FakeSavedApi;
  let session: FakeSessionApi;

  beforeEach(() => {
    TestBed.resetTestingModule();
    api = new FakeSavedApi();
    session = new FakeSessionApi();
    api.outside('Kunden.sql', 'Kunden in Köln', "select * from kunden where ort = 'Köln'");
    api.outside('berichte/Umsatz.sql', 'Umsatz', 'select sum(total) from orders');
    session.disk.set('/queries/Kunden.sql', { text: 'select * from kunden', encoding: 'utf-8' });
    TestBed.configureTestingModule({
      imports: [SavedPanel],
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
  });

  async function open() {
    const fixture = TestBed.createComponent(SavedPanel);
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
    };
    await settle();
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const tree = el.querySelector<HTMLElement>('[role=tree]')!;
    const items = () =>
      [...el.querySelectorAll<HTMLElement>('[role=treeitem]')].map(
        (i) => `${i.getAttribute('aria-level')}:${i.querySelector('.name')?.textContent?.trim()}`,
      );
    const key = async (name: string, init: KeyboardEventInit = {}) => {
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }));
      await settle();
    };
    return { fixture, el, tree, items, key, settle };
  }

  it('shows the folder as a tree with one stop in the tab order', async () => {
    const { el, tree, items } = await open();
    expect(tree.tabIndex).toBe(0);
    expect(items()).toEqual(['1:berichte', '2:Umsatz', '1:Kunden in Köln']);
    expect(el.querySelector('[role=treeitem]')?.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('.path')?.textContent).toBe('/queries');
    expect(el.querySelector('footer')?.getAttribute('title')).toBe('/queries');
    // nothing selected yet: no preview
    expect(el.querySelector('.preview')).toBeNull();
  });

  it('moves with the arrows, closes and opens folders, and previews the query under the cursor', async () => {
    const { el, items, key } = await open();
    await key('ArrowDown');
    expect(el.querySelector('[aria-selected=true] .name')?.textContent?.trim()).toBe('berichte');
    await key('ArrowLeft');
    expect(items()).toEqual(['1:berichte', '1:Kunden in Köln']);
    await key('ArrowRight');
    await key('ArrowRight');
    expect(el.querySelector('[aria-selected=true] .name')?.textContent?.trim()).toBe('Umsatz');
    expect(el.querySelector('pre')?.textContent).toBe('select sum(total) from orders');
    // left on a query goes to its folder
    await key('ArrowLeft');
    expect(el.querySelector('[aria-selected=true] .name')?.textContent?.trim()).toBe('berichte');
    await key('End');
    expect(el.querySelector('pre')?.textContent).toContain('Köln');
  });

  it('searches names and texts and says when nothing matches', async () => {
    const { el, items, settle } = await open();
    const search = el.querySelector<HTMLInputElement>('input[type=search]')!;
    const type = async (text: string) => {
      search.value = text;
      search.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 250));
      await settle();
    };
    await type('orders');
    expect(api.searched).toEqual(['orders']);
    expect(items()).toEqual(['1:berichte', '2:Umsatz']);
    await type('gibt es nicht');
    expect(items()).toEqual([]);
    expect(el.textContent).toContain('Keine gespeicherte Abfrage passt.');
    await type('');
    expect(items().length).toBe(3);
  });

  it('opens on Enter, asks before deleting, and edits on F2', async () => {
    const { key } = await open();
    const store = TestBed.inject(SavedStore);
    const tabs = TestBed.inject(TabsStore);
    await tabs.load();
    await key('End');
    await key('Enter');
    await new Promise((r) => setTimeout(r, 0));
    expect(tabs.active()?.filePath()).toBe('/queries/Kunden.sql');
    await key('F2');
    expect(store.request()).toMatchObject({ kind: 'edit', entry: { id: 'Kunden.sql' } });
    const confirm = TestBed.inject(ConfirmService);
    await key('Delete');
    expect(confirm.request()?.message).toContain('Papierkorb');
    confirm.answer(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.deleted).toEqual([]);
    await key('Delete');
    confirm.answer(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.deleted).toEqual(['Kunden.sql']);
  });

  it('follows a file that appears in the folder', async () => {
    const { items, settle } = await open();
    api.outside('neu.sql', 'Neu von außen', 'select 3');
    await TestBed.inject(SavedStore).check();
    await settle();
    expect(items()).toContain('1:Neu von außen');
  });
});
