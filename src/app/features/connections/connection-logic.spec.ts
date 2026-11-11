import { Profile, emptyProfile } from '../../core/connections/connection.models';
import {
  groupProfiles,
  profileProblems,
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
