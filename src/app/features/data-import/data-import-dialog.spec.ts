import { TestBed } from '@angular/core/testing';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { DataImportApi } from '../../core/import/data-import-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { QueryApi } from '../../core/sql/query-api';
import {
  FakeConnectionsApi,
  FakeDataImportApi,
  FakeFileDialogApi,
  FakeQueryApi,
  FakeSchemaApi,
} from '../../../testing/fake-apis';
import { GuardService } from '../guard/guard.service';
import { DataImportDialog } from './data-import-dialog';
import { DataImportService, ImportTarget } from './data-import.service';

/** Lets what waits for the backend go on, then the page. */
async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

const TARGET: ImportTarget = { connectionId: 'demo', schema: 'public', table: 'orders' };

describe('DataImportDialog', () => {
  let api: FakeDataImportApi;
  let files: FakeFileDialogApi;
  let queries: FakeQueryApi;
  let schema: FakeSchemaApi;

  beforeEach(() => {
    // jsdom has no modal dialogs
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.resetTestingModule();
    api = new FakeDataImportApi();
    files = new FakeFileDialogApi();
    queries = new FakeQueryApi();
    schema = new FakeSchemaApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: DataImportApi, useValue: api },
        { provide: FileDialogApi, useValue: files },
        { provide: QueryApi, useValue: queries },
        { provide: SchemaApi, useValue: schema },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
      ],
    });
  });

  async function open(target: ImportTarget = TARGET) {
    await TestBed.inject(ConnectionsStore).load();
    const fixture = TestBed.createComponent(DataImportDialog);
    fixture.componentRef.setInput('target', target);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const click = async (text: string) => {
      const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
      expect(button, text).toBeDefined();
      button?.click();
      await fixture.whenStable();
    };
    const choose = async (selector: string, value: string) => {
      const select = el.querySelector<HTMLSelectElement>(selector)!;
      select.value = value;
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();
    };
    return { fixture, el, click, choose };
  }

  const sources = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLSelectElement>('.mapping select')].map((s) => s.value);

  it('shows the start of the chosen file as text and maps its columns to the table', async () => {
    const { el, click } = await open();
    // no file yet: nothing to start
    expect(el.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);
    expect(el.querySelector<HTMLSelectElement>('#di-table')?.value).toBe('orders');
    files.path = '/data/orders.csv';
    await click('Datei wählen');
    expect(api.previews.at(-1)).toMatchObject({
      path: '/data/orders.csv',
      options: { format: 'auto', delimiter: null, header: null },
      nulls: ['NULL', '\\N'],
    });
    expect(el.querySelector('.path')?.textContent).toBe('orders.csv');
    const cells = [...el.querySelectorAll('.preview td')].map((c) => c.textContent);
    // a value of the file is text, never markup
    expect(cells).toEqual(['1', '<b>bold</b>', 'x', '2', 'NULL', 'y']);
    expect(el.querySelector('.preview b')).toBeNull();
    expect(el.textContent).toContain('Trenner ; · mit Kopfzeile · UTF-8');
    // id ← ID, customer_id ← nothing, note ← Note
    expect(sources(el)).toEqual(['0', 'none', '1']);
    expect(el.textContent).toContain('Ohne Wert und ohne Vorgabe: customer_id');
    expect(el.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(false);
  });

  it('reads the file again when an option changes and keeps the mapping', async () => {
    const { el, click, choose } = await open();
    files.path = '/data/orders.csv';
    await click('Datei wählen');
    await choose('.mapping select[aria-label="Wert für customer_id"]', '2');
    const before = api.previews.length;
    await choose('#di-delimiter', ';');
    expect(api.previews.length).toBe(before + 1);
    expect(api.previews.at(-1)?.options.delimiter).toBe(';');
    expect(sources(el)).toEqual(['0', '2', '1']);
  });

  it('starts the import with the plan, asks the guard, and shows the report', async () => {
    const { fixture, el, click, choose } = await open();
    files.path = '/data/orders.csv';
    await click('Datei wählen');
    await choose('.mapping select[aria-label="Wert für customer_id"]', 'fixed');
    const fixed = el.querySelector<HTMLInputElement>('.mapping input')!;
    fixed.value = '42';
    fixed.dispatchEvent(new Event('input'));
    await choose('#di-onerror', 'skip');
    files.path = '/data/orders.errors.tsv';
    await click('Wählen');
    el.querySelector<HTMLInputElement>('fieldset:last-of-type input[type=checkbox]')!.click();
    await fixture.whenStable();
    // the connection wants a yes for what writes
    queries.verdict = (sql) =>
      sql.startsWith('DELETE')
        ? { class: 'dangerous', need: 'confirm' }
        : { class: 'write', need: 'confirm' };
    api.hold = true;
    api.done = {
      read: 5,
      written: 3,
      skipped: 2,
      errors: [{ line: 4, reason: 'NOT NULL constraint failed' }],
      cancelled: false,
      failed: false,
      rolledBack: false,
      errorFile: true,
      cleared: false,
    };
    await click('Importieren');
    const guard = TestBed.inject(GuardService);
    expect(guard.request()?.statements.map((s) => s.sql)).toEqual([
      'DELETE FROM orders',
      'INSERT INTO orders VALUES (?)',
    ]);
    expect(api.runs.length).toBe(0);
    guard.answer({ typedName: null });
    await settled(fixture);
    expect(api.runs.length).toBe(1);
    expect(api.runs[0]).toMatchObject({
      connectionId: 'demo',
      path: '/data/orders.csv',
      errorPath: '/data/orders.errors.tsv',
      plan: { schema: 'public', table: 'orders', clearFirst: true, onError: 'skip' },
    });
    expect(api.runs[0].confirmations.length).toBe(2);
    // read as the preview read it, not detected again
    expect(api.runs[0].options).toEqual({
      format: 'csv',
      delimiter: ';',
      quote: null,
      encoding: 'utf-8',
      header: true,
      skipLines: 0,
    });
    expect(api.runs[0].plan.mappings.map((m) => [m.target.name, m.source, m.fixed])).toEqual([
      ['id', 0, null],
      ['customer_id', null, '42'],
      ['note', 1, null],
    ]);
    expect(el.textContent).toContain('1 Datensätze gelesen');
    api.finish();
    await settled(fixture);
    expect(el.querySelector('.headline')?.textContent).toBe(
      '3 Zeilen importiert, 2 Zeilen ausgelassen.',
    );
    expect(el.querySelector('.errors')?.textContent).toContain('Zeile 4');
    await click('Fehlerdatei zeigen');
    expect(api.revealed).toEqual(['/data/orders.errors.tsv']);
  });

  it('does not start while the file is being read again', async () => {
    // review 033: the mapping on the screen belongs to the columns of the last answer
    const { fixture, el, click, choose } = await open();
    files.path = '/data/orders.csv';
    await click('Datei wählen');
    const start = () => el.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(start().disabled).toBe(false);
    api.holdPreview = true;
    await choose('#di-delimiter', ',');
    expect(start().disabled).toBe(true);
    api.releasePreview();
    await settled(fixture);
    expect(start().disabled).toBe(false);
  });

  it('says that the table was emptied when the import failed after that', async () => {
    const { fixture, el, click } = await open();
    files.path = '/data/orders.csv';
    await click('Datei wählen');
    api.done = { ...api.done, written: 0, failed: true, cleared: true };
    await click('Importieren');
    await settled(fixture);
    expect(el.querySelector('.report')?.textContent).toContain('vorher geleert');
  });

  it('runs nothing when the guard hears a no', async () => {
    const { fixture, el, click } = await open();
    files.path = '/data/orders.csv';
    await click('Datei wählen');
    queries.verdict = () => ({ class: 'write', need: 'confirm' });
    await click('Importieren');
    TestBed.inject(GuardService).answer(null);
    await settled(fixture);
    expect(api.runs).toEqual([]);
    expect(TestBed.inject(DataImportService).job()).toBeNull();
    expect(el.querySelector('form')).not.toBeNull();
  });

  it('proposes a new table, creates it as the user left it and goes on with it', async () => {
    const { fixture, el, click } = await open({ connectionId: 'demo', schema: null, table: null });
    // the schema where names are looked up first
    expect(el.querySelector<HTMLSelectElement>('#di-schema')?.value).toBe('public');
    files.path = '/data/New Customers.csv';
    await click('Datei wählen');
    el.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click();
    await fixture.whenStable();
    const ddl = el.querySelector<HTMLTextAreaElement>('#di-ddl')!;
    expect(ddl.value).toBe('CREATE TABLE public.new_customers (ID int, Note text, extra text)');
    // while a table is being defined there is nothing to import into
    expect(el.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);
    ddl.value = 'CREATE TABLE public.new_customers (id int, note text)';
    ddl.dispatchEvent(new Event('input'));
    schema.objectList['public'].push({
      kind: 'table',
      name: 'new_customers',
      quoted: 'new_customers',
      detail: '',
      rows: 0,
    });
    await click('Tabelle anlegen');
    await fixture.whenStable();
    expect(api.created).toEqual([
      { sql: 'CREATE TABLE public.new_customers (id int, note text)', confirmation: null },
    ]);
    expect(el.querySelector<HTMLSelectElement>('#di-table')?.value).toBe('new_customers');
    expect(el.textContent).toContain('Tabelle new_customers wurde angelegt.');
    expect(sources(el)).toEqual(['0', 'none', '1']);
  });

  it('says why a file cannot be read and why a table was not created', async () => {
    const { fixture, el, click } = await open();
    api.fail = { code: 'io', message: 'no such file' };
    files.path = '/data/gone.csv';
    await click('Datei wählen');
    expect(el.querySelector('.problem')?.textContent).toContain('ließ sich nicht lesen');
    expect(el.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);
    el.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click();
    await fixture.whenStable();
    const ddl = el.querySelector<HTMLTextAreaElement>('#di-ddl')!;
    ddl.value = 'CREATE TABLE x (';
    ddl.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    await click('Tabelle anlegen');
    expect(el.textContent).toContain('Die Tabelle wurde nicht angelegt');
  });
});
