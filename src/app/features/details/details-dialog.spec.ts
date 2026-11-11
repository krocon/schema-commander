import { HistoryApi } from '../../core/history/history-api';
import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { TabsStore } from '../tabs/tabs.store';
import { DetailsDialog } from './details-dialog';
import { ObjectDetailsService } from './details.service';

/** The grid and the editor do not render in jsdom: the dialog is tested with stand-ins. */
@Component({ selector: 'app-result-grid', template: '' })
class GridStub {
  readonly result = input<unknown>();
  readonly rows = input<number>(0);
  readonly fetch = input<unknown>();
  readonly local = input<unknown>();
}

@Component({ selector: 'app-sql-editor', template: '' })
class EditorStub {
  readonly initialValue = input('');
  readonly label = input('');
  readonly readonly = input(false);
}

describe('DetailsDialog', () => {
  let schema: FakeSchemaApi;
  let clipboard: FakeClipboardApi;

  beforeEach(() => {
    TestBed.resetTestingModule();
    schema = new FakeSchemaApi();
    clipboard = new FakeClipboardApi();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    TestBed.configureTestingModule({
      imports: [DetailsDialog],
      providers: [
        { provide: SchemaApi, useValue: schema },
        { provide: ClipboardApi, useValue: clipboard },
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
        { provide: QueryApi, useValue: new FakeQueryApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
      ],
    });
    TestBed.overrideComponent(DetailsDialog, { set: { imports: [GridStub, EditorStub] } });
  });

  async function open(name = 'orders') {
    const service = TestBed.inject(ObjectDetailsService);
    service.open({ connectionId: 'pg', schema: 'public', name, kind: 'table', detail: '' });
    const fixture = TestBed.createComponent(DetailsDialog);
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
    };
    await settle();
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const tabs = () => [...el.querySelectorAll<HTMLElement>('[role=tab]')];
    const names = () => tabs().map((t) => t.textContent!.replace(/\s+/g, ' ').trim());
    return { fixture, service, el, tabs, names, settle };
  }

  it('reads the object and shows its lists and the DDL as tabs', async () => {
    const { el, names, tabs, fixture } = await open();
    expect(schema.calls).toContain('details public.orders table');
    expect(el.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Tabelle public.orders',
    );
    expect(el.querySelector('[role=tablist]')?.getAttribute('aria-orientation')).toBe('vertical');
    expect(names()).toEqual(['Spalten 3', 'Verweist auf 1', 'Statistik 2', 'DDL']);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs().filter((t) => t.tabIndex === 0).length).toBe(1);
    expect(el.querySelector('.count')?.textContent).toBe('3 Zeilen');
    // the grid gets headers in the language on screen and the rows in memory
    const grid = fixture.debugElement.query((d) => d.name === 'app-result-grid')
      .componentInstance as GridStub;
    expect(
      (grid.result() as { columns: { name: string }[] }).columns.map((c) => c.name).slice(0, 3),
    ).toEqual(['Name', 'Typ', 'NULL']);
    expect((grid.local() as unknown[][])[1][0]).toBe('customer_id');
    // what the server refused is said, not hidden
    expect(el.textContent).toContain('nicht lesbar: Rechte.');
  });

  it('moves between the lists with the arrows and filters the one on screen', async () => {
    const { el, tabs, settle } = await open();
    const filter = () => el.querySelector<HTMLInputElement>('input[type=search]')!;
    filter().value = 'integer';
    filter().dispatchEvent(new Event('input'));
    await settle();
    expect(el.querySelector('.count')?.textContent).toBe('2 von 3 Zeilen');
    tabs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
    // another list starts unfiltered
    expect(filter().value).toBe('');
    tabs()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await settle();
    expect(tabs()[3].getAttribute('aria-selected')).toBe('true');
    expect(el.querySelector('input[type=search]')).toBeNull();
    tabs()[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
  });

  it('follows a relation to its object and comes back', async () => {
    const { el, tabs, service, settle } = await open();
    tabs()[1].click();
    await settle();
    const link = el.querySelector<HTMLButtonElement>('.links button')!;
    expect(link.textContent?.trim()).toBe('public.customer');
    link.click();
    await settle();
    await settle();
    expect(service.current()?.name).toBe('customer');
    expect(schema.calls.at(-1)).toBe('details public.customer table');
    expect(el.querySelector('h2')?.textContent).toContain('public.customer');
    // the object that has no DDL says so and cannot be copied
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('footer button')];
    expect(buttons[0].disabled).toBe(true);
    const back = el.querySelector<HTMLButtonElement>('header button')!;
    expect(back.getAttribute('aria-label')).toBe('Zurück zu orders');
    back.click();
    await settle();
    await settle();
    expect(service.current()?.name).toBe('orders');
    expect(service.trail()).toEqual([]);
  });

  it('copies the DDL and opens it in a new tab on the same connection', async () => {
    const { el, service, settle } = await open();
    const [copy, toTab] = [...el.querySelectorAll<HTMLButtonElement>('footer button')];
    copy.click();
    await settle();
    expect(clipboard.texts.at(-1)).toContain('CREATE TABLE public.orders');
    expect(el.querySelector('.message')?.textContent).toContain('Zwischenablage');
    const tabsStore = TestBed.inject(TabsStore);
    toTab.click();
    await settle();
    expect(service.current()).toBeNull();
    expect(tabsStore.active()?.title()).toBe('orders');
    expect(tabsStore.active()?.startText).toContain('CREATE TABLE public.orders');
  });

  it('says what went wrong instead of an empty dialog', async () => {
    schema.fail = { code: 'not_connected', message: '' };
    const { el } = await open();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('nicht geöffnet');
    expect(el.querySelector('[role=tablist]')).toBeNull();
  });
});
