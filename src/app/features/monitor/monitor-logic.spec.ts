import { ServerSession } from '../../core/monitor/monitor-api';
import {
  blockTree,
  blockedCount,
  bytesText,
  durationText,
  filtered,
  firstLine,
  mark,
  sorted,
  stillThere,
  toggled,
  transactionRate,
} from './monitor-logic';

const session = (id: string, over: Partial<ServerSession> = {}): ServerSession => ({
  id,
  user: 'app',
  database: 'shop',
  application: '',
  client: '10.0.0.1',
  state: 'idle',
  queryMs: null,
  txMs: null,
  wait: '',
  statement: '',
  blockedBy: [],
  own: false,
  this: false,
  ...over,
});

const figures = (transactions: number | null) => ({
  version: '',
  connections: null,
  maxConnections: null,
  transactions,
  databaseBytes: null,
  uptimeS: null,
});

describe('monitor-logic', () => {
  it('orders ids as numbers and puts sessions without a value last, either way round', () => {
    const list = [session('10', { queryMs: 5 }), session('9'), session('100', { queryMs: 900 })];
    expect(sorted(list, { key: 'id', desc: false }).map((s) => s.id)).toEqual(['9', '10', '100']);
    expect(sorted(list, { key: 'queryMs', desc: true }).map((s) => s.id)).toEqual([
      '100',
      '10',
      '9',
    ]);
    expect(sorted(list, { key: 'queryMs', desc: false }).map((s) => s.id)).toEqual([
      '10',
      '100',
      '9',
    ]);
  });

  it('orders text without minding case', () => {
    const list = [session('1', { user: 'bob' }), session('2', { user: 'Alice' })];
    expect(sorted(list, { key: 'user', desc: false }).map((s) => s.user)).toEqual(['Alice', 'bob']);
  });

  it('starts a duration with the longest first and turns round on a second click', () => {
    expect(toggled({ key: 'id', desc: false }, 'queryMs')).toEqual({ key: 'queryMs', desc: true });
    expect(toggled({ key: 'queryMs', desc: true }, 'queryMs')).toEqual({
      key: 'queryMs',
      desc: false,
    });
    expect(toggled({ key: 'queryMs', desc: true }, 'user')).toEqual({ key: 'user', desc: false });
  });

  it('filters by any text and by whether a session does something', () => {
    const list = [
      session('1', { statement: 'SELECT * FROM Orders' }),
      session('2', { txMs: 10 }),
      session('3', { blockedBy: ['2'] }),
    ];
    expect(filtered(list, ' orders ', false).map((s) => s.id)).toEqual(['1']);
    expect(filtered(list, '', true).map((s) => s.id)).toEqual(['2', '3']);
    expect(filtered(list, '', false)).toHaveLength(3);
  });

  it('builds the tree of who blocks whom', () => {
    const list = [
      session('1'),
      session('2', { blockedBy: ['1'] }),
      session('3', { blockedBy: ['2'] }),
      session('4', { blockedBy: ['99'] }),
      session('5'),
    ];
    const tree = blockTree(list);
    expect(tree).toHaveLength(1);
    expect(tree[0].session.id).toBe('1');
    expect(tree[0].waiting[0].session.id).toBe('2');
    expect(tree[0].waiting[0].waiting[0].session.id).toBe('3');
    expect(blockedCount(list)).toBe(3);
    expect(blockTree([session('1')])).toEqual([]);
  });

  it('cuts a circle of waiting instead of running for ever', () => {
    const tree = blockTree([
      session('1', { blockedBy: ['2'] }),
      session('2', { blockedBy: ['1'] }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].waiting[0].session.id).toBe('2');
    expect(tree[0].waiting[0].waiting).toEqual([]);
  });

  it('marks what waits and what runs long', () => {
    expect(mark(session('1', { blockedBy: ['2'], queryMs: 120_000 }))).toBe('blocked');
    expect(mark(session('1', { queryMs: 60_000 }))).toBe('long');
    expect(mark(session('1', { txMs: 299_999 }))).toBeNull();
    expect(mark(session('1', { txMs: 300_000 }))).toBe('long');
  });

  it('writes durations and sizes', () => {
    expect(durationText(null)).toBe('');
    expect(durationText(850)).toBe('850 ms');
    expect(durationText(12_400)).toBe('12 s');
    expect(durationText(184_000)).toBe('3 min 4 s');
    expect(durationText(7_500_000)).toBe('2 h 5 min');
    expect(durationText(90_000_000)).toBe('1 d 1 h');
    expect(bytesText(512, 'en')).toBe('512 B');
    expect(bytesText(1_572_864, 'en')).toBe('1.5 MB');
    expect(bytesText(1_572_864, 'de')).toBe('1,5 MB');
  });

  it('gives a rate only from two readings of a counter that grew', () => {
    const at = (ms: number, n: number | null) => ({ at: ms, figures: figures(n) });
    expect(transactionRate(null, at(1000, 50))).toBeNull();
    expect(transactionRate(at(1000, 50), at(3000, 150))).toBe(50);
    expect(transactionRate(at(1000, 500), at(3000, 5))).toBeNull();
    expect(transactionRate(at(1000, 50), at(1000, 60))).toBeNull();
    expect(transactionRate(at(1000, null), at(3000, 60))).toBeNull();
  });

  it('shortens a statement to one line', () => {
    expect(firstLine('SELECT 1\n  FROM   t')).toBe('SELECT 1 FROM t');
    expect(firstLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('keeps the chosen session only while it is there', () => {
    const activity = {
      sessions: [session('7')],
      figures: figures(null),
      cut: false,
      missing: [],
      canCancel: true,
    };
    expect(stillThere(activity, '7')?.id).toBe('7');
    expect(stillThere(activity, '8')).toBeNull();
    expect(stillThere(null, '7')).toBeNull();
  });
});
