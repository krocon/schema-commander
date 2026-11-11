import { TestBed } from '@angular/core/testing';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { ConfirmService } from '../../shared/confirm';
import {
  DEMO_PROFILE,
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { TabsStore } from '../tabs/tabs.store';
import { CopyService } from './copy.service';

describe('CopyService', () => {
  let clipboard: FakeClipboardApi;
  let query: FakeQueryApi;
  let tabs: TabsStore;
  let copier: CopyService;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    clipboard = new FakeClipboardApi();
    query = new FakeQueryApi();
    const connections = new FakeConnectionsApi();
    connections.profiles = [{ ...DEMO_PROFILE, kind: 'mysql' }];
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: connections },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: ClipboardApi, useValue: clipboard },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    tabs = TestBed.inject(TabsStore);
    await tabs.load();
    copier = TestBed.inject(CopyService);
  });

  afterEach(() => vi.useRealTimers());

  async function run(sql = 'SELECT * FROM shop.orders') {
    await tabs.active()!.run(sql);
    return tabs.active()!.runs()[0].result!.resultId;
  }

  it('has nothing to copy before a statement ran', async () => {
    expect(copier.can()).toBe(false);
    await copier.copy();
    expect(clipboard.copies).toEqual([]);
  });

  it('copies the whole result tab-separated when nothing is selected', async () => {
    const resultId = await run();
    expect(copier.can()).toBe(true);
    await copier.copy();
    expect(clipboard.copies).toHaveLength(1);
    const copy = clipboard.copies[0];
    expect(copy.resultId).toBe(resultId);
    expect(copy.format).toBe('tsv');
    expect(copy.selection).toEqual({ rows: [], columns: [] });
    expect(copy.options).toEqual({
      header: true,
      nullAs: '',
      delimiter: ',',
      table: 'shop.orders',
      dialect: 'mysql',
    });
    expect(copier.message()).toBe('3 Zeilen kopiert (TSV)');
  });

  it('copies what the grid of the result says is selected, in the format asked for', async () => {
    const resultId = await run('SELECT 1');
    const off = copier.register(resultId, () => ({ rows: [[0, 1]], columns: [1] }));
    await copier.copy('insert');
    expect(clipboard.copies[0].selection).toEqual({ rows: [[0, 1]], columns: [1] });
    expect(clipboard.copies[0].options.table).toBe('tabelle');
    expect(copier.message()).toBe('2 Zeilen kopiert (INSERT-Anweisungen)');
    // the format is on top of the menu next time; the default format is not "used last"
    expect(TestBed.inject(SettingsService).settings().lastCopyFormat).toBe('insert');
    off();
    await copier.copy();
    expect(clipboard.copies[1].selection).toEqual({ rows: [], columns: [] });
    expect(TestBed.inject(SettingsService).settings().lastCopyFormat).toBe('insert');
  });

  it('follows the settings for header and NULL', async () => {
    await run();
    TestBed.inject(SettingsService).update({
      copyHeader: false,
      copyNullAs: 'NULL',
      csvDelimiter: ';',
    });
    await copier.copy('csv');
    expect(clipboard.copies[0].options).toMatchObject({
      header: false,
      nullAs: 'NULL',
      delimiter: ';',
    });
  });

  it('asks before a million cells and does nothing on a no', async () => {
    query.rows = Array.from({ length: 3 }, () => [1, 'a']);
    const resultId = await run();
    // the grid says: two million rows of it
    copier.register(resultId, () => ({ rows: [[0, 2]], columns: [] }));
    const confirm = TestBed.inject(ConfirmService);
    tabs.active()!.runs.update((runs) => runs.map((r) => ({ ...r, rows: 2_000_000 })));
    copier.register(resultId, () => ({ rows: [], columns: [] }));
    const pending = copier.copy();
    expect(confirm.request()?.message).toContain('2 000 000 Zeilen');
    confirm.answer(false);
    await pending;
    expect(clipboard.copies).toEqual([]);
    const again = copier.copy();
    confirm.answer(true);
    await again;
    expect(clipboard.copies).toHaveLength(1);
  });

  it('says why nothing was copied', async () => {
    await run();
    clipboard.fail = { code: 'too_large', message: 'x' };
    await copier.copy();
    expect(copier.message()).toContain('Zu viel für die Zwischenablage');
    clipboard.fail = { code: 'cancelled', message: 'x' };
    await copier.copy();
    expect(copier.message()).toBe('Kopieren abgebrochen.');
    clipboard.fail = { code: 'io', message: 'clipboard: none' };
    await copier.copy();
    expect(copier.message()).toContain('Nicht kopiert');
    expect(copier.busy()).toBe(false);
  });

  it('forgets its message after a while and copies names of the schema tree', async () => {
    vi.useFakeTimers();
    await copier.copyText('"Old Orders"');
    expect(clipboard.texts).toEqual(['"Old Orders"']);
    expect(copier.message()).toBe('Kopiert.');
    vi.advanceTimersByTime(5000);
    expect(copier.message()).toBeNull();
  });

  it('opens the menu only when there is something to copy', async () => {
    copier.openMenu(10, 20);
    expect(copier.menu()).toBeNull();
    await run();
    copier.openMenu(10, 20);
    expect(copier.menu()).toEqual({ x: 10, y: 20 });
  });
});
