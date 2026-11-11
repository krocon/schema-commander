import { closeQuestion, openFor, txOpen, txStatus } from './tx-logic';

describe('transaction texts', () => {
  it('knows when something is open', () => {
    expect(txOpen('idle')).toBe(false);
    expect(txOpen('unknown')).toBe(false);
    expect(txOpen('active')).toBe(true);
    expect(txOpen('failed')).toBe(true);
  });

  it('says how long', () => {
    expect(openFor(0)).toBe('0 s');
    expect(openFor(59_999)).toBe('59 s');
    expect(openFor(60_000)).toBe('1 min');
    expect(openFor(3_600_000 + 5 * 60_000)).toBe('1 h 5 min');
    expect(openFor(-5)).toBe('0 s');
  });

  it('says nothing while no transaction is open', () => {
    expect(txStatus('idle', null, 0, 1000, 0)).toBeNull();
  });

  it('shows duration and statements, and warns after a while', () => {
    expect(txStatus('active', 1000, 1, 31_000, 300_000)).toBe(
      'Transaktion offen seit 30 s · 1 Anweisung',
    );
    expect(txStatus('active', 0, 3, 360_000, 300_000)).toBe(
      'Transaktion offen seit 6 min · 3 Anweisungen – sie hält Sperren',
    );
    expect(txStatus('active', 0, 3, 360_000, 0)).toBe(
      'Transaktion offen seit 6 min · 3 Anweisungen',
    );
  });

  it('says that a failed transaction can only be rolled back, and when the state is unknown', () => {
    expect(txStatus('failed', 0, 2, 5000, 0)).toContain('nur Rollback möglich');
    expect(txStatus('unknown', null, 0, 0, 0)).toContain('unbekannt');
  });

  it('asks before closing', () => {
    expect(closeQuestion('Der Tab „Abfrage“', 1)).toBe(
      'Der Tab „Abfrage“ hat eine offene Transaktion. Was nicht mit Commit bestätigt wird, geht verloren.',
    );
    expect(closeQuestion('Das Fenster', 3)).toContain('3 Tabs mit offener Transaktion');
  });
});
