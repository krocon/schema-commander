import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_PROFILE, FakeConnectionsApi } from '../../../testing/fake-apis';
import { SettingsService } from '../settings/settings.service';
import { Profile } from './connection.models';
import { ConnectionsApi } from './connections-api';
import { ConnectionsStore } from './connections.store';

const PG: Profile = {
  id: 'pg',
  name: 'Shop',
  kind: 'postgres',
  host: 'localhost',
  port: 0,
  database: 'shop',
  user: 'alice',
  tls: 'off',
  folder: '',
  color: 1,
  savePassword: true,
};

/** Lets the microtasks of a pending connect run up to the password request. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('ConnectionsStore', () => {
  let api: FakeConnectionsApi;
  let store: ConnectionsStore;
  let settings: SettingsService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    api = new FakeConnectionsApi();
    api.profiles = [DEMO_PROFILE, PG];
    TestBed.configureTestingModule({ providers: [{ provide: ConnectionsApi, useValue: api }] });
    store = TestBed.inject(ConnectionsStore);
    settings = TestBed.inject(SettingsService);
  });

  it('loads the profiles and opens only the demo by itself', async () => {
    await store.load();
    await settle();
    expect(store.profiles().map((p) => p.id)).toEqual(['demo', 'pg']);
    expect(store.activeId()).toBe('demo');
    expect(store.state('demo').kind).toBe('open');
    expect(store.state('pg').kind).toBe('closed');
    expect(api.opened.map((o) => o.id)).toEqual(['demo']);
  });

  it('does not connect at the start when another connection is the active one', async () => {
    settings.update({ activeConnection: 'pg' });
    await store.load();
    await settle();
    expect(store.activeId()).toBe('pg');
    expect(api.opened).toEqual([]);
  });

  it('falls back to the demo when the stored active connection is gone', async () => {
    settings.update({ activeConnection: 'weg' });
    await store.load();
    expect(store.activeId()).toBe('demo');
  });

  it('asks for a password the keychain does not have, and again when it is refused', async () => {
    await store.load();
    api.passwords.set('pg', 'richtig');
    const done = store.connect('pg');
    await settle();
    expect(store.passwordRequest()).toEqual({ id: 'pg', wrong: false });
    expect(store.state('pg').kind).toBe('connecting');
    store.answerPassword('falsch');
    await settle();
    expect(store.passwordRequest()).toEqual({ id: 'pg', wrong: true });
    store.answerPassword('richtig');
    expect(await done).toBe(true);
    expect(store.state('pg')).toEqual({ kind: 'open', serverVersion: 'Fake 1.0' });
    expect(store.passwordRequest()).toBeNull();
    expect(api.opened.filter((o) => o.id === 'pg').map((o) => o.password)).toEqual([
      null,
      'falsch',
      'richtig',
    ]);
  });

  it('gives up quietly when the password dialog is dismissed', async () => {
    await store.load();
    api.passwords.set('pg', 'richtig');
    const done = store.connect('pg');
    await settle();
    store.answerPassword(null);
    expect(await done).toBe(false);
    expect(store.state('pg').kind).toBe('closed');
  });

  it('uses the password of the keychain without asking', async () => {
    await store.load();
    api.passwords.set('pg', 'richtig');
    api.keychain.set('pg', 'richtig');
    expect(await store.connect('pg')).toBe(true);
    expect(store.passwordRequest()).toBeNull();
  });

  it('shows why a connection failed', async () => {
    await store.load();
    api.failOpen = { code: 'connection_failed', message: 'localhost:5432: connection refused' };
    expect(await store.connect('pg')).toBe(false);
    expect(store.state('pg')).toEqual({
      kind: 'failed',
      message: 'Die Verbindung ist fehlgeschlagen. localhost:5432: connection refused',
    });
  });

  it('shares one attempt between callers and does nothing for an open connection', async () => {
    await store.load();
    await settle();
    const [a, b] = await Promise.all([store.connect('pg'), store.connect('pg')]);
    expect(a && b).toBe(true);
    await store.connect('pg');
    expect(api.opened.filter((o) => o.id === 'pg').length).toBe(1);
  });

  it('stores, sorts and removes profiles; disconnect closes', async () => {
    await store.load();
    const stored = await store.save({ ...PG, id: '', name: 'Archiv' }, 'pw');
    expect(store.profiles().map((p) => p.name)).toEqual([
      'Demo (SQLite im Speicher)',
      'Archiv',
      'Shop',
    ]);
    expect(api.keychain.get(stored.id)).toBe('pw');
    await store.connect('pg');
    await store.disconnect('pg');
    expect(store.state('pg').kind).toBe('closed');
    expect(api.closed).toEqual(['pg']);
    await store.remove(stored.id);
    expect(store.profiles().map((p) => p.id)).toEqual(['demo', 'pg']);
  });

  it('activates only connections it knows', async () => {
    await store.load();
    store.activate('pg');
    expect(store.activeId()).toBe('pg');
    store.activate('nope');
    expect(store.activeId()).toBe('pg');
  });
});
