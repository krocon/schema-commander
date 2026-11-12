import { TestBed } from '@angular/core/testing';
import { AccessApi, Grant } from '../../core/access/access-api';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import {
  DEMO_PROFILE,
  FakeAccessApi,
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { GuardService } from '../guard/guard.service';
import { TabsStore } from '../tabs/tabs.store';
import { AccessDialog } from './access-dialog';
import { AccessService } from './access.service';

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }
}

const grant = (over: Partial<Grant> = {}): Grant => ({
  level: 'table',
  schema: 'public',
  object: 'orders',
  column: '',
  privilege: 'SELECT',
  grantable: false,
  via: '',
  ...over,
});

describe('AccessDialog', () => {
  let api: FakeAccessApi;
  let query: FakeQueryApi;
  let access: AccessService;
  let guard: GuardService;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    api = new FakeAccessApi();
    api.grantsOf = {
      ann: {
        grants: [grant(), grant({ privilege: 'INSERT', via: 'readers' })],
        cut: false,
        missing: [],
      },
      readers: { grants: [grant({ privilege: 'DELETE' })], cut: false, missing: [] },
    };
    query = new FakeQueryApi();
    const connections = new FakeConnectionsApi();
    connections.profiles = [
      { ...DEMO_PROFILE, id: 'pg', name: 'Shop', kind: 'postgres' },
      { ...DEMO_PROFILE, id: 'ro', name: 'Nur lesen', kind: 'postgres', protection: 'readonly' },
    ];
    TestBed.configureTestingModule({
      providers: [
        { provide: AccessApi, useValue: api },
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: connections },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: ClipboardApi, useValue: new FakeClipboardApi() },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    access = TestBed.inject(AccessService);
    guard = TestBed.inject(GuardService);
  });

  afterEach(() => access.close());

  async function open(id = 'pg', choose: string | null = 'ann') {
    access.open(id);
    const fixture = TestBed.createComponent(AccessDialog);
    fixture.componentRef.setInput('connectionId', id);
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    const people = () => [...el.querySelectorAll<HTMLElement>('.who li')];
    const box = (label: string) =>
      el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    const steps = () => [...el.querySelectorAll('.changes code')].map((c) => c.textContent);
    if (choose) {
      people()
        .find((li) => li.querySelector('.name')?.textContent === choose)!
        .click();
      await settled(fixture);
    }
    return { fixture, el, button, people, box, steps };
  }

  it('lists users and roles and shows the rights of the chosen one with where they come from', async () => {
    const { el, people, box, button } = await open();
    expect(el.querySelector('h2')?.textContent).toBe('Benutzer und Rechte: Shop');
    expect(
      people().map((li) => [...li.querySelectorAll('span')].map((x) => x.textContent.trim())),
    ).toEqual([
      ['admin', 'Benutzer', 'Sie', 'darf alles'],
      ['ann', 'Benutzer'],
      ['readers', 'Rolle'],
    ]);
    expect(box('SELECT auf orders').checked).toBe(true);
    // INSERT comes through a role: not ticked, but marked
    expect(box('INSERT auf orders').checked).toBe(false);
    expect(box('INSERT auf orders').closest('td')?.title).toBe('über readers');
    expect(box('SELECT auf customer').checked).toBe(false);
    // reading is over: the list can be read again
    expect(access.busy()).toBe(false);
    expect(button('Neu lesen')!.disabled).toBe(false);
  });

  it('collects changes, shows them as statements and runs them', async () => {
    const { fixture, button, box, steps } = await open();
    box('DELETE auf orders').click();
    box('SELECT auf orders').click();
    await settled(fixture);
    expect(steps()).toEqual([
      'GRANT DELETE ON TABLE "public"."orders" TO "ann"',
      'REVOKE SELECT ON TABLE "public"."orders" FROM "ann"',
    ]);
    expect(box('DELETE auf orders').closest('td')?.classList.contains('changed')).toBe(true);
    // the opposite click takes the change back
    box('DELETE auf orders').click();
    await settled(fixture);
    expect(steps()).toEqual(['REVOKE SELECT ON TABLE "public"."orders" FROM "ann"']);
    button('1 Anweisung ausführen')!.click();
    await settled(fixture);
    expect(api.applied).toHaveLength(1);
    expect(api.applied[0].changes).toHaveLength(1);
    expect(access.pending()).toEqual([]);
    expect(access.note()).toBe('1 Anweisung ausgeführt.');
  });

  it('asks before it runs where the connection wants that, and runs nothing after a no', async () => {
    query.verdict = () => ({ class: 'dangerous', need: 'confirm' });
    const { fixture, button, box } = await open();
    box('DELETE auf orders').click();
    await settled(fixture);
    button('1 Anweisung ausführen')!.click();
    await settled(fixture);
    expect(guard.request()?.statements[0].sql).toBe(
      'GRANT DELETE ON TABLE "public"."orders" TO "ann"',
    );
    guard.answer(null);
    await settled(fixture);
    expect(api.applied).toEqual([]);
    expect(access.note()).toBe('Nicht ausgeführt.');
    expect(access.pending()).toHaveLength(1);
  });

  it('keeps a password out of everything that is shown', async () => {
    api.hidesPassword = false;
    const { fixture, el, button, steps } = await open();
    button('Passwort setzen …')!.click();
    await settled(fixture);
    const input = el.querySelector<HTMLInputElement>('input[type=password]')!;
    input.value = 'geheim-047';
    button('Zu den Änderungen')!.click();
    await settled(fixture);
    expect(steps()).toEqual([`ALTER ROLE "ann" PASSWORD '***'`]);
    expect(el.querySelector('input[type=password]')).toBeNull();
    expect(el.textContent).not.toContain('geheim-047');
    expect(el.innerHTML).not.toContain('geheim-047');
    expect(el.textContent).toContain('in sein Protokoll schreiben');
    // the plan was asked without it; only the run carries it, beside its change
    expect(JSON.stringify(api.plans)).not.toContain('geheim-047');
    button('1 Anweisung ausführen')!.click();
    await settled(fixture);
    expect(api.applied[0].passwords).toEqual(['geheim-047']);
    expect(JSON.stringify(query.confirmed)).not.toContain('geheim-047');
    // afterwards it is gone from the window
    expect(JSON.stringify(access.pending())).not.toContain('geheim-047');
  });

  it('promises the verifier only for a password that can travel as one', async () => {
    const { fixture, el, button } = await open();
    const set = async (password: string) => {
      button('Passwort setzen …')!.click();
      await settled(fixture);
      el.querySelector<HTMLInputElement>('input[type=password]')!.value = password;
      button('Zu den Änderungen')!.click();
      await settled(fixture);
    };
    await set('plain-ascii');
    expect(el.textContent).toContain('nie das Passwort selbst');
    await set('pässwort');
    expect(el.textContent).toContain('in sein Protokoll schreiben');
    expect(el.textContent).not.toContain('nie das Passwort selbst');
    expect(
      TestBed.inject(TabsStore)
        .tabs()
        .some((t) => (t.startText ?? '').includes('geheim')),
    ).toBe(false);
  });

  it('creates a user with a password and a role without one', async () => {
    const { fixture, el, button, steps } = await open();
    button('Neuer Benutzer …')!.click();
    await settled(fixture);
    const form = [...el.querySelectorAll('form')].at(-1)!;
    button('Zu den Änderungen')!.click();
    await settled(fixture);
    expect(form.textContent).toContain('Ein Name wird gebraucht.');
    form.querySelector<HTMLInputElement>('input[type=text]')!.value = 'ben';
    form.querySelector<HTMLInputElement>('input[type=password]')!.value = 'pw';
    button('Zu den Änderungen')!.click();
    await settled(fixture);
    button('Neue Rolle …')!.click();
    await settled(fixture);
    [...el.querySelectorAll('form')]
      .at(-1)!
      .querySelector<HTMLInputElement>('input[type=text]')!.value = 'writers';
    button('Zu den Änderungen')!.click();
    await settled(fixture);
    expect(steps()).toEqual([`CREATE ROLE "ben" LOGIN PASSWORD '***'`, 'CREATE ROLE "writers"']);
    expect(access.pending().map((p) => p.password)).toEqual(['pw', null]);
  });

  it('marks what is dangerous and takes a change back', async () => {
    const { fixture, el, button, steps } = await open();
    button('Löschen …')!.click();
    await settled(fixture);
    expect(steps()).toEqual(['DROP ROLE "ann"']);
    expect(el.querySelector('.changes .danger')?.textContent).toBe('lässt sich nicht zurücknehmen');
    el.querySelector<HTMLButtonElement>('.changes button.x')!.click();
    await settled(fixture);
    expect(steps()).toEqual([]);
    expect(el.querySelector('.changes')?.textContent).toContain('Nichts wartet');
  });

  it('gives rights like another one and writes the rights as a script', async () => {
    const { fixture, el, button, steps } = await open();
    const like = el.querySelector<HTMLSelectElement>('select[aria-label="Rechte wie …"]')!;
    like.value = 'readers';
    like.dispatchEvent(new Event('change'));
    await settled(fixture);
    expect(steps()).toEqual(['GRANT DELETE ON TABLE "public"."orders" TO "ann"']);
    button('Rechte als Skript')!.click();
    await settled(fixture);
    expect(api.scripts).toEqual([{ name: 'ann', host: '' }]);
    const tab = TestBed.inject(TabsStore).tabs().at(-1)!;
    expect(tab.startText).toContain('-- Rechte von ann');
    expect(tab.startText).toContain('GRANT SELECT');
  });

  it('changes memberships', async () => {
    const { fixture, el, steps } = await open();
    el.querySelector<HTMLButtonElement>('button[aria-label="Aus readers nehmen"]')!.click();
    await settled(fixture);
    expect(steps()).toEqual(['REVOKE "readers" FROM "ann"']);
  });

  it('shows everything and changes nothing without the right to manage', async () => {
    api.access = { ...api.access, canManage: false };
    const { el, button, box } = await open();
    expect(el.textContent).toContain('nichts lässt sich ändern');
    expect(box('SELECT auf orders').disabled).toBe(true);
    expect(button('Neuer Benutzer …')).toBeUndefined();
    expect(button('Löschen …')).toBeUndefined();
    access.queue({ op: 'drop', who: { name: 'ann', host: '' }, role: false });
    expect(access.pending()).toEqual([]);
  });

  it('changes nothing on a connection that only reads', async () => {
    const { el, button, box } = await open('ro');
    expect(el.textContent).toContain('Diese Verbindung liest nur');
    expect(box('SELECT auf orders').disabled).toBe(true);
    expect(button('Neue Rolle …')).toBeUndefined();
  });

  it('shows names of the server as text, never as markup', async () => {
    api.access = {
      ...api.access,
      principals: [
        ...api.access.principals,
        {
          who: { name: '<img src=x onerror=alert(1)>', host: '' },
          label: '<img src=x onerror=alert(1)>',
          login: true,
          attributes: ['<b>x</b>'],
          memberOf: [],
          superuser: false,
          me: false,
        },
      ],
    };
    const { el } = await open('pg', '<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.what b')).toBeNull();
    expect(el.querySelector('.head strong')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('does not keep a password after a failure, and names a server name in a comment on one line', async () => {
    api.ran = {
      done: 0,
      failed: 0,
      error: { code: 'invalid_query', message: 'no' },
      transactional: true,
      rolledBack: true,
    };
    const { fixture, button, box } = await open();
    access.queue({ op: 'password', who: { name: 'ann', host: '' } }, 'geheim');
    box('DELETE auf orders').click();
    await settled(fixture);
    button('2 Anweisungen ausführen')!.click();
    await settled(fixture);
    expect(access.pending().map((p) => p.change.op)).toEqual(['grant']);
    expect(access.note()).toContain('Setzen Sie sie neu');
    expect(access.plan()?.steps).toHaveLength(1);
    await access.script({ name: 'x\nDROP TABLE t; --', host: '' });
    const text = TestBed.inject(TabsStore).tabs().at(-1)!.startText ?? '';
    expect(text.split('\n')[0]).toBe('-- Rechte von x DROP TABLE t; --');
  });

  it('runs only what is on screen: not while the plan is written anew', async () => {
    const { fixture, box } = await open();
    box('DELETE auf orders').click();
    // the statement of this change is not written yet
    expect(access.planning()).toBe(true);
    await access.apply();
    expect(api.applied).toEqual([]);
    await settled(fixture);
    expect(access.planning()).toBe(false);
    await access.apply();
    expect(api.applied).toHaveLength(1);
  });

  it('says what failed and what stays', async () => {
    api.ran = {
      done: 0,
      failed: 0,
      error: { code: 'permission_denied', message: 'permission denied' },
      transactional: true,
      rolledBack: true,
    };
    const { fixture, button, box } = await open();
    box('DELETE auf orders').click();
    await settled(fixture);
    button('1 Anweisung ausführen')!.click();
    await settled(fixture);
    expect(access.note()).toContain('Anweisung 1 von 1 ist gescheitert');
    expect(access.note()).toContain('Nichts wurde geändert.');
    expect(access.pending()).toHaveLength(1);
  });
});
