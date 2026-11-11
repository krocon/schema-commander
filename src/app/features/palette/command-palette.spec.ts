import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionService } from '../../core/actions/action.service';
import { SettingsService } from '../../core/settings/settings.service';
import {
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSavedApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SavedApi } from '../../core/saved/saved-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { ObjectDetailsService } from '../details/details.service';
import { TabsStore } from '../tabs/tabs.store';
import { CommandPalette } from './command-palette';

const schema = { api: new FakeSchemaApi(), clipboard: new FakeClipboardApi() };
const saved = { api: new FakeSavedApi(), session: new FakeSessionApi() };
const providers = () => [
  { provide: SchemaApi, useValue: schema.api },
  { provide: ClipboardApi, useValue: schema.clipboard },
  { provide: SessionApi, useValue: saved.session },
  { provide: SavedApi, useValue: saved.api },
  { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
  { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
  { provide: QueryApi, useValue: new FakeQueryApi() },
  { provide: HistoryApi, useValue: new FakeHistoryApi() },
];

describe('CommandPalette', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    proto['showModal'] = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto['close'] = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  async function open() {
    TestBed.configureTestingModule({ imports: [CommandPalette], providers: providers() });
    const actions = TestBed.inject(ActionService);
    const settings = TestBed.inject(SettingsService);
    actions.platform.set('macos');
    await actions.load();
    const sidebar = vi.fn();
    const scheme = vi.fn();
    actions.register('TOGGLE_SIDEBAR', sidebar);
    actions.register('COLOR_SCHEME', scheme);
    actions.register('OPEN_PALETTE', vi.fn());
    const fixture = TestBed.createComponent(CommandPalette);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const field = el.querySelector<HTMLInputElement>('input')!;
    const type = (text: string) => {
      field.value = text;
      field.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const key = (k: string) => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      fixture.detectChanges();
    };
    const labels = () => [...el.querySelectorAll('li .label')].map((l) => l.textContent?.trim());
    return { el, field, type, key, labels, sidebar, scheme, closed, settings };
  }

  it('lists the actions with their shortcuts, without itself, unregistered ones dimmed', async () => {
    const { el, labels } = await open();
    expect(labels()).toContain('Seitenleiste ein-/ausblenden');
    expect(labels()).not.toContain('Befehlspalette');
    const row = (text: string) =>
      [...el.querySelectorAll('li')].find((li) => li.textContent?.includes(text))!;
    expect(row('Seitenleiste').querySelector('kbd')?.textContent).toBe('⌘B');
    expect(row('Seitenleiste').classList.contains('off')).toBe(false);
    expect(row('In den Editor').getAttribute('aria-disabled')).toBe('true');
  });

  it('filters while typing, moves with the arrows and runs on Enter after closing', async () => {
    const { el, type, key, labels, scheme, closed, settings, field } = await open();
    type('farb');
    expect(labels()[0]).toBe('Farbschema wählen …');
    expect(el.querySelector('.hit')?.textContent).toBe('Farb');
    expect(field.getAttribute('aria-activedescendant')).toBe('palette-option-COLOR_SCHEME');
    key('ArrowDown');
    key('ArrowUp');
    key('Enter');
    expect(closed).toHaveBeenCalled();
    expect(scheme).toHaveBeenCalledTimes(1);
    expect(settings.settings().recentActions).toEqual(['COLOR_SCHEME']);
  });

  it('does not run a dimmed action and says when nothing matches', async () => {
    const { el, type, key, closed } = await open();
    type('in den editor');
    key('Enter');
    expect(closed).not.toHaveBeenCalled();
    type('zzzz');
    expect(el.querySelector('.status')?.textContent).toContain('Kein Befehl');
  });

  it('puts recently used actions first', async () => {
    const { labels, settings } = await open();
    settings.update({ recentActions: ['COLOR_SCHEME'] });
    TestBed.tick();
    expect(labels()[0]).toBe('Farbschema wählen …');
  });
});

describe('go to anything (prompt 020)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    schema.api = new FakeSchemaApi();
    saved.api = new FakeSavedApi();
    saved.session = new FakeSessionApi();
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    proto['showModal'] = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto['close'] = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  async function open() {
    TestBed.configureTestingModule({ imports: [CommandPalette], providers: providers() });
    const actions = TestBed.inject(ActionService);
    actions.platform.set('linux');
    await actions.load();
    actions.register('TOGGLE_SIDEBAR', vi.fn());
    await TestBed.inject(ConnectionsStore).load();
    const tabs = TestBed.inject(TabsStore);
    await tabs.load();
    tabs.newTab('', { title: 'Offene Bestellungen', customTitle: true });
    const fixture = TestBed.createComponent(CommandPalette);
    fixture.componentRef.setInput('start', 'goto');
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
    };
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const field = el.querySelector<HTMLInputElement>('input')!;
    const type = async (text: string) => {
      field.value = text;
      field.dispatchEvent(new Event('input'));
      await settle();
    };
    const key = async (k: string, init: KeyboardEventInit = {}) => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
      await settle();
    };
    const labels = () => [...el.querySelectorAll('li .label')].map((l) => l.textContent?.trim());
    const status = () => el.querySelector('[role=status]')?.textContent?.trim();
    return { fixture, el, field, type, key, labels, status, settle, tabs };
  }

  it('searches tabs, connections and the names of the database of the tab in front', async () => {
    const { el, type, labels, status } = await open();
    expect(el.querySelector('dialog')?.getAttribute('aria-label')).toBe('Springen zu allem');
    await type('ord');
    expect(schema.api.nameQueries.at(-1)).toMatchObject({ query: 'ord' });
    // names of the database, with what they are and where
    expect(labels()).toEqual(['orders', 'order_items', 'big_orders']);
    expect(el.querySelector('li .where')?.textContent).toBe('public · Tabelle');
    expect(status()).toBe('3 Treffer');
    // an open tab comes first
    await type('bestell');
    expect(labels()).toEqual(['Offene Bestellungen']);
    expect(el.querySelector('li .where')?.textContent).toContain('Offener Tab');
    // `@` asks for connections only, and no name of the database
    const asked = schema.api.nameQueries.length;
    await type('@demo');
    expect(el.querySelector('li .where')?.textContent).toContain('Verbindung');
    expect(schema.api.nameQueries.length).toBe(asked);
    await type('q:x');
    expect(status()).toBe('Keine gespeicherte Abfrage passt.');
    await type('zzzz');
    expect(status()).toBe('Nichts passt.');
  });

  it('reads columns only when they are asked for', async () => {
    const { type, labels, el } = await open();
    await type('customer_id');
    expect(labels()).toEqual([]);
    await type('c:cust');
    expect(labels()).toEqual(['customer_id']);
    expect(el.querySelector('li .where')?.textContent).toBe('public.orders · integer · Spalte');
  });

  it('drops the answer to a question that was overtaken', async () => {
    const { type, labels, settle } = await open();
    let release: () => void = () => undefined;
    schema.api.nameGates.push(new Promise<void>((r) => (release = r)));
    // the answer to `twi` is still on its way when `ord` is asked and answered
    await type('twi');
    await type('ord');
    expect(labels()).toEqual(['orders', 'order_items', 'big_orders']);
    release();
    await settle();
    await settle();
    expect(labels()).toEqual(['orders', 'order_items', 'big_orders']);
  });

  it('opens the data of a table on Enter and its details on Shift+Enter', async () => {
    const { type, key, tabs } = await open();
    const details = TestBed.inject(ObjectDetailsService);
    await type('order_it');
    await key('Enter');
    await new Promise((r) => setTimeout(r, 0));
    expect(tabs.active()?.title()).toBe('order_items');
    expect(tabs.active()?.startText).toContain('FROM public.order_items');
    // what was gone to is remembered for the ranking
    expect(TestBed.inject(SettingsService).settings().recentObjects).toEqual([
      'public.order_items',
    ]);
    expect(details.current()).toBeNull();
  });

  it('shows the details with Shift+Enter, and for a routine with Enter', async () => {
    const first = await open();
    const details = TestBed.inject(ObjectDetailsService);
    await first.type('orders');
    await first.key('Enter', { shiftKey: true });
    expect(details.current()).toMatchObject({ schema: 'public', name: 'orders', kind: 'table' });
    details.close();
  });

  it('goes to an open tab', async () => {
    const { type, key, tabs } = await open();
    tabs.activate('tab-1');
    await type('bestell');
    await key('Enter');
    expect(tabs.active()?.title()).toBe('Offene Bestellungen');
  });

  it('finds saved queries behind q: and opens, inserts or runs them (prompt 024)', async () => {
    saved.api.outside('reports/Umsatz.sql', 'Umsatz je Monat', 'select sum(total) from orders');
    saved.api.outside('Kunden.sql', 'Kunden in Köln', 'select * from kunden');
    saved.session.disk.set('/queries/Kunden.sql', {
      text: '-- name: Kunden in Köln\n\nselect * from kunden',
      encoding: 'utf-8',
    });
    const { type, key, labels, tabs, el } = await open();
    await type('q:');
    expect(labels()).toEqual(['Kunden in Köln', 'Umsatz je Monat']);
    expect(el.querySelector('.keys')?.textContent).toContain('öffnen und ausführen');
    await type('q: köln');
    expect(labels()).toEqual(['Kunden in Köln']);
    await key('Enter');
    await new Promise((r) => setTimeout(r, 0));
    // the file of the query is a tab now
    expect(tabs.active()?.filePath()).toBe('/queries/Kunden.sql');
    expect(TestBed.inject(SettingsService).settings().recentSaved).toEqual(['Kunden.sql']);
  });

  it('changes to the commands with > and back with Backspace in the empty field', async () => {
    const { type, key, el, labels, field } = await open();
    await type('>seiten');
    expect(el.querySelector('dialog')?.getAttribute('aria-label')).toBe('Befehlspalette');
    expect(field.value).toBe('seiten');
    expect(labels()).toContain('Seitenleiste ein-/ausblenden');
    await type('');
    await key('Backspace');
    expect(el.querySelector('dialog')?.getAttribute('aria-label')).toBe('Springen zu allem');
  });
});
