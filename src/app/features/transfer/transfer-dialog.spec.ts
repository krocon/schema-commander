import { TestBed } from '@angular/core/testing';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { TransferApi } from '../../core/transfer/transfer-api';
import {
  DEMO_PROFILE,
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
  FakeTransferApi,
} from '../../../testing/fake-apis';
import { GuardService } from '../guard/guard.service';
import { TransferDialog } from './transfer-dialog';
import { TransferSource } from './transfer.service';

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

describe('TransferDialog', () => {
  let api: FakeTransferApi;
  let query: FakeQueryApi;
  let files: FakeFileDialogApi;
  let schema: FakeSchemaApi;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    api = new FakeTransferApi();
    query = new FakeQueryApi();
    files = new FakeFileDialogApi();
    schema = new FakeSchemaApi();
    const connections = new FakeConnectionsApi();
    connections.profiles = [
      { ...DEMO_PROFILE, id: 'pg', name: 'Shop', kind: 'postgres', database: 'shop' },
      { ...DEMO_PROFILE, id: 'my', name: 'Lager', kind: 'mysql', database: 'lager' },
      { ...DEMO_PROFILE, id: 'off', name: 'Getrennt', kind: 'postgres' },
    ];
    TestBed.configureTestingModule({
      providers: [
        { provide: TransferApi, useValue: api },
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: files },
        { provide: ConnectionsApi, useValue: connections },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: schema },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: ClipboardApi, useValue: new FakeClipboardApi() },
      ],
    });
    const store = TestBed.inject(ConnectionsStore);
    await store.load();
    await store.connect('pg');
    await store.connect('my');
  });

  async function dialog(source: Partial<TransferSource> = {}) {
    const fixture = TestBed.createComponent(TransferDialog);
    fixture.componentRef.setInput('source', {
      connectionId: 'pg',
      schema: 'public',
      table: null,
      ...source,
    });
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.trim().startsWith(text),
      )!;
    const choose = async (target: string) => {
      const select = el.querySelector<HTMLSelectElement>('select')!;
      select.value = target;
      select.dispatchEvent(new Event('change'));
      await settled(fixture);
    };
    return { fixture, el, button, choose, closed: () => closed };
  }

  it('offers the tables of the schema and the connections that are connected', async () => {
    const { el, button } = await dialog();
    const tables = [...el.querySelectorAll('.tables label')].map((l) => l.textContent?.trim());
    expect(tables.length).toBeGreaterThan(0);
    const targets = [...el.querySelectorAll('select option')].map((o) => o.textContent?.trim());
    expect(targets).toContain('Lager');
    expect(targets).not.toContain('Getrennt');
    expect(el.querySelector('.status')?.textContent).toContain('verbundene Verbindung');
    expect(button('Zeigen').disabled).toBe(true);
  });

  it('plans with the table from the tree and the schema of the target', async () => {
    const { el, button, choose, fixture } = await dialog({ table: 'orders' });
    await choose('my');
    // MySQL: a schema is its database
    expect(el.querySelector<HTMLInputElement>('input[type=text]')?.value).toBe('lager');
    button('Zeigen').click();
    await settled(fixture);
    expect(api.plans[0]).toMatchObject({
      source: 'pg',
      target: 'my',
      request: {
        sourceSchema: 'public',
        targetSchema: 'lager',
        mode: 'append',
        withKeys: true,
        wholeTransaction: true,
        onError: 'abort',
      },
    });
    expect(api.plans[0].request.tables).toContain('orders');
    // what will happen: created, the columns, what is lost
    expect(el.textContent).toContain('wird angelegt');
    expect(el.textContent).toContain('2 von 2');
    expect(el.textContent).toContain('orders.at (timestamptz → datetime(6))');
    expect(el.textContent).toContain('2 Anweisungen im Ziel');
  });

  it('copies, shows how far it is, and reports per table', async () => {
    let open!: () => void;
    api.gate = new Promise<void>((r) => (open = r));
    const { el, button, choose, fixture } = await dialog({ table: 'orders' });
    await choose('my');
    button('Zeigen').click();
    await settled(fixture);
    button('Kopieren').click();
    await settled(fixture);
    expect(el.querySelector('.status')?.textContent).toContain(
      'Tabelle 1 von 1: orders – 800 Zeilen',
    );
    button('Anhalten').click();
    expect(api.cancelled.length).toBe(1);
    open();
    await settled(fixture);
    expect(el.querySelector('.status')?.textContent).toContain('Erledigt: 1.200 Zeilen kopiert');
    expect(el.querySelector('tbody')?.textContent).toContain('kopiert');
    expect(el.querySelector('tbody')?.textContent).toContain('1.200 von 1.200');
    expect(api.runs[0]).toMatchObject({ source: 'pg', target: 'my', errorPath: null });
    // the tree of the target reads again
    expect(schema.calls.length).toBeGreaterThan(0);
  });

  it('asks the guard of the target, and a no copies nothing', async () => {
    query.verdict = () => ({ class: 'ddl', need: 'confirm' });
    const { button, choose, fixture } = await dialog({ table: 'orders' });
    await choose('my');
    button('Zeigen').click();
    await settled(fixture);
    const guard = TestBed.inject(GuardService);
    button('Kopieren').click();
    await settled(fixture);
    expect(guard.request()?.connection.name).toBe('Lager');
    expect(guard.request()?.statements.length).toBe(2);
    guard.answer(null);
    await settled(fixture);
    expect(api.runs).toEqual([]);
    button('Kopieren').click();
    await settled(fixture);
    guard.answer({ typedName: null });
    await settled(fixture);
    expect(api.runs[0].confirmations.length).toBe(2);
  });

  it('asks where rows that are left out are noted', async () => {
    const { el, button, choose, fixture } = await dialog({ table: 'orders' });
    await choose('my');
    const skip = [...el.querySelectorAll<HTMLLabelElement>('label')].find((l) =>
      l.textContent?.includes('ausgelassen'),
    )!;
    skip.querySelector('input')!.click();
    await settled(fixture);
    button('Zeigen').click();
    await settled(fixture);
    // rows that are skipped are never all-or-nothing
    expect(api.plans[0].request).toMatchObject({ onError: 'skip', wholeTransaction: false });
    files.path = '/tmp/errors.csv';
    button('Kopieren').click();
    await settled(fixture);
    expect(api.runs[0].errorPath).toBe('/tmp/errors.csv');
  });

  it('says what failed and what stays, with the text of the database as text', async () => {
    api.report = {
      tables: [
        {
          table: 'orders',
          skipped: false,
          loaded: {
            read: 300,
            written: 0,
            skipped: 0,
            errors: [{ line: 201, reason: 'duplicate key <b>orders_pkey</b>' }],
            cancelled: false,
            failed: true,
            rolledBack: false,
            errorFile: false,
            cleared: true,
          },
          created: false,
          elapsedMs: 40,
          error: null,
        },
        {
          table: 'items',
          skipped: true,
          loaded: { ...api.report.tables[0].loaded, read: 0, written: 0 },
          created: false,
          elapsedMs: 0,
          error: null,
        },
      ],
      afterErrors: ['CREATE INDEX x – no'],
      cancelled: false,
    };
    const { el, button, choose, fixture } = await dialog({ table: 'orders' });
    await choose('my');
    button('Zeigen').click();
    await settled(fixture);
    button('Kopieren').click();
    await settled(fixture);
    const body = el.querySelector('tbody')?.textContent ?? '';
    expect(el.querySelector('.status')?.textContent).toContain('Nicht alles wurde kopiert');
    expect(body).toContain('fehlgeschlagen');
    expect(body).toContain('duplicate key <b>orders_pkey</b>');
    // written in blocks into a table that was emptied first: said, both (review 045, H3)
    expect(body).toContain('was davor geschrieben wurde, bleibt');
    expect(body).toContain('ihre alten Zeilen sind weg');
    expect(body).toContain('nicht begonnen');
    expect(el.querySelector('tbody b')).toBeNull();
    expect(el.textContent).toContain('CREATE INDEX x – no');
  });

  it('refuses a table copied into itself', async () => {
    const { el, button, choose } = await dialog({ table: 'orders' });
    await choose('pg');
    expect(el.querySelector('.status')?.textContent).toContain('nicht in sich selbst');
    expect(button('Zeigen').disabled).toBe(true);
  });

  it('shows why a plan could not be made', async () => {
    api.planError = { code: 'unsupported', message: 'a table has no column in common' };
    const { el, button, choose, fixture } = await dialog({ table: 'orders' });
    await choose('my');
    button('Zeigen').click();
    await settled(fixture);
    expect(el.querySelector('.status .warn')?.textContent).toBeTruthy();
    expect(api.runs).toEqual([]);
  });
});
