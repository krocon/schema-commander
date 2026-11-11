import { TestBed } from '@angular/core/testing';
import { DEMO_PROFILE, FakeConnectionsApi } from '../../../testing/fake-apis';
import { Profile } from './connection.models';
import { ConnectionsApi } from './connections-api';
import { ConnectionsStore, shownHostKey } from './connections.store';

const BEHIND: Profile = {
  ...DEMO_PROFILE,
  id: 'pg',
  name: 'Shop',
  kind: 'postgres',
  host: 'db.intern',
  user: 'app',
  database: 'shop',
  ssh: { host: 'jump.example', port: 0, user: 'ops', auth: 'password', keyFile: '' },
};
const FINGERPRINT = 'SHA256:FakeFingerprintOfTheJumpHost';

describe('connecting through an SSH tunnel', () => {
  let api: FakeConnectionsApi;
  let store: ConnectionsStore;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new FakeConnectionsApi();
    api.profiles = [DEMO_PROFILE, BEHIND];
    TestBed.configureTestingModule({ providers: [{ provide: ConnectionsApi, useValue: api }] });
    store = TestBed.inject(ConnectionsStore);
    await store.load();
  });

  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it('reads key type and fingerprint from the end of the error', () => {
    expect(shownHostKey(`unknown host key of [jump]:2222: ssh-ed25519 ${FINGERPRINT}`)).toEqual({
      keyType: 'ssh-ed25519',
      fingerprint: FINGERPRINT,
    });
    expect(shownHostKey('something else')).toBeNull();
  });

  it('asks about an unknown host key and connects only after a yes', async () => {
    const connecting = store.connect('pg');
    await settle();
    expect(store.hostKeyRequest()).toEqual({
      id: 'pg',
      host: 'jump.example',
      keyType: 'ssh-ed25519',
      fingerprint: FINGERPRINT,
    });
    expect(store.state('pg').kind).toBe('connecting');
    store.answerHostKey(true);
    expect(await connecting).toBe(true);
    // the confirmed fingerprint went to the backend, nothing else was trusted
    expect(api.sshTried.map((t) => t.trustFingerprint)).toEqual([null, FINGERPRINT]);
    expect(store.state('pg').kind).toBe('open');
  });

  it('stays closed after a no', async () => {
    const connecting = store.connect('pg');
    await settle();
    store.answerHostKey(false);
    expect(await connecting).toBe(false);
    expect(store.state('pg').kind).toBe('closed');
    expect(api.sshTried).toHaveLength(1);
    expect(api.opened.filter((o) => o.id === 'pg')).toEqual([]);
  });

  it('offers no way past a changed host key', async () => {
    api.changedHostKey = true;
    expect(await store.connect('pg')).toBe(false);
    expect(store.hostKeyRequest()).toBeNull();
    const state = store.state('pg');
    expect(state.kind).toBe('failed');
    expect(state.kind === 'failed' && state.message).toContain('passt nicht zum bekannten');
  });

  it('asks for what unlocks the tunnel, again when it was wrong, then for the database', async () => {
    api.trustedHostKeys.add(FINGERPRINT);
    api.sshSecret = 'tunnel-secret';
    api.passwords.set('pg', 'db-secret');
    const connecting = store.connect('pg');
    await settle();
    expect(store.passwordRequest()).toEqual({ id: 'pg', wrong: false, kind: 'ssh' });
    store.answerPassword('nope');
    await settle();
    expect(store.passwordRequest()).toEqual({ id: 'pg', wrong: true, kind: 'ssh' });
    store.answerPassword('tunnel-secret');
    await settle();
    // the tunnel stands: now the login of the database
    expect(store.passwordRequest()).toMatchObject({ id: 'pg', kind: 'database' });
    store.answerPassword('db-secret');
    expect(await connecting).toBe(true);
    expect(api.sshTried.at(-1)?.secret).toBe('tunnel-secret');
  });

  it('gives up when the tunnel question is dismissed', async () => {
    api.trustedHostKeys.add(FINGERPRINT);
    api.sshSecret = 'tunnel-secret';
    const connecting = store.connect('pg');
    await settle();
    store.answerPassword(null);
    expect(await connecting).toBe(false);
    expect(store.state('pg').kind).toBe('closed');
  });

  it('connects a profile without a jump host as before', async () => {
    expect(await store.connect('demo')).toBe(true);
    expect(api.sshTried).toEqual([]);
  });
});
