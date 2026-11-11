import { Profile, Protection } from '../../core/connections/connection.models';
import { StatementClass, Verdict } from '../../core/sql/query.models';

/** A statement that waits for a yes. */
export interface GuardedStatement {
  readonly sql: string;
  readonly verdict: Verdict;
}

/** What the confirmation dialog asks. */
export interface GuardRequest {
  readonly connection: Pick<Profile, 'name' | 'database' | 'label' | 'protection' | 'color'>;
  /** The statements that need a confirmation (not the ones that may run anyway). */
  readonly statements: readonly GuardedStatement[];
  /** All statements of the run. */
  readonly total: number;
}

/** What the user answered: yes, with the typed name where one was needed. */
export interface GuardAnswer {
  readonly typedName: string | null;
}

export const CLASS_LABELS: Readonly<Record<StatementClass, string>> = {
  read: 'liest',
  write: 'ändert Daten',
  ddl: 'ändert das Schema',
  dangerous: 'zerstört oder vergibt Rechte',
};

export const PROTECTION_LABELS: Readonly<Record<Protection, string>> = {
  free: 'frei',
  ask: 'nachfragen',
  readonly: 'nur lesen',
};

/** The statements of a run that need a confirmation, in their order. */
export function needingConfirmation(
  sqls: readonly string[],
  verdicts: readonly Verdict[],
): GuardedStatement[] {
  return sqls
    .map((sql, i) => ({ sql, verdict: verdicts[i] ?? { class: 'write', need: 'confirm' } }))
    .filter((s) => s.verdict.need === 'confirm' || s.verdict.need === 'type_name');
}

/** Whether the name of the connection must be typed. */
export const needsName = (statements: readonly GuardedStatement[]) =>
  statements.some((s) => s.verdict.need === 'type_name');

/** Whether what was typed is the name (spaces around it do not count; case does). */
export const nameMatches = (typed: string, name: string) => typed.trim() === name.trim();

/** The headline of the dialog. */
export function guardTitle(request: GuardRequest): string {
  const worst = request.statements.some((s) => s.verdict.class === 'dangerous');
  const n = request.statements.length;
  const what = n === 1 ? 'Diese Anweisung' : `${n} Anweisungen`;
  return worst
    ? `${what} ${n === 1 ? 'zerstört' : 'zerstören'} Daten oder ändern Rechte`
    : `${what} ${n === 1 ? 'ändert' : 'ändern'} die Datenbank`;
}

/** The mark of a connection in the window: its label, or what its protection is called. */
export function badgeText(profile: Pick<Profile, 'label' | 'protection'> | null): string | null {
  if (!profile) return null;
  const label = profile.label.trim();
  if (profile.protection === 'free') return label || null;
  const protection = profile.protection === 'readonly' ? 'nur lesen' : 'geschützt';
  return label ? `${label} · ${protection}` : protection;
}

/** A statement on a few lines for the dialog. */
export function shortSql(sql: string, maxLines = 6, maxChars = 600): string {
  const lines = sql.trim().split('\n');
  let text = lines.slice(0, maxLines).join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  else if (lines.length > maxLines) text += '\n…';
  return text;
}
