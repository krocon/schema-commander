import { TestBed } from '@angular/core/testing';
import { BackupApi } from '../../core/backup/backup-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { SettingsService } from '../../core/settings/settings.service';
import {
  DEMO_PROFILE,
  FakeBackupApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
} from '../../../testing/fake-apis';
import { BackupDialog } from './backup-dialog';
import { BackupService, BackupTarget } from './backup.service';

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

describe('BackupDialog', () => {
  let api: FakeBackupApi;
  let files: FakeFileDialogApi;
  let service: BackupService;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    api = new FakeBackupApi();
    files = new FakeFileDialogApi();
    const connections = new FakeConnectionsApi();
    connections.profiles = [
      { ...DEMO_PROFILE, id: 'pg', name: 'Shop', kind: 'postgres', database: 'shop' },
      { ...DEMO_PROFILE, id: 'prod', name: 'Prod', kind: 'postgres', protection: 'ask' },
      { ...DEMO_PROFILE, id: 'ro', name: 'Archiv', kind: 'postgres', protection: 'readonly' },
      { ...DEMO_PROFILE, id: 'ms', name: 'ERP', kind: 'sqlserver', database: 'erp' },
      { ...DEMO_PROFILE, id: 'lite', name: 'Datei', kind: 'sqlite', database: '/tmp/a.db' },
    ];
    TestBed.configureTestingModule({
      providers: [
        { provide: BackupApi, useValue: api },
        { provide: FileDialogApi, useValue: files },
        { provide: ConnectionsApi, useValue: connections },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    service = TestBed.inject(BackupService);
  });

  async function dialog(target: Partial<BackupTarget> = {}) {
    const fixture = TestBed.createComponent(BackupDialog);
    fixture.componentRef.setInput('target', {
      connectionId: 'pg',
      mode: 'backup',
      schema: null,
      table: null,
      ...target,
    });
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(text),
      )!;
    return { fixture, el, button };
  }

  it('says which tool it found, and writes a backup where the save dialog says', async () => {
    const { fixture, el, button } = await dialog();
    expect(el.querySelector('h2')?.textContent).toBe('Shop sichern');
    expect(el.querySelector('.tool')?.textContent).toContain('pg_dump – gefunden');
    // the program that will run is always shown (review 044, M1)
    expect(el.querySelector('.program')?.textContent).toBe('/usr/bin/pg_dump');
    expect(el.textContent).toContain('Die ganze Datenbank');
    files.path = '/backups/shop.sql';
    button('Sichern …').click();
    await settled(fixture);
    expect(files.asked[0]).toMatch(/^Sicherung speichern unter: shop-\d{4}-\d\d-\d\d\.sql$/);
    expect(api.dumps).toEqual([
      {
        connectionId: 'pg',
        path: '/backups/shop.sql',
        spec: {
          format: 'sql',
          gzip: false,
          content: 'all',
          noOwner: false,
          inserts: false,
          schemas: [],
          tables: [],
        },
      },
    ]);
    expect(el.querySelector('[role=log]')?.textContent).toContain('dumping contents');
    expect(el.querySelector('.status')?.textContent).toContain('Erledigt: 2,0 KB');
  });

  it('backs up what was chosen in the tree', async () => {
    const { el } = await dialog({ schema: 'public', table: 'orders' });
    expect(el.textContent).toContain('Nur die Tabelle orders');
    const schema = await dialog({ schema: 'crm' });
    expect(schema.el.textContent).toContain('Nur das Schema crm');
  });

  it('does nothing when the save dialog was dismissed', async () => {
    const { fixture, button } = await dialog();
    files.path = null;
    button('Sichern …').click();
    await settled(fixture);
    expect(api.dumps).toEqual([]);
  });

  it('says where to get a tool that is missing, and takes a path for it', async () => {
    api.info = {
      tools: [{ tool: 'pgDump', path: null, version: null, major: null }],
      serverMajor: 16,
    };
    const { fixture, el } = await dialog();
    expect(el.querySelector('[role=alert]')?.textContent).toContain(
      'pg_dump ist auf diesem Rechner',
    );
    expect(el.textContent).toContain('lädt nichts herunter');
    expect(el.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true);
    const path = el.querySelector<HTMLInputElement>('.path input')!;
    path.value = '/opt/pg/bin/pg_dump';
    path.dispatchEvent(new Event('change'));
    await settled(fixture);
    expect(TestBed.inject(SettingsService).settings().toolPaths).toEqual({
      pgDump: '/opt/pg/bin/pg_dump',
    });
    // asked again, with the path
    expect(api.asked.at(-1)).toEqual({ pgDump: '/opt/pg/bin/pg_dump' });
  });

  it('warns when the tool is older than the server', async () => {
    api.info = { ...api.info, serverMajor: 17 };
    const { el } = await dialog();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('Version 16, der Server 17');
  });

  it('shows a failure with what the tool said, as text', async () => {
    api.error = { code: 'invalid_query', message: 'pg_dump: error: <b>no</b> such table' };
    const { fixture, el, button } = await dialog();
    files.path = '/backups/shop.sql';
    button('Sichern …').click();
    await settled(fixture);
    expect(el.querySelector('.status')?.textContent).toContain('Fehlgeschlagen');
    expect(el.querySelector('.status')?.textContent).toContain('<b>no</b>');
    expect(el.querySelector('.status b')).toBeNull();
  });

  it('stops a job that runs', async () => {
    let open!: () => void;
    api.gate = new Promise<void>((r) => (open = r));
    const { fixture, el, button } = await dialog();
    files.path = '/backups/shop.sql';
    button('Sichern …').click();
    await settled(fixture);
    expect(el.querySelector('.status')?.textContent).toContain('Läuft');
    button('Anhalten').click();
    expect(api.cancelled.length).toBe(1);
    api.error = { code: 'cancelled', message: 'cancelled' };
    open();
    await settled(fixture);
    expect(el.querySelector('.status')?.textContent).toContain('Angehalten');
  });

  it('offers the simple export where there is no tool, and the copy for SQLite', async () => {
    const ms = await dialog({ connectionId: 'ms' });
    expect(ms.el.textContent).toContain('SQL Server hat kein Werkzeug');
    expect(ms.el.querySelector('.tool')).toBeNull();
    files.path = '/backups/erp.sql';
    ms.button('Einfacher Export …').click();
    await settled(ms.fixture);
    expect(api.simples).toEqual([{ schema: 'erp', data: true, path: '/backups/erp.sql' }]);
    service.job.set(null);
    const lite = await dialog({ connectionId: 'lite' });
    files.path = '/backups/a-copy.sqlite';
    lite.button('Datenbankdatei kopieren').click();
    await settled(lite.fixture);
    expect(api.copies).toEqual(['/backups/a-copy.sqlite']);
    expect(lite.el.textContent).toContain('Kopiert: 4,0 KB');
  });

  it('restores a file only after the user said so', async () => {
    const { fixture, el, button } = await dialog({ mode: 'restore' });
    expect(el.querySelector('h2')?.textContent).toBe('In Shop wiederherstellen');
    expect(button('Wiederherstellen').disabled).toBe(true);
    files.path = '/backups/shop.dump';
    button('Datei wählen').click();
    await settled(fixture);
    expect(el.querySelector('.file')?.textContent).toContain('Archiv von pg_dump');
    expect(el.textContent).toContain('schreibt in die Datenbank „shop“ von Shop');
    expect(button('Wiederherstellen').disabled).toBe(true);
    const understood = [...el.querySelectorAll<HTMLLabelElement>('label.check')].find((l) =>
      l.textContent?.includes('Mir ist klar'),
    )!;
    understood.querySelector('input')!.click();
    await settled(fixture);
    button('Wiederherstellen').click();
    await settled(fixture);
    expect(api.restores).toEqual([
      {
        connectionId: 'pg',
        path: '/backups/shop.dump',
        typedName: null,
        spec: { clean: false, singleTransaction: true, stopOnError: true, noOwner: false },
      },
    ]);
  });

  it('wants the name of a connection that asks, and refuses one that only reads', async () => {
    const { fixture, el, button } = await dialog({ mode: 'restore', connectionId: 'prod' });
    files.path = '/backups/shop.dump';
    button('Datei wählen').click();
    await settled(fixture);
    expect(button('Wiederherstellen').disabled).toBe(true);
    const typed = el.querySelector<HTMLInputElement>('input[aria-label="Name der Verbindung"]')!;
    typed.value = 'Prod';
    typed.dispatchEvent(new Event('input'));
    await settled(fixture);
    button('Wiederherstellen').click();
    await settled(fixture);
    expect(api.restores[0].typedName).toBe('Prod');
    service.job.set(null);
    const ro = await dialog({ mode: 'restore', connectionId: 'ro' });
    expect(ro.el.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true);
    expect(ro.button('Wiederherstellen').disabled).toBe(true);
  });

  it('says when a file is nothing this database restores', async () => {
    api.kind = 'pgCustom';
    const connections = TestBed.inject(ConnectionsStore);
    connections.profiles.update((all) =>
      all.map((p) => (p.id === 'ms' ? { ...p, kind: 'mysql' as const } : p)),
    );
    api.info = {
      tools: [{ tool: 'mysql', path: '/usr/bin/mysql', version: 'mysql 8.0', major: 8 }],
      serverMajor: 8,
    };
    const { fixture, el, button } = await dialog({ mode: 'restore', connectionId: 'ms' });
    files.path = '/backups/shop.dump';
    button('Datei wählen').click();
    await settled(fixture);
    expect(el.textContent).toContain('keine Sicherung, aus der sich diese Datenbank');
    expect(button('Wiederherstellen').disabled).toBe(true);
  });
});
