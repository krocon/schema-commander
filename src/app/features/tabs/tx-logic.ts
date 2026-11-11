import { TxState } from '../../core/sql/query.models';
import { TABS_TEXTS } from './tabs-texts';

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
  if (tx === 'unknown') return TABS_TEXTS.txUnknown;
  if (!txOpen(tx)) return null;
  const lasted = sinceMs === null ? 0 : now - sinceMs;
  if (tx === 'failed') return TABS_TEXTS.txFailed(openFor(lasted));
  const late = warnAfterMs > 0 && lasted >= warnAfterMs;
  return TABS_TEXTS.txOpen(openFor(lasted), statements, late);
}

/** The question before something with an open transaction is closed; `what` is its name as a subject. */
export function closeQuestion(what: string, tabs: number): string {
  return TABS_TEXTS.closeQuestion(what, tabs);
}
