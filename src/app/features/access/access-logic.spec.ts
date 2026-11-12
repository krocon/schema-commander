import { AccessChange, Grant, Principal, Who } from '../../core/access/access-api';
import {
  Pending,
  cellChange,
  labelOf,
  levelsOf,
  likeChanges,
  listed,
  matrix,
  nameProblem,
  objectName,
  privilegesOf,
  queued,
  sortedGrants,
  travelAsVerifier,
} from './access-logic';

const who = (name: string, host = ''): Who => ({ name, host });
const ann = who('ann');

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

const change = (privilege: string, add: boolean, object = 'orders'): AccessChange => ({
  op: 'grant',
  who: ann,
  level: 'table',
  schema: 'public',
  object,
  column: '',
  privilege,
  grantable: false,
  add,
});

const wait = (c: AccessChange, password: string | null = null): Pending => ({
  change: c,
  password,
});

const principal = (name: string, over: Partial<Principal> = {}): Principal => ({
  who: who(name),
  label: name,
  login: true,
  attributes: [],
  memberOf: [],
  superuser: false,
  me: false,
  ...over,
});

describe('access-logic', () => {
  it('offers the privileges of the catalog the backend holds, too', () => {
    expect(privilegesOf('postgres', 'table')).toContain('TRUNCATE');
    expect(privilegesOf('mysql', 'server')).toContain('CREATE USER');
    expect(privilegesOf('sqlserver', 'column')).toEqual(['SELECT', 'UPDATE', 'REFERENCES']);
    expect(privilegesOf('sqlite', 'table')).toEqual([]);
    expect(privilegesOf('postgres', 'routine')).toEqual([]);
    expect(levelsOf('mysql')).toEqual(['server', 'schema', 'table', 'column']);
  });

  it('lists users before roles and filters by name, role and attribute', () => {
    const all = [
      principal('readers', { login: false }),
      principal('Zoe', { memberOf: ['readers'] }),
      principal('ann', { attributes: ['createdb'] }),
    ];
    expect(listed(all, '').map((p) => p.label)).toEqual(['ann', 'Zoe', 'readers']);
    expect(listed(all, 'READ').map((p) => p.label)).toEqual(['Zoe', 'readers']);
    expect(listed(all, 'createdb').map((p) => p.label)).toEqual(['ann']);
    expect(labelOf(who('ann', '%'))).toBe('ann@%');
    expect(labelOf(who('readers'))).toBe('readers');
  });

  it('takes back a change that waits when its opposite is asked', () => {
    let pending = queued([], wait(change('SELECT', true)));
    pending = queued(pending, wait(change('INSERT', true)));
    expect(pending).toHaveLength(2);
    pending = queued(pending, wait(change('SELECT', false)));
    expect(pending.map((p) => p.change)).toEqual([change('INSERT', true)]);
    // the same again replaces, it does not double
    pending = queued(pending, wait(change('INSERT', true)));
    expect(pending).toHaveLength(1);
  });

  it('keeps one password per user: the later one replaces the earlier', () => {
    let pending = queued([], wait({ op: 'password', who: ann }, 'first'));
    pending = queued(pending, wait({ op: 'password', who: ann }, 'second'));
    pending = queued(pending, wait({ op: 'password', who: who('ben') }, 'other'));
    expect(pending.map((p) => p.password)).toEqual(['second', 'other']);
    const member = (add: boolean): AccessChange => ({
      op: 'member',
      role: who('readers'),
      member: ann,
      add,
    });
    expect(queued(queued([], wait(member(true))), wait(member(false)))).toEqual([]);
    const attribute = (on: boolean): AccessChange => ({
      op: 'attribute',
      who: ann,
      attribute: 'createdb',
      on,
    });
    expect(queued(queued([], wait(attribute(true))), wait(attribute(false)))).toEqual([]);
  });

  it('builds the matrix from own rights, inherited ones and what waits', () => {
    const grants = [
      grant(),
      grant({ privilege: 'INSERT', via: 'writers' }),
      grant({ privilege: 'SELECT', via: 'PUBLIC' }),
      grant({ object: 'customer', privilege: 'ALL', via: 'admins' }),
      grant({ object: 'customer', privilege: 'OWNER' }),
      grant({ schema: 'other', privilege: 'DELETE' }),
      grant({ level: 'column', column: 'total', privilege: 'UPDATE' }),
    ];
    const rows = matrix(
      ann,
      'public',
      ['customer', 'orders'],
      ['SELECT', 'INSERT', 'DELETE'],
      grants,
      [wait(change('DELETE', true)), wait(change('SELECT', false))],
    );
    const [customer, orders] = rows;
    expect(customer.owner).toBe(true);
    expect(customer.cells.map((c) => [c.direct, c.via])).toEqual([
      [false, ['admins']],
      [false, ['admins']],
      [false, ['admins']],
    ]);
    expect(orders.cells).toEqual([
      { privilege: 'SELECT', direct: true, grantable: false, via: ['PUBLIC'], planned: false },
      { privilege: 'INSERT', direct: false, grantable: false, via: ['writers'], planned: null },
      { privilege: 'DELETE', direct: false, grantable: false, via: [], planned: true },
    ]);
  });

  it('asks for the opposite of what a cell shows', () => {
    const [row] = matrix(ann, 'public', ['orders'], ['SELECT', 'INSERT'], [grant()], []);
    expect(cellChange(ann, row, row.cells[0])).toEqual(change('SELECT', false));
    expect(cellChange(ann, row, row.cells[1])).toEqual(change('INSERT', true));
    // a cell whose change waits goes back to what it was
    const [waiting] = matrix(
      ann,
      'public',
      ['orders'],
      ['SELECT'],
      [grant()],
      [wait(change('SELECT', false))],
    );
    expect(cellChange(ann, waiting, waiting.cells[0])).toEqual(change('SELECT', true));
  });

  it('gives another what one holds itself, as far as it is missing and can be granted', () => {
    const source = [
      grant(),
      grant({ privilege: 'INSERT', grantable: true }),
      grant({ privilege: 'DELETE', via: 'writers' }),
      grant({ privilege: 'OWNER' }),
      grant({ level: 'routine', object: 'f()', privilege: 'EXECUTE' }),
      grant({ level: 'schema', schema: '', object: 'public', privilege: 'USAGE' }),
    ];
    const target = [grant(), grant({ privilege: 'INSERT', via: 'team' })];
    const changes = likeChanges('postgres', ann, source, target);
    expect(
      changes.map((c) => (c.op === 'grant' ? `${c.level} ${c.privilege} ${c.grantable}` : '')),
    ).toEqual(['table INSERT true', 'schema USAGE false']);
  });

  it('orders and filters the list of all rights', () => {
    const grants = [
      grant({ privilege: 'UPDATE' }),
      grant({ level: 'schema', schema: '', object: 'public', privilege: 'USAGE', via: 'PUBLIC' }),
      grant({ privilege: 'SELECT', via: 'readers' }),
      grant({ privilege: 'SELECT' }),
    ];
    expect(sortedGrants(grants, '').map((g) => `${g.level} ${g.privilege} ${g.via}`)).toEqual([
      'schema USAGE PUBLIC',
      'table SELECT ',
      'table SELECT readers',
      'table UPDATE ',
    ]);
    expect(sortedGrants(grants, 'READERS')).toHaveLength(1);
    expect(objectName(grant({ level: 'column', column: 'total' }))).toBe('public.orders.total');
    expect(objectName(grant({ level: 'server', schema: '', object: '' }))).toBe('');
  });

  it('knows which passwords travel as a verifier', () => {
    const password = (text: string | null) => wait({ op: 'password', who: ann }, text);
    expect(travelAsVerifier([password('Sc-047!~ x'), password(null)])).toBe(true);
    expect(travelAsVerifier([password('pässwort')])).toBe(false);
    expect(travelAsVerifier([password('tab\there')])).toBe(false);
  });

  it('checks a name', () => {
    expect(nameProblem('  ')).toBe('empty');
    expect(nameProblem('a\nb')).toBe('control');
    expect(nameProblem("o'brien; --")).toBeNull();
  });
});
