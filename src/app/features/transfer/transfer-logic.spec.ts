import {
  TransferPlan,
  TransferReport,
  TransferTableReport,
} from '../../core/transfer/transfer-api';
import {
  DEFAULT_REQUEST,
  allDone,
  defaultSchema,
  durationText,
  fitted,
  leftOut,
  losses,
  outcomeOf,
  requestProblem,
  rowsWritten,
} from './transfer-logic';

const request = {
  ...DEFAULT_REQUEST,
  sourceSchema: 'shop',
  tables: ['orders'],
  targetSchema: 'copy',
};

const loaded = (over: Partial<TransferTableReport['loaded']> = {}) => ({
  read: 10,
  written: 10,
  skipped: 0,
  errors: [],
  cancelled: false,
  failed: false,
  rolledBack: false,
  errorFile: false,
  cleared: false,
  ...over,
});

const row = (over: Partial<TransferTableReport> = {}): TransferTableReport => ({
  table: 't',
  skipped: false,
  loaded: loaded(),
  created: false,
  elapsedMs: 100,
  error: null,
  ...over,
});

describe('transfer logic', () => {
  it('knows the schema a database starts with', () => {
    expect(defaultSchema('postgres', 'shop')).toBe('public');
    expect(defaultSchema('sqlserver', 'shop')).toBe('dbo');
    expect(defaultSchema('sqlite', '/tmp/a.db')).toBe('main');
    expect(defaultSchema('mysql', 'shop')).toBe('shop');
  });

  it('skipping rows is never all-or-nothing', () => {
    expect(fitted({ ...request, onError: 'skip', wholeTransaction: true }).wholeTransaction).toBe(
      false,
    );
    expect(fitted(request).wholeTransaction).toBe(true);
  });

  it('says why a request cannot be planned', () => {
    expect(requestProblem(request, 'a', 'b')).toBeNull();
    expect(requestProblem(request, 'a', null)).toBe('noTarget');
    expect(requestProblem({ ...request, tables: [] }, 'a', 'b')).toBe('noTables');
    expect(requestProblem({ ...request, targetSchema: ' ' }, 'a', 'b')).toBe('noSchema');
    // the same connection is fine – into another schema
    expect(requestProblem(request, 'a', 'a')).toBeNull();
    expect(requestProblem({ ...request, targetSchema: 'shop' }, 'a', 'a')).toBe('sameTable');
    expect(requestProblem({ ...request, targetSchema: 'shop' }, 'a', 'b')).toBeNull();
  });

  it('lists what a plan says will be lost, and what is left out', () => {
    const plan: TransferPlan = {
      tables: [
        {
          table: 'orders',
          exists: true,
          columns: [
            { name: 'id', sourceType: 'integer', target: 'id', targetType: 'int', loss: null },
            {
              name: 'at',
              sourceType: 'timestamptz',
              target: 'at',
              targetType: 'datetime(6)',
              loss: 'the zone is lost',
            },
            { name: 'extra', sourceType: 'text', target: null, targetType: null, loss: null },
          ],
          notes: [],
          before: [],
          after: [],
        },
      ],
      statements: [],
      cycle: [],
    };
    expect(losses(plan)).toEqual([
      {
        table: 'orders',
        column: 'at',
        from: 'timestamptz',
        to: 'datetime(6)',
        loss: 'the zone is lost',
      },
    ]);
    expect(leftOut(plan.tables[0])).toEqual(['extra']);
  });

  it('names how a table ended', () => {
    expect(outcomeOf(row())).toBe('done');
    expect(outcomeOf(row({ skipped: true }))).toBe('skipped');
    expect(outcomeOf(row({ loaded: loaded({ cancelled: true }) }))).toBe('stopped');
    expect(outcomeOf(row({ loaded: loaded({ failed: true }) }))).toBe('failed');
    expect(outcomeOf(row({ error: 'no' }))).toBe('failed');
    expect(outcomeOf(row({ loaded: loaded({ skipped: 2, written: 8 }) }))).toBe('withGaps');
  });

  it('sums a report up', () => {
    const report: TransferReport = { tables: [row(), row()], afterErrors: [], cancelled: false };
    expect(allDone(report)).toBe(true);
    expect(rowsWritten(report)).toBe(20);
    expect(allDone({ ...report, afterErrors: ['x'] })).toBe(false);
    expect(allDone({ ...report, cancelled: true })).toBe(false);
    expect(allDone({ ...report, tables: [row({ skipped: true })] })).toBe(false);
  });

  it('writes durations for people', () => {
    expect(durationText(1250, 'de')).toBe('1,3 s');
    expect(durationText(184_000, 'en')).toBe('3 min 4 s');
  });
});
