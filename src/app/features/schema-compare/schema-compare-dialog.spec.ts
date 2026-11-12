import { TestBed } from '@angular/core/testing';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { CompareApi, CompareItem } from '../../core/compare/compare-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import {
  FakeClipboardApi,
  FakeCompareApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { TabsStore } from '../tabs/tabs.store';
import { SchemaCompareDialog } from './schema-compare-dialog';

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

const item = (
  id: string,
  kind: CompareItem['kind'],
  table: string | null,
  name: string,
  state: CompareItem['state'],
  left: string | null = null,
  right: string | null = null,
): CompareItem => ({ id, kind, table, name, state, left, right });

const ITEMS: CompareItem[] = [
  item('table:client', 'table', null, 'client', 'onlyRight', null, 'TABLE client\n  id integer'),
  item(
    'table:customer',
    'table',
    null,
    'customer',
    'onlyLeft',
    'TABLE customer\n  id integer',
    null,
  ),
  item(
    'table:orders',
    'table',
    null,
    'orders',
    'different',
    'TABLE orders\n  total <b>x</b>',
    'TABLE orders\n  total y',
  ),
  item(
    'column:orders.total',
    'column',
    'orders',
    'total',
    'different',
    'total <b>x</b>',
    'total y',
  ),
  item('table:same', 'table', null, 'same', 'same', 'TABLE same', 'TABLE same'),
];

describe('SchemaCompareDialog', () => {
  let api: FakeCompareApi;
  let files: FakeFileDialogApi;
  let session: FakeSessionApi;

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.resetTestingModule();
    api = new FakeCompareApi();
    api.items = ITEMS;
    files = new FakeFileDialogApi();
    session = new FakeSessionApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: CompareApi, useValue: api },
        { provide: FileDialogApi, useValue: files },
        { provide: SessionApi, useValue: session },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: QueryApi, useValue: new FakeQueryApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: ClipboardApi, useValue: new FakeClipboardApi() },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
      ],
    });
  });

  async function open() {
    await TestBed.inject(ConnectionsStore).load();
    await TestBed.inject(TabsStore).load();
    const fixture = TestBed.createComponent(SchemaCompareDialog);
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const click = async (text: string, nth = 0) => {
      const button = [...el.querySelectorAll('button')].filter((b) =>
        b.textContent?.includes(text),
      )[nth];
      expect(button, text).toBeDefined();
      button?.click();
      await settled(fixture);
    };
    const pick = async (selector: string, value: string) => {
      const select = el.querySelector<HTMLSelectElement>(selector)!;
      select.value = value;
      select.dispatchEvent(new Event('change'));
      await settled(fixture);
    };
    const rows = () =>
      [...el.querySelectorAll('.list li .row')].map((row) =>
        [...row.querySelectorAll('span')].map((span) => span.textContent?.trim()).join(' '),
      );
    return { fixture, el, click, pick, rows };
  }

  /** Both sides on the demo connection: `public` against `archive`. */
  async function compared() {
    const dialog = await open();
    await dialog.pick('#sc-conn-right', 'demo');
    await dialog.pick('#sc-schema-right', 'archive');
    await dialog.click('Vergleichen');
    return dialog;
  }

  it('compares the schemas of two sides and lists what differs', async () => {
    const { el, click, pick, rows } = await open();
    // the connection in front is the left side, with the schema names are looked up in
    expect(el.querySelector<HTMLSelectElement>('#sc-conn-left')?.value).toBe('demo');
    expect(el.querySelector<HTMLSelectElement>('#sc-schema-left')?.value).toBe('public');
    expect(el.querySelector('.status')?.textContent).toContain('Auf beiden Seiten');
    await pick('#sc-conn-right', 'demo');
    await pick('#sc-schema-right', 'archive');
    await click('Vergleichen');
    expect(api.compared[0]).toMatchObject({
      left: { schema: 'public' },
      right: { schema: 'archive' },
      renames: [],
    });
    expect(rows()).toEqual([
      'Tabelle client nur rechts',
      'Tabelle customer nur links',
      'Tabelle orders verschieden',
      'Spalte orders.total verschieden',
    ]);
    expect(el.querySelector('.status')?.textContent).toBe(
      'Nur links: 1 · nur rechts: 1 · verschieden: 2 · gleich: 1',
    );
    // what is the same shows when asked
    el.querySelector<HTMLInputElement>('.bar input[type=checkbox]')!.click();
    await new Promise((r) => setTimeout(r));
    expect(rows().length).toBe(5);
  });

  it('shows the two definitions of an item side by side, as text', async () => {
    const { el, click } = await compared();
    await click('orders.total');
    const cells = [...el.querySelectorAll('.diff tbody td')].map((td) => td.textContent);
    expect(cells).toEqual(['total <b>x</b>', 'total y']);
    expect(el.querySelector('.diff b')).toBeNull();
    expect(el.querySelector('.diff tbody tr')?.className).toBe('changed');
  });

  it('opens the script for the picked differences in a tab on the target', async () => {
    const { el, click } = await compared();
    // not the table that is only on the right
    el.querySelector<HTMLInputElement>('.list li input[type=checkbox]')!.click();
    await click('Skript: rechts wie links machen');
    expect(api.scripted[0]).toMatchObject({
      source: { schema: 'public' },
      target: { schema: 'archive' },
      picks: ['table:customer', 'table:orders', 'column:orders.total'],
      renames: [],
    });
    const tab = TestBed.inject(TabsStore).active();
    expect(tab?.title()).toBe('Migration von archive');
    expect(tab?.connectionId()).toBe('demo');
  });

  it('takes two items as one thing that was renamed, and turns that round for the other way', async () => {
    api.itemsWithRenames = [ITEMS[2], ITEMS[3], ITEMS[4]];
    const { el, click, rows } = await compared();
    await click('client');
    await click('customer');
    await click('Diese beiden sind eins');
    expect(api.compared.at(-1)?.renames).toEqual([{ table: null, from: 'client', to: 'customer' }]);
    expect(rows()).toEqual(['Tabelle orders verschieden', 'Spalte orders.total verschieden']);
    expect(el.querySelector('.renames')?.textContent).toContain('client → customer');
    await click('Skript: links wie rechts machen');
    expect(api.scripted[0]).toMatchObject({
      source: { schema: 'archive' },
      target: { schema: 'public' },
      picks: null,
      renames: [{ table: null, from: 'customer', to: 'client' }],
    });
  });

  it('saves a snapshot and a report, and takes a snapshot from a file as one side', async () => {
    const { el, click } = await compared();
    files.path = '/out/public.snapshot.json';
    await click('Als Schnappschuss speichern', 0);
    const saved = session.disk.get('/out/public.snapshot.json')?.text ?? '';
    expect(JSON.parse(saved)).toMatchObject({ kind: 'postgres', schema: 'public' });
    files.path = '/out/report.md';
    await click('Bericht speichern');
    expect(session.disk.get('/out/report.md')?.text).toContain('| Tabelle | client | nur rechts |');
    // the file as the right side
    session.disk.set('/in/old.json', {
      text: '{"kind":"postgres","schema":"before","tables":[{"name":"a"}],"views":[]}',
      encoding: 'utf-8',
    });
    files.path = '/in/old.json';
    await click('Schnappschuss laden', 1);
    expect(el.querySelector('.file')?.textContent).toContain('Schnappschuss von before: 1 Tabelle');
    await click('Vergleichen');
    expect(api.compared.at(-1)).toMatchObject({ right: { schema: 'before' } });
    // a file that is none
    session.disk.set('/in/bad.json', { text: 'nope', encoding: 'utf-8' });
    files.path = '/in/bad.json';
    await click('Schnappschuss laden', 0);
    expect(el.querySelector('.status')?.textContent).toBe(
      'Diese Datei ist kein Schnappschuss eines Schemas.',
    );
  });

  it('says why a comparison failed', async () => {
    const { el, click, pick } = await open();
    await pick('#sc-conn-right', 'demo');
    api.fail = {
      code: 'unsupported',
      message: 'schemas of two kinds of database are not compared',
    };
    await click('Vergleichen');
    expect(el.querySelector('.status')?.textContent).toContain('Der Vergleich ist gescheitert');
  });
});
