import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
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
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { TabBar } from './tab-bar';
import { TabsStore } from './tabs.store';

describe('TabBar', () => {
  beforeEach(() => TestBed.resetTestingModule());

  async function open() {
    TestBed.configureTestingModule({
      imports: [TabBar],
      providers: [
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
        { provide: QueryApi, useValue: new FakeQueryApi() },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    const store = TestBed.inject(TabsStore);
    await store.load();
    store.newTab();
    store.newTab();
    store.activate('tab-1');
    const fixture = TestBed.createComponent(TabBar);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const tabs = () => [...el.querySelectorAll<HTMLElement>('[role=tab]')];
    const key = (target: Element, k: string) => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      fixture.detectChanges();
    };
    const settle = async () => {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
    };
    return { fixture, store, el, tabs, key, settle };
  }

  it('is a tab list with one tab in the tab order', async () => {
    const { el, tabs } = await open();
    expect(el.querySelector('[role=tablist]')?.getAttribute('aria-label')).toBe('Abfragen');
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs()[0].getAttribute('aria-controls')).toBe('pane-tab-1');
  });

  it('moves with the arrows, Home and End, and shows the tab at once', async () => {
    const { store, tabs, key } = await open();
    key(tabs()[0], 'ArrowRight');
    expect(store.activeId()).toBe('tab-2');
    key(tabs()[1], 'End');
    expect(store.activeId()).toBe('tab-3');
    key(tabs()[2], 'ArrowRight');
    expect(store.activeId()).toBe('tab-1');
    key(tabs()[0], 'ArrowLeft');
    expect(store.activeId()).toBe('tab-3');
    key(tabs()[2], 'Home');
    expect(store.activeId()).toBe('tab-1');
  });

  it('closes with Delete, the close button and the middle button', async () => {
    const { store, tabs, key, settle, fixture } = await open();
    key(tabs()[0], 'Delete');
    await settle();
    expect(store.tabs().map((t) => t.id)).toEqual(['tab-2', 'tab-3']);
    tabs()[1].querySelector<HTMLButtonElement>('.close')!.click();
    await settle();
    expect(store.tabs().map((t) => t.id)).toEqual(['tab-2']);
    store.newTab();
    fixture.detectChanges();
    tabs()[1].dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    await settle();
    expect(store.tabs().length).toBe(1);
  });

  it('renames with F2: Enter keeps the name, Escape drops it, arrows stay in the field', async () => {
    const { store, el, tabs, key, settle } = await open();
    key(tabs()[0], 'F2');
    await settle();
    const field = () => el.querySelector<HTMLInputElement>('.rename')!;
    field().value = 'Monatsbericht';
    key(field(), 'ArrowRight');
    expect(store.activeId()).toBe('tab-1');
    key(field(), 'Enter');
    expect(store.tabs()[0].title()).toBe('Monatsbericht');
    expect(el.querySelector('.rename')).toBeNull();
    key(tabs()[0], 'F2');
    await settle();
    field().value = 'Verworfen';
    key(field(), 'Escape');
    expect(store.tabs()[0].title()).toBe('Monatsbericht');
  });

  it('offers a menu that can be worked with the keyboard', async () => {
    const { store, el, tabs, settle, fixture } = await open();
    tabs()[1].dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 20 }),
    );
    fixture.detectChanges();
    await settle();
    expect(store.activeId()).toBe('tab-2');
    const items = [...el.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
    expect(items.map((i) => i.textContent?.trim())).toContain('Andere schließen');
    items.find((i) => i.textContent?.includes('Andere schließen'))!.click();
    await settle();
    expect(store.tabs().map((t) => t.id)).toEqual(['tab-2']);
    expect(el.querySelector('[role=menu]')).toBeNull();
  });

  it('marks a changed file and carries the colour of the connection', async () => {
    const { store, tabs, fixture } = await open();
    const tab = store.tabs()[0];
    expect(tabs()[0].className).toContain('conn-3');
    tab.filePath.set('/x/a.sql');
    tab.dirty.set(true);
    fixture.detectChanges();
    expect(tabs()[0].querySelector('.dirty')?.getAttribute('aria-label')).toBe('geändert');
    tab.filePath.set(null);
    fixture.detectChanges();
    expect(tabs()[0].querySelector('.dirty')).toBeNull();
  });
});
