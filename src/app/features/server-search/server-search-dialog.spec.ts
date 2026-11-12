import { TestBed } from '@angular/core/testing';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { FindApi } from '../../core/find/find-api';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { QueryApi } from '../../core/sql/query-api';
import { SessionApi } from '../../core/session/session-api';
import {
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeFindApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { ObjectDetailsService } from '../details/details.service';
import { TabsStore } from '../tabs/tabs.store';
import { ServerSearchDialog } from './server-search-dialog';
import { SearchTarget, ServerSearchService } from './server-search.service';

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

const TARGET: SearchTarget = { connectionId: 'demo', schema: null, table: null };

describe('ServerSearchDialog', () => {
  let api: FakeFindApi;
  let clipboard: FakeClipboardApi;
  let queries: FakeQueryApi;

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.resetTestingModule();
    api = new FakeFindApi();
    clipboard = new FakeClipboardApi();
    queries = new FakeQueryApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: FindApi, useValue: api },
        { provide: ClipboardApi, useValue: clipboard },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: QueryApi, useValue: queries },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
      ],
    });
  });

  async function open(target: SearchTarget = TARGET) {
    await TestBed.inject(ConnectionsStore).load();
    await TestBed.inject(TabsStore).load();
    const service = TestBed.inject(ServerSearchService);
    service.request.set(target);
    const fixture = TestBed.createComponent(ServerSearchDialog);
    fixture.componentRef.setInput('target', target);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const type = async (text: string) => {
      const input = el.querySelector<HTMLInputElement>('#ss-text')!;
      input.value = text;
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };
    const click = async (text: string) => {
      const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
      expect(button, text).toBeDefined();
      button?.click();
      await settled(fixture);
    };
    return { fixture, el, type, click, service };
  }

  it('searches with what was chosen and shows the hits as text', async () => {
    api.events = [
      { type: 'start', tables: 2 },
      {
        type: 'rows',
        schema: 'public',
        table: 'customer',
        hits: [{ column: 'mail', preview: '<b>max</b>@example.com' }],
        more: false,
      },
      {
        type: 'source',
        hit: { kind: 'view', schema: 'public', name: 'big_orders', line: 3, preview: 'WHERE mail' },
      },
      { type: 'skipped', schema: 'public', name: 'orders', reason: 'large', message: '2500000' },
    ];
    api.report = {
      tables: 2,
      searched: 1,
      skipped: 1,
      rows: 1,
      sources: 1,
      cancelled: false,
      lost: false,
      resume: null,
      moreSources: false,
    };
    const { el, type, click } = await open();
    // nothing typed: nothing to search
    expect(el.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);
    await type('max');
    // the schemas that are not the system's are offered
    const schemas = [...el.querySelectorAll('.schemas label')].map((l) => l.textContent?.trim());
    expect(schemas).toEqual(['archive', 'public']);
    el.querySelectorAll<HTMLInputElement>('.schemas input')[1].click();
    await click('Suchen');
    expect(api.runs[0]).toMatchObject({
      connectionId: 'demo',
      spec: { text: 'max', mode: 'contains', schemas: ['public'], data: true, sources: true },
    });
    const previews = [...el.querySelectorAll('.preview')].map((p) => p.textContent);
    expect(previews).toEqual(['<b>max</b>@example.com', 'WHERE mail', 'etwa 2500000 Zeilen']);
    expect(el.querySelector('.results b')).toBeNull();
    expect(el.querySelector('.status')?.textContent).toBe(
      '1 Zeile, 1 Definition gefunden. 1 Tabelle ausgelassen.',
    );
    await click('Treffer kopieren');
    expect(clipboard.texts[0]).toContain('row\tpublic\tcustomer\tmail\t<b>max</b>@example.com');
  });

  it('stops a search that runs and keeps what was found', async () => {
    api.hold = true;
    api.events = [
      { type: 'start', tables: 2000 },
      { type: 'table', done: 41, schema: 'public', table: 'orders' },
      {
        type: 'rows',
        schema: 'public',
        table: 'customer',
        hits: [{ column: 'name', preview: 'needle' }],
        more: false,
      },
    ];
    const { el, type, click } = await open();
    await type('needle');
    await click('Suchen');
    expect(el.querySelector('.status')?.textContent).toBe('Tabelle 42 von 2.000: public.orders');
    await click('Abbrechen');
    expect(api.cancelled.length).toBe(1);
    expect(el.querySelector('.status')?.textContent).toMatch(/^Abgebrochen\./);
    expect(el.querySelectorAll('.results li').length).toBe(1);
  });

  it('opens the rows of a hit as a table filtered by the text, and a definition in the details', async () => {
    api.events = [
      {
        type: 'rows',
        schema: 'public',
        table: 'customer',
        hits: [{ column: 'mail', preview: 'max@example.com' }],
        more: false,
      },
      {
        type: 'source',
        hit: { kind: 'view', schema: 'public', name: 'big_orders', line: 3, preview: 'x' },
      },
    ];
    const { el, type, click, service } = await open();
    await type("max' --");
    await click('Suchen');
    await click('Definition zeigen');
    expect(TestBed.inject(ObjectDetailsService).current()).toMatchObject({
      connectionId: 'demo',
      schema: 'public',
      name: 'big_orders',
      kind: 'view',
    });
    expect(service.request()).toBeNull();
    service.request.set(TARGET);
    await click('Zeilen zeigen');
    // the text went to the backend as the value of a condition
    expect(queries.tableQueries.at(-1)?.query).toMatchObject({
      schema: 'public',
      table: 'customer',
      conditions: [{ column: 'mail', op: 'containsNoCase', values: ["max' --"] }],
    });
    expect(el).toBeTruthy();
  });

  it('searches one table only when it was opened for one', async () => {
    const { el, type, click } = await open({
      connectionId: 'demo',
      schema: 'public',
      table: 'orders',
    });
    expect(el.querySelector('h2')?.textContent).toBe('In public.orders suchen');
    expect(el.querySelector('.schemas')).toBeNull();
    await type('x');
    await click('Suchen');
    expect(api.runs[0].spec).toMatchObject({
      schemas: ['public'],
      tables: [['public', 'orders']],
      sources: false,
    });
  });

  it('says why a search failed', async () => {
    api.fail = { code: 'unsupported', message: 'this database has no regular expressions' };
    const { el, type, click } = await open();
    await type('a+');
    await click('Suchen');
    expect(el.querySelector('.status')?.textContent).toContain('Die Suche ist gescheitert');
  });
});
