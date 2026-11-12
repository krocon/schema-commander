import { Profile, dialectOf, emptyProfile } from '../../core/connections/connection.models';
import {
  groupProfiles,
  profileProblems,
  stageOf,
  suggestedName,
  suggestedTls,
  withKind,
} from './connection-logic';

const p = (over: Partial<Profile>): Profile => ({ ...emptyProfile('postgres'), ...over });

describe('connection logic', () => {
  it('groups by folder: top level first, demo first, the rest by name', () => {
    const groups = groupProfiles([
      p({ id: 'b', name: 'B', folder: 'Prod' }),
      p({ id: 'z', name: 'Zeta' }),
      p({ id: 'demo', name: 'Demo' }),
      p({ id: 'a', name: 'Alpha', folder: 'Dev' }),
    ]);
    expect(groups.map((g) => g.folder)).toEqual(['', 'Dev', 'Prod']);
    expect(groups[0].profiles.map((x) => x.id)).toEqual(['demo', 'z']);
  });

  it('filters by name, folder, host and database', () => {
    const all = [
      p({ id: 'a', name: 'Shop', host: 'db.example.com', folder: 'Prod' }),
      p({ id: 'b', name: 'Lager', database: 'stock' }),
    ];
    const ids = (f: string) => groupProfiles(all, f).flatMap((g) => g.profiles.map((x) => x.id));
    expect(ids('prod')).toEqual(['a']);
    expect(ids('example shop')).toEqual(['a']);
    expect(ids('stock')).toEqual(['b']);
    expect(ids('zzz')).toEqual([]);
  });

  it('says what is missing or not allowed', () => {
    expect(profileProblems(p({ name: 'Lokal' }))).toEqual({});
    // DuckDB (035c): a file like SQLite – no host, no user
    const duck = { name: 'Lager', kind: 'duckdb' as const, host: '', user: '' };
    expect(Object.keys(profileProblems(p({ ...duck, database: '' })))).toEqual(['database']);
    expect(profileProblems(p({ ...duck, database: ':memory:' }))).toEqual({});
    // Oracle (035b): the service name is needed, and TLS always checks
    const oracle = { name: 'Lager', kind: 'oracle' as const, user: 'report' };
    expect(Object.keys(profileProblems(p({ ...oracle, database: '' })))).toEqual(['database']);
    expect(profileProblems(p({ ...oracle, database: 'ORCLPDB1' }))).toEqual({});
    expect(Object.keys(profileProblems(p({ ...oracle, database: 'X', tls: 'require' })))).toEqual([
      'tls',
    ]);
    expect(profileProblems(p({ ...oracle, database: 'X', tls: 'verify' }))).toEqual({});
    expect(Object.keys(profileProblems(p({ name: ' ', host: '', user: '' }))).sort()).toEqual([
      'host',
      'name',
      'user',
    ]);
    expect(profileProblems(p({ name: 'x', host: 'user@host/db' })).host).toBeTruthy();
    expect(profileProblems(p({ name: 'x', host: '[::1]' })).host).toBeUndefined();
    expect(profileProblems(p({ name: 'x', port: 70000 })).port).toBeTruthy();
    const lite = { ...emptyProfile('sqlite'), name: 'Datei' };
    expect(profileProblems(lite)).toEqual({ database: 'Bitte eine Datei wählen.' });
    expect(profileProblems({ ...lite, database: '/tmp/a.db' })).toEqual({});
  });

  it('knows what Trino, libSQL and D1 need (035f–h)', () => {
    const trino = { name: 'Lake', kind: 'trino' as const, user: 'trino' };
    expect(Object.keys(profileProblems(p({ ...trino, database: '' })))).toEqual(['database']);
    expect(profileProblems(p({ ...trino, database: 'hive' }))).toEqual({});
    // libSQL logs in with a token alone
    expect(profileProblems(p({ name: 'Turso', kind: 'libsql', user: '' }))).toEqual({});
    // D1: both ids become part of an address
    const d1 = withKind(p({ name: 'Edge' }), 'd1');
    expect(d1).toMatchObject({ host: 'api.cloudflare.com', tls: 'verify', user: '' });
    expect(Object.keys(profileProblems(d1)).sort()).toEqual(['database', 'user']);
    const ids = { user: '0123456789abcdef0123456789abcdef', database: '1111-22' };
    expect(profileProblems({ ...d1, ...ids })).toEqual({});
    expect(profileProblems({ ...d1, ...ids, database: 'x/../y' }).database).toBeTruthy();
    // and back: not to Cloudflare with another database
    expect(withKind({ ...d1, ...ids }, 'postgres')).toMatchObject({
      host: 'localhost',
      tls: 'off',
    });
    expect(dialectOf('d1')).toBe('sqlite');
    expect(dialectOf('libsql')).toBe('sqlite');
    expect(dialectOf('trino')).toBe('trino');
  });

  it('takes the usual user of another database but keeps an own one', () => {
    expect(withKind(p({ user: 'postgres' }), 'mysql').user).toBe('root');
    expect(withKind(p({ user: 'alice', port: 5433 }), 'mysql')).toMatchObject({
      user: 'alice',
      port: 0,
    });
    expect(withKind(p({ database: 'shop' }), 'sqlite')).toMatchObject({ host: '', database: '' });
  });

  it('suggests TLS away from this machine and a name from the place', () => {
    expect(suggestedTls('localhost')).toBe('off');
    expect(suggestedTls('127.0.0.1')).toBe('off');
    expect(suggestedTls('db.example.com')).toBe('verify');
    expect(suggestedName(p({ host: 'db.example.com', database: 'shop' }))).toBe(
      'shop @ db.example.com',
    );
    expect(suggestedName({ ...emptyProfile('sqlite'), database: '/tmp/Meine Daten.db' })).toBe(
      'Meine Daten.db',
    );
  });
});

describe('TLS and SSH in a profile', () => {
  const base = { ...emptyProfile('postgres'), name: 'x', host: 'db.example' };

  it('wants certificate and key together', () => {
    expect(profileProblems({ ...base, clientCert: '/c.pem' }).clientKey).toBeDefined();
    expect(profileProblems({ ...base, clientKey: '/k.pem' }).clientKey).toBeDefined();
    expect(profileProblems({ ...base, clientCert: '/c.pem', clientKey: '/k.pem' })).toEqual({});
  });

  it('wants host and user of the jump host and refuses the host name check through it', () => {
    const ssh = { host: '', port: 0, user: '', auth: 'agent' as const, keyFile: '' };
    const problems = profileProblems({ ...base, tls: 'verify', ssh });
    expect(Object.keys(problems).sort()).toEqual(['sshHost', 'sshUser', 'tls']);
    expect(
      profileProblems({
        ...base,
        tls: 'verify-ca',
        ssh: { ...ssh, host: 'jump.example', user: 'ops', port: 2222 },
      }),
    ).toEqual({});
    expect(
      profileProblems({ ...base, tls: 'off', ssh: { ...ssh, host: 'j', user: 'o', port: 70000 } })
        .sshPort,
    ).toBeDefined();
  });

  it('takes a CA file only where the certificate is checked', () => {
    expect(profileProblems({ ...base, tls: 'require', caFile: '/ca.pem' }).tls).toBeDefined();
    expect(profileProblems({ ...base, tls: 'verify-ca', caFile: '/ca.pem' })).toEqual({});
    expect(profileProblems({ ...base, tls: 'verify', caFile: '/ca.pem' })).toEqual({});
  });

  it('names the stage an error belongs to', () => {
    expect(stageOf('ssh_secret_required')).toBe('SSH-Tunnel: ');
    expect(stageOf('host_key_changed')).toBe('SSH-Tunnel: ');
    expect(stageOf('tls_failed')).toBe('TLS: ');
    expect(stageOf('auth_failed')).toBe('Anmeldung: ');
    expect(stageOf('connection_failed')).toBe('');
  });
});
