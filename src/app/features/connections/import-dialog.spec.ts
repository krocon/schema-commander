import { TestBed } from '@angular/core/testing';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ImportItem, emptyProfile } from '../../core/connections/connection.models';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { FakeConnectionsApi, FakeFileDialogApi } from '../../../testing/fake-apis';
import { ConnectionDialog } from './connection-dialog';
import { ImportDialog } from './import-dialog';

const found = (index: number, over: Partial<ImportItem> = {}): ImportItem => ({
  index,
  profile: { ...emptyProfile('postgres'), name: `shop ${index}`, host: 'db.example', user: 'app' },
  hasPassword: false,
  problem: null,
  nameTaken: false,
  ...over,
});

describe('importing connections', () => {
  let api: FakeConnectionsApi;
  let files: FakeFileDialogApi;

  beforeEach(async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.resetTestingModule();
    api = new FakeConnectionsApi();
    files = new FakeFileDialogApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: ConnectionsApi, useValue: api },
        { provide: FileDialogApi, useValue: files },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
  });

  async function open() {
    const fixture = TestBed.createComponent(ImportDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(text),
      )!;
    return { fixture, el, button };
  }

  it('shows what a source holds, ticked where it can be stored', async () => {
    api.importable = [
      found(0, { hasPassword: true }),
      found(1, { problem: 'the user is missing' }),
      found(2, { nameTaken: true }),
    ];
    const { fixture, el, button } = await open();
    expect(el.querySelector('.list')).toBeNull();
    button('Lesen').click();
    await fixture.whenStable();
    const rows = el.querySelectorAll('.list li');
    expect(rows).toHaveLength(3);
    const takes = [...el.querySelectorAll<HTMLInputElement>('.take input')];
    expect(takes.map((t) => [t.checked, t.disabled])).toEqual([
      [true, false],
      [false, true],
      [true, false],
    ]);
    expect(rows[1].querySelector('.why')?.textContent).toContain('Benutzer fehlt');
    expect(rows[2].textContent).toContain('Name vergeben');
    // one password could be taken; its box starts empty
    const pw = el.querySelectorAll<HTMLInputElement>('.pw input');
    expect(pw).toHaveLength(1);
    expect(pw[0].checked).toBe(false);
    expect(el.querySelector('.summary')?.textContent).toBe('2 von 3 ausgewählt · 1 unvollständig');
  });

  it('stores what is ticked, with a password only where its box is ticked', async () => {
    api.importable = [found(0, { hasPassword: true }), found(1, { hasPassword: true }), found(2)];
    const { fixture, el, button } = await open();
    button('Lesen').click();
    await fixture.whenStable();
    el.querySelectorAll<HTMLInputElement>('.pw input')[0].click();
    el.querySelectorAll<HTMLInputElement>('.take input')[2].click();
    await fixture.whenStable();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(api.imports).toEqual([
      {
        source: 'pgpass',
        path: null,
        picks: [
          { index: 0, withPassword: true },
          { index: 1, withPassword: false },
        ],
      },
    ]);
    expect(el.querySelector('.ok')?.textContent).toContain('2 Verbindungen übernommen');
    // they are in the list of the app
    const names = TestBed.inject(ConnectionsStore)
      .profiles()
      .map((p) => p.name);
    expect(names).toContain('shop 0');
    expect(names).toContain('shop 1');
    expect(names).not.toContain('shop 2');
  });

  it('reads a picked file and says when it is not what it should be', async () => {
    const { fixture, el, button } = await open();
    const select = el.querySelector<HTMLSelectElement>('#import-source')!;
    select.value = 'datagrip';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    // this source has no usual place
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Lesen'))).toBe(
      false,
    );
    files.path = '/project/.idea/dataSources.xml';
    api.failImport = {
      code: 'invalid_profile',
      message: 'not a dataSources.xml of a JetBrains IDE',
    };
    button('Datei wählen').click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(el.querySelector('.problem')?.textContent).toContain('not a dataSources.xml');
    expect(el.querySelector('.list')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('button.primary')?.disabled).toBe(true);
  });

  it('exports our own profiles to the file the save dialog names', async () => {
    const { fixture, button } = await open();
    files.path = '/tmp/verbindungen.json';
    button('exportieren').click();
    await fixture.whenStable();
    expect(api.exported).toEqual(['/tmp/verbindungen.json']);
  });
});

describe('a connection from a URL', () => {
  it('fills the dialog and puts the password into its field only', async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.resetTestingModule();
    const api = new FakeConnectionsApi();
    api.urls.set('postgres://app:s3cret@db.example:6543/shop', {
      profile: {
        ...emptyProfile('postgres'),
        name: 'shop@db.example',
        host: 'db.example',
        port: 6543,
        database: 'shop',
        user: 'app',
        tls: 'verify',
      },
      password: 's3cret',
      problem: null,
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: ConnectionsApi, useValue: api },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
      ],
    });
    const fixture = TestBed.createComponent(ConnectionDialog);
    fixture.componentRef.setInput('profile', emptyProfile());
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const url = el.querySelector<HTMLInputElement>('.from-url input')!;
    url.value = 'nonsense';
    el.querySelector<HTMLButtonElement>('.from-url button')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.problem')?.textContent).toContain('no connection URL');

    url.value = 'postgres://app:s3cret@db.example:6543/shop';
    el.querySelector<HTMLButtonElement>('.from-url button')!.click();
    await fixture.whenStable();
    // the password field is filled a tick later, once the form shows the new kind
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fixture.whenStable();
    expect(el.querySelector<HTMLInputElement>('#conn-host')?.value).toBe('db.example');
    expect(el.querySelector<HTMLInputElement>('#conn-port')?.value).toBe('6543');
    expect(el.querySelector<HTMLInputElement>('#conn-database')?.value).toBe('shop');
    expect(el.querySelector<HTMLInputElement>('#conn-user')?.value).toBe('app');
    expect(el.querySelector<HTMLInputElement>('#conn-password')?.value).toBe('s3cret');
    // the password is nowhere in the text of the page
    expect(el.textContent).not.toContain('s3cret');
  });
});
