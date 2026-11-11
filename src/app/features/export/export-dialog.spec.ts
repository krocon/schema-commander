import { TestBed } from '@angular/core/testing';
import { ExportApi } from '../../core/backend/export-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { SettingsService } from '../../core/settings/settings.service';
import { FakeConnectionsApi, FakeExportApi, FakeFileDialogApi } from '../../../testing/fake-apis';
import { ExportDialog } from './export-dialog';
import { ExportService, ExportSource } from './export.service';

const SOURCE: ExportSource = {
  kind: 'result',
  resultId: 7,
  columns: [
    { name: 'id', kind: 'int', typeName: 'INT4' },
    { name: 'name', kind: 'text', typeName: 'TEXT' },
    { name: 'note', kind: 'text', typeName: 'TEXT' },
  ],
  rows: 2000,
  ranges: [],
  sql: 'SELECT * FROM shop.orders',
  connectionId: 'demo',
  name: 'shop.orders',
  table: 'shop.orders',
};

describe('ExportDialog', () => {
  let api: FakeExportApi;
  let files: FakeFileDialogApi;

  beforeEach(() => {
    // jsdom has no modal dialogs
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.resetTestingModule();
    api = new FakeExportApi();
    files = new FakeFileDialogApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: ExportApi, useValue: api },
        { provide: FileDialogApi, useValue: files },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
      ],
    });
  });

  async function open(source: ExportSource = SOURCE) {
    const fixture = TestBed.createComponent(ExportDialog);
    fixture.componentRef.setInput('source', source);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el };
  }

  it('offers the options of the format, all columns and a preview', async () => {
    const { el } = await open();
    expect(el.querySelector('.what')?.textContent).toContain('2000 Zeilen');
    expect(el.querySelectorAll('.columns input').length).toBe(3);
    expect(el.querySelector('#export-delimiter')).not.toBeNull();
    expect(el.querySelector('#export-batch')).toBeNull();
    expect(el.querySelector('.preview')?.textContent).toBe('preview as csv');
    expect(api.previews.at(-1)?.columns).toEqual([]);
  });

  it('changes the options with the format and asks for a new preview', async () => {
    const { fixture, el } = await open();
    const select = el.querySelector<HTMLSelectElement>('#export-format')!;
    select.value = 'insert';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(el.querySelector('#export-delimiter')).toBeNull();
    expect(el.querySelector<HTMLInputElement>('#export-table')?.value).toBe('shop.orders');
    expect(api.previews.at(-1)).toMatchObject({ format: 'insert', options: { batch: 500 } });
  });

  it('writes the chosen columns to the file the save dialog names, and remembers the choices', async () => {
    const { fixture, el } = await open();
    const boxes = el.querySelectorAll<HTMLInputElement>('.columns input');
    boxes[1].click();
    await fixture.whenStable();
    files.path = '/tmp/out/orders.csv';
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    await Promise.resolve();
    expect(closed).toHaveBeenCalled();
    expect(api.results).toHaveLength(1);
    expect(api.results[0].path).toBe('/tmp/out/orders.csv');
    expect(api.results[0].spec.columns).toEqual([0, 2]);
    expect(TestBed.inject(SettingsService).settings().lastExportFormat).toBe('csv');
    expect(TestBed.inject(ExportService).job()?.state).toBe('done');
  });

  it('does nothing when the save dialog is dismissed or no column is left', async () => {
    const { fixture, el } = await open();
    files.path = null;
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(api.results).toEqual([]);
    el.querySelectorAll<HTMLButtonElement>('button.link')[1].click();
    await fixture.whenStable();
    expect(el.querySelector<HTMLButtonElement>('button.primary')?.disabled).toBe(true);
  });

  it('has neither columns nor preview for a table of the tree', async () => {
    const { el } = await open({
      kind: 'query',
      connectionId: 'demo',
      sql: 'SELECT * FROM orders',
      name: 'orders',
      table: 'orders',
    });
    expect(el.querySelector('.columns')).toBeNull();
    expect(el.querySelector('.preview')).toBeNull();
    expect(api.previews).toEqual([]);
  });
});
