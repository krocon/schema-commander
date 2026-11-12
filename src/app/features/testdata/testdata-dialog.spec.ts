import { TestBed } from '@angular/core/testing';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { TestdataApi } from '../../core/testdata/testdata-api';
import {
  DEMO_PROFILE,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeQueryApi,
  FakeTestdataApi,
} from '../../../testing/fake-apis';
import { GuardService } from '../guard/guard.service';
import { TestdataDialog } from './testdata-dialog';
import { TestdataService } from './testdata.service';

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }
}

describe('TestdataDialog', () => {
  let api: FakeTestdataApi;
  let files: FakeFileDialogApi;
  let query: FakeQueryApi;
  let service: TestdataService;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    api = new FakeTestdataApi();
    files = new FakeFileDialogApi();
    query = new FakeQueryApi();
    const connections = new FakeConnectionsApi();
    connections.profiles = [
      { ...DEMO_PROFILE, id: 'dev', name: 'Dev', kind: 'postgres' },
      { ...DEMO_PROFILE, id: 'prod', name: 'Prod', kind: 'postgres', protection: 'ask' },
    ];
    TestBed.configureTestingModule({
      providers: [
        { provide: TestdataApi, useValue: api },
        { provide: FileDialogApi, useValue: files },
        { provide: ConnectionsApi, useValue: connections },
        { provide: QueryApi, useValue: query },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    service = TestBed.inject(TestdataService);
  });

  async function open(connectionId = 'dev') {
    const fixture = TestBed.createComponent(TestdataDialog);
    fixture.componentRef.setInput('target', { connectionId, schema: 'public', table: 'orders' });
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    const field = <T extends HTMLElement = HTMLInputElement>(label: string) =>
      el.querySelector<T>(`[aria-label="${label}"]`)!;
    const set = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
      element.value = value;
      element.dispatchEvent(new Event('change'));
      await settled(fixture);
    };
    const status = () => el.querySelector('[role=status]')?.textContent.trim();
    return { fixture, el, button, field, set, status };
  }

  it('proposes a generator per column and shows the first rows', async () => {
    const { el, field } = await open();
    expect(el.querySelector('h2')?.textContent).toBe('Testdaten erzeugen: orders');
    const kinds = [...el.querySelectorAll<HTMLSelectElement>('.columns select')].map((s) =>
      s.selectedOptions[0].textContent.trim(),
    );
    expect(kinds).toEqual([
      'Folge',
      'Wert der Tabelle, auf die sie zeigt',
      'E-Mail',
      'Lorem ipsum',
    ]);
    expect(el.querySelector('.columns tbody')?.textContent).toContain('→ customer.id');
    // values of another table only where a key points to one
    const offered = (label: string) =>
      [...field<HTMLSelectElement>(label).options].map((o) => o.value);
    expect(offered('Erzeuger für customer_id')).toContain('foreignKey');
    expect(offered('Erzeuger für email')).not.toContain('foreignKey');
    const head = [...el.querySelectorAll('.preview thead th')].map((th) => th.textContent);
    expect(head).toEqual(['id', 'customer_id', 'email', 'note']);
    expect(el.querySelectorAll('.preview tbody tr')).toHaveLength(3);
    expect(el.querySelector('h3')?.textContent).toContain('die ersten 3 von 1000 Zeilen');
  });

  it('asks for the preview anew when something changes', async () => {
    const { el, field, set } = await open();
    const before = api.previews.length;
    await set(field('Erzeuger für note'), 'pattern');
    await set(field('note: Muster'), '[A-Z]{2}');
    await set(field('note: NULL %'), '100');
    const last = api.previews.at(-1)!;
    expect(api.previews.length).toBeGreaterThan(before);
    expect(last.columns[3]).toMatchObject({
      gen: { kind: 'pattern', pattern: '[A-Z]{2}' },
      nullShare: 1,
    });
    // NULL is shown as NULL, not as an empty cell
    expect(el.querySelector('.preview td.null')?.textContent).toBe('NULL');
    await set(field('Erzeuger für id'), 'skip');
    expect([...el.querySelectorAll('.preview thead th')].map((th) => th.textContent)).toEqual([
      'customer_id',
      'email',
      'note',
    ]);
  });

  it('takes the number of rows from the rows per parent', async () => {
    const { fixture, el, field } = await open();
    field('customer_id: Zeilen je Elternzeile').click();
    await settled(fixture);
    expect(api.previews.at(-1)!.columns[1].gen).toEqual({ kind: 'foreignKey', perParent: [0, 5] });
    expect(el.querySelector<HTMLInputElement>('.row input[type=number]')!.disabled).toBe(true);
    expect(el.querySelector('h3')?.textContent).toContain('von 777 Zeilen');
  });

  it('says what the backend does not take, and writes nothing then', async () => {
    api.failPreview = { code: 'invalid_query', message: 'the pattern has a stray `)`' };
    const { el, button } = await open();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('stray');
    expect(button('Zeilen schreiben')!.disabled).toBe(true);
    expect(button('Als CSV-Datei …')!.disabled).toBe(true);
  });

  it('writes the rows with the seed and the options, and says how it went', async () => {
    const { fixture, el, button, set, status } = await open();
    const [rows, seed] = [...el.querySelectorAll<HTMLInputElement>('.row input[type=number]')];
    await set(rows, '250');
    await set(seed, '7');
    el.querySelectorAll<HTMLInputElement>('.row input[type=checkbox]')[0].click();
    await settled(fixture);
    button('Zeilen schreiben')!.click();
    await settled(fixture);
    expect(api.runs).toHaveLength(1);
    expect(api.runs[0].spec).toMatchObject({ table: 'orders', rows: 250, seed: 7, locale: 'en' });
    expect(api.runs[0].options).toEqual({ clearFirst: true, wholeTransaction: false });
    expect(status()).toBe('250 Zeilen geschrieben.');
    expect(service.running()).toBe(false);
  });

  it('asks first where the connection wants that, and writes nothing after a no', async () => {
    query.verdict = () => ({ class: 'write', need: 'confirm' });
    const guard = TestBed.inject(GuardService);
    const { fixture, button, status } = await open();
    button('Zeilen schreiben')!.click();
    await settled(fixture);
    expect(guard.request()?.statements[0].sql).toContain('INSERT INTO "orders"');
    guard.answer(null);
    await settled(fixture);
    expect(api.runs).toEqual([]);
    expect(status()).toBe('Nicht ausgeführt.');
  });

  it('writes no rows to a protected connection, but still a file', async () => {
    files.path = '/tmp/orders.sql';
    const { fixture, el, button, status } = await open('prod');
    expect(el.textContent).toContain('Diese Verbindung ist geschützt');
    expect(button('Zeilen schreiben')!.disabled).toBe(true);
    button('Als INSERT-Skript …')!.click();
    await settled(fixture);
    expect(api.exports).toHaveLength(1);
    expect(api.exports[0]).toMatchObject({ path: '/tmp/orders.sql', format: 'insert' });
    expect(files.asked.at(-1)).toContain('orders.sql');
    expect(status()).toBe('1000 Zeilen in die Datei geschrieben.');
  });

  it('writes no file when none was chosen', async () => {
    files.path = null;
    const { fixture, button } = await open();
    button('Als CSV-Datei …')!.click();
    await settled(fixture);
    expect(api.exports).toEqual([]);
  });

  it('says what failed and what is in the table', async () => {
    api.report = {
      ...api.report,
      written: 400,
      failed: true,
      errors: [{ line: 401, reason: 'duplicate key' }],
    };
    const { fixture, button, status } = await open();
    button('Zeilen schreiben')!.click();
    await settled(fixture);
    expect(status()).toBe('Gescheitert: duplicate key – 400 Zeilen sind in der Tabelle.');
  });

  it('remembers what was set for a table and starts from it next time', async () => {
    const first = await open();
    await first.set(first.field('Erzeuger für note'), 'company');
    const rows = first.el.querySelector<HTMLInputElement>('.row input[type=number]')!;
    await first.set(rows, '42');
    first.button('Für diese Tabelle merken')!.click();
    await settled(first.fixture);
    expect(first.status()).toBe('Gemerkt.');
    expect(Object.keys(TestBed.inject(SettingsService).settings().testdataTemplates)).toEqual([
      'dev/public/orders',
    ]);
    first.fixture.destroy();
    const again = await open();
    expect(again.el.textContent).toContain('zuletzt eingestellt');
    expect(again.field<HTMLSelectElement>('Erzeuger für note').value).toBe('company');
    expect(again.el.querySelector<HTMLInputElement>('.row input[type=number]')!.value).toBe('42');
  });

  it('shows generated values as text', async () => {
    api.suggestion = {
      ...api.suggestion,
      columns: [{ ...api.suggestion.columns[3], gen: { kind: 'fixed', value: '<img src=x>' } }],
    };
    api.preview = (_id, spec) =>
      Promise.resolve({
        columns: ['note'],
        rows: [['<img src=x onerror=alert(1)>']],
        total: spec.rows,
      });
    const { el } = await open();
    expect(el.querySelector('.preview img')).toBeNull();
    expect(el.querySelector('.preview td')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
