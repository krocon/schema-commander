import { TxState } from '../../core/sql/query.models';

/** Whether a transaction is open (and something would be lost or kept by closing). */
export const txOpen = (tx: TxState) => tx === 'active' || tx === 'failed';

/** How long something lasted, for the status line: seconds, then minutes. */
export function openFor(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * What the status line says about the transaction of a tab; `null` when none is open. `warnAfterMs`: from
 * then on it says that the transaction holds locks (0 = never).
 */
export function txStatus(
  tx: TxState,
  sinceMs: number | null,
  statements: number,
  now: number,
  warnAfterMs: number,
): string | null {
  if (tx === 'unknown') return 'Transaktion: Zustand unbekannt (der Server gab keine Auskunft)';
  if (!txOpen(tx)) return null;
  const lasted = sinceMs === null ? 0 : now - sinceMs;
  const count = statements === 1 ? '1 Anweisung' : `${statements} Anweisungen`;
  if (tx === 'failed') {
    return `Transaktion fehlgeschlagen – nur Rollback möglich (offen seit ${openFor(lasted)})`;
  }
  const late = warnAfterMs > 0 && lasted >= warnAfterMs ? ' – sie hält Sperren' : '';
  return `Transaktion offen seit ${openFor(lasted)} · ${count}${late}`;
}

/** The question before something with an open transaction is closed. */
export function closeQuestion(what: string, tabs: number): string {
  const open = tabs === 1 ? 'eine offene Transaktion' : `${tabs} Tabs mit offener Transaktion`;
  return `${what} hat ${open}. Was nicht mit Commit bestätigt wird, geht verloren.`;
}
