import { Verdict } from '../../core/sql/query.models';
import {
  GuardRequest,
  badgeText,
  guardTitle,
  nameMatches,
  needingConfirmation,
  needsName,
  shortSql,
} from './guard-logic';

const v = (cls: Verdict['class'], need: Verdict['need']): Verdict => ({ class: cls, need });
const CONNECTION = {
  name: 'Kasse',
  database: 'shop',
  label: 'PROD',
  protection: 'ask' as const,
  color: 2,
};

describe('needingConfirmation', () => {
  it('keeps the statements that need a yes, in their order', () => {
    const sqls = ['SELECT 1', 'UPDATE t SET a = 1 WHERE b = 2', 'DROP TABLE t'];
    const guarded = needingConfirmation(sqls, [
      v('read', 'nothing'),
      v('write', 'confirm'),
      v('dangerous', 'type_name'),
    ]);
    expect(guarded.map((g) => g.sql)).toEqual(sqls.slice(1));
    expect(needsName(guarded)).toBe(true);
    expect(needsName(guarded.slice(0, 1))).toBe(false);
  });

  it('leaves refused statements to the backend and distrusts a short answer', () => {
    expect(needingConfirmation(['INSERT INTO t VALUES (1)'], [v('write', 'refused')])).toEqual([]);
    // a verdict is missing: better ask
    expect(needingConfirmation(['SELECT 1', 'x'], [v('read', 'nothing')])).toHaveLength(1);
  });
});

describe('the dialog', () => {
  const request = (statements: GuardRequest['statements']): GuardRequest => ({
    connection: CONNECTION,
    statements,
    total: 3,
  });

  it('names what happens', () => {
    expect(guardTitle(request([{ sql: 'x', verdict: v('write', 'confirm') }]))).toBe(
      'Diese Anweisung ändert die Datenbank',
    );
    expect(
      guardTitle(
        request([
          { sql: 'x', verdict: v('write', 'confirm') },
          { sql: 'y', verdict: v('dangerous', 'type_name') },
        ]),
      ),
    ).toBe('2 Anweisungen zerstören Daten oder ändern Rechte');
  });

  it('takes the name as typed, but for the spaces around it', () => {
    expect(nameMatches(' Kasse ', 'Kasse')).toBe(true);
    expect(nameMatches('kasse', 'Kasse')).toBe(false);
    expect(nameMatches('', 'Kasse')).toBe(false);
  });

  it('shows a long statement by its start', () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    expect(shortSql(long).split('\n')).toHaveLength(7);
    expect(shortSql(long).endsWith('…')).toBe(true);
    expect(shortSql('x'.repeat(2000)).length).toBe(601);
    expect(shortSql('  SELECT 1  ')).toBe('SELECT 1');
  });
});

describe('badgeText', () => {
  it('marks protected and labelled connections, and no others', () => {
    expect(badgeText(null)).toBeNull();
    expect(badgeText({ label: '', protection: 'free' })).toBeNull();
    expect(badgeText({ label: 'TEST', protection: 'free' })).toBe('TEST');
    expect(badgeText({ label: '', protection: 'ask' })).toBe('geschützt');
    expect(badgeText({ label: 'PROD', protection: 'ask' })).toBe('PROD · geschützt');
    expect(badgeText({ label: ' PROD ', protection: 'readonly' })).toBe('PROD · nur lesen');
  });
});
