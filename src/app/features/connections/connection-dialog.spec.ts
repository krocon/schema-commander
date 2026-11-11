import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeConnectionsApi, FakeFileDialogApi } from '../../../testing/fake-apis';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { Profile, emptyProfile } from '../../core/connections/connection.models';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { ConnectionDialog } from './connection-dialog';

describe('ConnectionDialog', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    proto['showModal'] = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto['close'] = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  async function open(profile: Profile = emptyProfile()) {
    const api = new FakeConnectionsApi();
    const dialogs = new FakeFileDialogApi();
    TestBed.configureTestingModule({
      imports: [ConnectionDialog],
      providers: [
        { provide: ConnectionsApi, useValue: api },
        { provide: FileDialogApi, useValue: dialogs },
      ],
    });
    const store = TestBed.inject(ConnectionsStore);
    await store.load();
    const fixture = TestBed.createComponent(ConnectionDialog);
    fixture.componentRef.setInput('profile', profile);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const type = (selector: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const choose = (selector: string, value: string) => {
      const select = el.querySelector<HTMLSelectElement>(selector)!;
      select.value = value;
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
    };
    const click = async (text: string) => {
      [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!.click();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { el, api, dialogs, store, type, choose, click, closed, fixture };
  }

  it('stores a new connection with a suggested name; the password goes to the keychain only', async () => {
    const { el, api, type, click, closed, store } = await open();
    type('#conn-host', 'db.example.com');
    type('#conn-database', 'shop');
    type('#conn-user', 'alice');
    el.querySelector<HTMLInputElement>('#conn-password')!.value = 'geheim-Qx7';
    await click('Speichern');
    const stored = api.profiles.find((p) => p.name === 'shop @ db.example.com')!;
    expect(stored).toMatchObject({ host: 'db.example.com', user: 'alice', tls: 'verify' });
    expect(JSON.stringify(stored)).not.toContain('geheim-Qx7');
    expect(api.keychain.get(stored.id)).toBe('geheim-Qx7');
    expect(el.querySelector<HTMLInputElement>('#conn-password')!.value).toBe('');
    expect(closed).toHaveBeenCalled();
    expect(store.state(stored.id).kind).toBe('closed');
  });

  it('suggests TLS by the host until the user chooses, and warns about none away from home', async () => {
    const { el, type, choose } = await open();
    const tls = () => el.querySelector<HTMLSelectElement>('#conn-tls')!.value;
    expect(tls()).toBe('off');
    type('#conn-host', 'db.example.com');
    expect(tls()).toBe('verify');
    choose('#conn-tls', 'off');
    expect(el.querySelector('.warn')?.textContent).toContain('Ohne Verschlüsselung');
    type('#conn-host', 'other.example.com');
    expect(tls()).toBe('off');
  });

  it('shows what is missing only after a try and stores nothing then', async () => {
    const { el, api, type, click } = await open();
    type('#conn-host', '');
    expect(el.querySelector('.problem')).toBeNull();
    await click('Speichern');
    // without a host there is no suggested name either: the first problem is named
    expect(el.querySelector('.problem')?.textContent).toContain('Namen');
    expect(el.querySelector('#conn-host')?.getAttribute('aria-invalid')).toBe('true');
    expect(api.profiles.length).toBe(1);
  });

  it('tests without storing and says what the server answered', async () => {
    const { el, api, type, click } = await open({ ...emptyProfile(), id: 'pg', name: 'Shop' });
    api.passwords.set('pg', 'richtig');
    el.querySelector<HTMLInputElement>('#conn-password')!.value = 'falsch';
    await click('Testen');
    expect(el.querySelector('[role="status"]')?.textContent).toContain('abgelehnt');
    el.querySelector<HTMLInputElement>('#conn-password')!.value = 'richtig';
    type('#conn-name', 'Shop 2');
    await click('Testen');
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'Verbindung steht: Fake 1.0',
    );
    expect(api.profiles.length).toBe(1);
  });

  it('offers a file for SQLite and connects after storing', async () => {
    const { el, api, dialogs, store, choose, fixture } = await open();
    choose('#conn-kind', 'sqlite');
    expect(el.querySelector('#conn-host')).toBeNull();
    expect(el.querySelector('#conn-password')).toBeNull();
    dialogs.path = '/tmp/Meine Daten.db';
    [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Wählen'))!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector<HTMLInputElement>('#conn-database')!.value).toBe('/tmp/Meine Daten.db');
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    const stored = api.profiles.find((p) => p.kind === 'sqlite' && p.id !== 'demo')!;
    expect(stored.name).toBe('Meine Daten.db');
    expect(store.activeId()).toBe(stored.id);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(store.state(stored.id).kind).toBe('open');
  });

  it('deletes only after asking again', async () => {
    const pg = { ...emptyProfile(), id: 'pg', name: 'Shop' };
    const { api, click } = await open(pg);
    api.profiles.push(pg);
    await click('Löschen');
    expect(api.profiles.some((p) => p.id === 'pg')).toBe(true);
    await click('Wirklich löschen?');
    expect(api.profiles.some((p) => p.id === 'pg')).toBe(false);
  });
});
