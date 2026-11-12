import {
  CompareItem,
  CompareKind,
  CompareState,
  SchemaRename,
  SchemaSnapshot,
} from '../../core/compare/compare-api';
import { COMPARE_TEXTS } from './compare-texts';

/** Pure logic of the schema comparison (prompt 038): what is listed, how two texts differ, the report. */

/** The largest snapshot file that is read. */
export const MAX_SNAPSHOT_CHARS = 64 * 1024 * 1024;
/** Lines of a definition that are compared line by line; longer ones are shown side by side as they are. */
export const MAX_DIFF_LINES = 4000;

/** A snapshot from the text of a file; `null`: this is none. The backend checks it again. */
export function readSnapshot(text: string): SchemaSnapshot | null {
  if (text.length > MAX_SNAPSHOT_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kinds = ['postgres', 'mysql', 'sqlserver', 'sqlite', 'libsql', 'd1'];
  if (typeof o['kind'] !== 'string' || !kinds.includes(o['kind'])) return null;
  if (typeof o['schema'] !== 'string' || !Array.isArray(o['tables'])) return null;
  return raw as SchemaSnapshot;
}

/** What is counted of a snapshot, to say what was loaded. */
export const snapshotLine = (s: SchemaSnapshot): string =>
  COMPARE_TEXTS.snapshotOf(s.schema, s.tables.length, s.views?.length ?? 0);

export interface ItemFilter {
  readonly onlyDifferences: boolean;
  /** `''`: every kind. */
  readonly kind: CompareKind | '';
  readonly text: string;
}

/** The items a filter lets through, in their order (a table, then its parts). */
export function filtered(items: readonly CompareItem[], f: ItemFilter): CompareItem[] {
  const text = f.text.trim().toLowerCase();
  return items.filter(
    (i) =>
      (!f.onlyDifferences || i.state !== 'same') &&
      (f.kind === '' || i.kind === f.kind) &&
      (text === '' || `${i.table ?? ''}.${i.name}`.toLowerCase().includes(text)),
  );
}

/** How many items are in each state. */
export function counts(items: readonly CompareItem[]): Record<CompareState, number> {
  const out: Record<CompareState, number> = { same: 0, onlyLeft: 0, onlyRight: 0, different: 0 };
  for (const i of items) out[i.state] += 1;
  return out;
}

/** The name of an item as it is listed: parts with their table. */
export const itemLabel = (i: CompareItem): string => (i.table ? `${i.table}.${i.name}` : i.name);

/**
 * The rename two items would be, seen from the side that is changed (`target`): a table only on one
 * side and one only on the other, or two columns of one table. `null`: these two are no such pair.
 */
export function renameOf(
  a: CompareItem,
  b: CompareItem,
  target: 'left' | 'right',
): SchemaRename | null {
  if (a.kind !== b.kind || (a.kind !== 'table' && a.kind !== 'column')) return null;
  if (a.kind === 'column' && a.table !== b.table) return null;
  const onTarget = target === 'right' ? 'onlyRight' : 'onlyLeft';
  const onSource = target === 'right' ? 'onlyLeft' : 'onlyRight';
  const from = a.state === onTarget ? a : b.state === onTarget ? b : null;
  const to = a.state === onSource ? a : b.state === onSource ? b : null;
  if (!from || !to || from === to) return null;
  return { table: a.kind === 'column' ? a.table : null, from: from.name, to: to.name };
}

/** One row of two texts side by side. */
export interface DiffRow {
  readonly left: string | null;
  readonly right: string | null;
  readonly state: 'same' | 'changed' | 'left' | 'right';
}

/**
 * Two texts line by line: lines both have (their longest common sequence) stand side by side, the rest
 * on the side that has them – a line that goes next to a line that comes is one changed row.
 */
export function lineDiff(left: string | null, right: string | null): DiffRow[] {
  const a = left === null ? [] : left.split('\n');
  const b = right === null ? [] : right.split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    // too long to align: as they are
    const rows: DiffRow[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const l = a[i] ?? null;
      const r = b[i] ?? null;
      rows.push({ left: l, right: r, state: l === r ? 'same' : 'changed' });
    }
    return rows;
  }
  const same = (x: string, y: string) => x.trim() === y.trim();
  // lengths of the longest common sequence of the ends
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = same(a[i], b[j])
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let gone: string[] = [];
  let come: string[] = [];
  const flush = () => {
    const pairs = Math.min(gone.length, come.length);
    for (let k = 0; k < pairs; k++) rows.push({ left: gone[k], right: come[k], state: 'changed' });
    for (const l of gone.slice(pairs)) rows.push({ left: l, right: null, state: 'left' });
    for (const r of come.slice(pairs)) rows.push({ left: null, right: r, state: 'right' });
    gone = [];
    come = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && same(a[i], b[j])) {
      flush();
      rows.push({ left: a[i], right: b[j], state: 'same' });
      i += 1;
      j += 1;
    } else if (
      j >= b.length ||
      (i < a.length && table[(i + 1) * width + j] >= table[i * width + j + 1])
    ) {
      gone.push(a[i]);
      i += 1;
    } else {
      come.push(b[j]);
      j += 1;
    }
  }
  flush();
  return rows;
}

const mdCell = (text: string) => text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

/** The differences as a Markdown report. */
export function reportMarkdown(
  leftName: string,
  rightName: string,
  items: readonly CompareItem[],
): string {
  const t = COMPARE_TEXTS;
  const c = counts(items);
  const lines = [
    `# ${t.reportTitle(leftName, rightName)}`,
    '',
    t.summary(c.onlyLeft, c.onlyRight, c.different, c.same),
    '',
  ];
  const differing = items.filter((i) => i.state !== 'same');
  if (differing.length === 0) {
    lines.push(t.noDifferences, '');
    return lines.join('\n');
  }
  lines.push(`| ${t.kind} | ${t.object} | ${t.stateHeading} |`, '|---|---|---|');
  for (const i of differing) {
    lines.push(`| ${t.kinds[i.kind]} | ${mdCell(itemLabel(i))} | ${t.states[i.state]} |`);
  }
  lines.push('');
  for (const i of differing.filter((x) => x.state === 'different')) {
    lines.push(
      `## ${t.kinds[i.kind]} ${mdCell(itemLabel(i))}`,
      '',
      `**${mdCell(leftName)}**`,
      '',
      '```',
      (i.left ?? '').replace(/```/g, "'''"),
      '```',
      '',
      `**${mdCell(rightName)}**`,
      '',
      '```',
      (i.right ?? '').replace(/```/g, "'''"),
      '```',
      '',
    );
  }
  return lines.join('\n');
}

/**
 * Renames told for „make right like left“ (names of the right side → names of the left), turned round
 * for the other direction. A column's rename names its table as the side that is changed has it.
 */
export function inverted(renames: readonly SchemaRename[]): SchemaRename[] {
  const tables = renames.filter((r) => r.table === null);
  return renames.map((r) =>
    r.table === null
      ? { table: null, from: r.to, to: r.from }
      : {
          table: tables.find((t) => t.from === r.table)?.to ?? r.table,
          from: r.to,
          to: r.from,
        },
  );
}
