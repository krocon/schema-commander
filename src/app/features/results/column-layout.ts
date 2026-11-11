import { QueryColumn } from '../../core/sql/query.models';

/**
 * How the columns of a result are laid out (prompt 029): their order, which are hidden, which stay at the
 * left, and widths the user set. Columns are named by a key (`columnKeys`), so a layout survives a changed
 * column list: what it does not know is shown where the result has it.
 */
export interface ColumnLayout {
  /** Keys in the order shown. */
  readonly order: readonly string[];
  readonly hidden: readonly string[];
  /** Keys kept at the left, in their order. */
  readonly pinned: readonly string[];
  /** Widths in px the user set. */
  readonly widths: Readonly<Record<string, number>>;
}

export const EMPTY_LAYOUT: ColumnLayout = { order: [], hidden: [], pinned: [], widths: {} };

/** Layouts of so many tables are remembered. */
export const MAX_LAYOUTS = 200;
export const MIN_COLUMN_WIDTH = 30;
export const MAX_COLUMN_WIDTH = 4000;

/** A key per column: its name; a name that occurs again gets its count (`id`, `id#2`). */
export function columnKeys(columns: readonly Pick<QueryColumn, 'name'>[]): string[] {
  const seen = new Map<string, number>();
  return columns.map(({ name }) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}#${n}`;
  });
}

/** A layout applied to the columns of a result. */
export interface ResolvedLayout {
  /** Indices of result columns in the order shown, the pinned ones first. */
  readonly shown: readonly number[];
  /** How many of them stay at the left. */
  readonly pinned: number;
  /** The width the user set, per shown column. */
  readonly widths: readonly (number | undefined)[];
}

/** All keys of the result in the order of the layout; unknown ones stand behind the column before them. */
function ordered(layout: ColumnLayout, keys: readonly string[]): string[] {
  const known = new Set(keys);
  const out = layout.order.filter((k, i) => known.has(k) && layout.order.indexOf(k) === i);
  const placed = new Set(out);
  keys.forEach((key, i) => {
    if (placed.has(key)) return;
    // behind its neighbour in the result, if that one is placed; else at the front
    const before = i > 0 ? out.indexOf(keys[i - 1]) : -1;
    out.splice(before + 1, 0, key);
    placed.add(key);
  });
  return out;
}

export function resolveLayout(
  layout: ColumnLayout,
  columns: readonly Pick<QueryColumn, 'name'>[],
): ResolvedLayout {
  const keys = columnKeys(columns);
  const all = ordered(layout, keys);
  let visible = all.filter((k) => !layout.hidden.includes(k));
  // a grid without columns shows nothing to bring them back with
  if (visible.length === 0) visible = all;
  const pinned = layout.pinned.filter(
    (k, i) => visible.includes(k) && layout.pinned.indexOf(k) === i,
  );
  const rest = visible.filter((k) => !pinned.includes(k));
  const shownKeys = [...pinned, ...rest];
  return {
    shown: shownKeys.map((k) => keys.indexOf(k)),
    // one column at least scrolls
    pinned: rest.length === 0 ? Math.max(0, pinned.length - 1) : pinned.length,
    widths: shownKeys.map((k) => layout.widths[k]),
  };
}

/** Whether the layout changes nothing about these columns. */
export function isPlainLayout(
  layout: ColumnLayout,
  columns: readonly Pick<QueryColumn, 'name'>[],
): boolean {
  const r = resolveLayout(layout, columns);
  return (
    r.pinned === 0 &&
    r.shown.length === columns.length &&
    r.shown.every((c, i) => c === i) &&
    r.widths.every((w) => w === undefined)
  );
}

type Columns = readonly Pick<QueryColumn, 'name'>[];

/** The layout with every key of these columns in its order (what the changes below start from). */
function full(layout: ColumnLayout, columns: Columns): ColumnLayout {
  return { ...layout, order: ordered(layout, columnKeys(columns)) };
}

export function setHidden(
  layout: ColumnLayout,
  columns: Columns,
  key: string,
  hidden: boolean,
): ColumnLayout {
  const base = full(layout, columns);
  const others = base.hidden.filter((k) => k !== key);
  if (!hidden) return { ...base, hidden: others };
  // the last visible column stays
  const visible = base.order.filter((k) => !others.includes(k) && k !== key);
  return visible.length === 0 ? base : { ...base, hidden: [...others, key] };
}

export function showAll(layout: ColumnLayout, columns: Columns): ColumnLayout {
  return { ...full(layout, columns), hidden: [] };
}

export function setPinned(
  layout: ColumnLayout,
  columns: Columns,
  key: string,
  pinned: boolean,
): ColumnLayout {
  const base = full(layout, columns);
  const others = base.pinned.filter((k) => k !== key);
  return { ...base, pinned: pinned ? [...others, key] : others };
}

/**
 * Moves a column one place to the left (`-1`) or right (`1`) among the columns shown beside it: pinned
 * ones move among the pinned, the others among the others. Unchanged at an end.
 */
export function moveColumn(
  layout: ColumnLayout,
  columns: Columns,
  key: string,
  step: -1 | 1,
): ColumnLayout {
  const base = full(layout, columns);
  if (base.pinned.includes(key)) {
    const list = [...base.pinned];
    const at = list.indexOf(key);
    const to = at + step;
    if (to < 0 || to >= list.length) return base;
    [list[at], list[to]] = [list[to], list[at]];
    return { ...base, pinned: list };
  }
  const movable = (k: string) => !base.pinned.includes(k) && !base.hidden.includes(k);
  const order = [...base.order];
  const at = order.indexOf(key);
  let to = at + step;
  while (to >= 0 && to < order.length && !movable(order[to])) to += step;
  if (at < 0 || to < 0 || to >= order.length) return base;
  order.splice(at, 1);
  order.splice(to, 0, key);
  return { ...base, order };
}

/**
 * The layout after the user dragged columns: `shownKeys` is the new order of the shown columns. Hidden
 * columns keep their place behind the column they stood behind.
 */
export function reorder(
  layout: ColumnLayout,
  columns: Columns,
  shownKeys: readonly string[],
): ColumnLayout {
  const base = full(layout, columns);
  const order = [...shownKeys.filter((k) => base.order.includes(k))];
  base.order.forEach((key, i) => {
    if (order.includes(key)) return;
    const before = i > 0 ? order.indexOf(base.order[i - 1]) : -1;
    order.splice(before + 1, 0, key);
  });
  return {
    ...base,
    order,
    pinned: order.filter((k) => base.pinned.includes(k)),
  };
}

export function setWidth(layout: ColumnLayout, key: string, px: number): ColumnLayout {
  const width = Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, px)));
  return { ...layout, widths: { ...layout.widths, [key]: width } };
}

/** The layout without widths: the grid measures again. */
export function withoutWidths(layout: ColumnLayout): ColumnLayout {
  return { ...layout, widths: {} };
}

const strings = (raw: unknown, max: number): string[] =>
  Array.isArray(raw)
    ? [...new Set(raw.filter((k): k is string => typeof k === 'string' && k.length <= 300))].slice(
        0,
        max,
      )
    : [];

/** A layout read from the settings: whatever is no layout is left out. */
export function mergeLayout(raw: unknown): ColumnLayout {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_LAYOUT;
  const r = raw as Record<string, unknown>;
  const widths: Record<string, number> = {};
  if (r['widths'] && typeof r['widths'] === 'object' && !Array.isArray(r['widths'])) {
    for (const [key, px] of Object.entries(r['widths'] as Record<string, unknown>).slice(0, 2000)) {
      if (typeof px === 'number' && Number.isFinite(px) && key.length <= 300) {
        widths[key] = Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, px)));
      }
    }
  }
  return {
    order: strings(r['order'], 2000),
    hidden: strings(r['hidden'], 2000),
    pinned: strings(r['pinned'], 50),
    widths,
  };
}

/** The remembered layouts with one more (or one less, for an empty layout); the oldest go first. */
export function rememberLayout(
  all: Readonly<Record<string, ColumnLayout>>,
  key: string,
  layout: ColumnLayout,
): Record<string, ColumnLayout> {
  const rest = Object.entries(all).filter(([k]) => k !== key);
  const empty =
    layout.order.length === 0 &&
    layout.hidden.length === 0 &&
    layout.pinned.length === 0 &&
    Object.keys(layout.widths).length === 0;
  const next = empty ? rest : [...rest, [key, layout] as [string, ColumnLayout]];
  return Object.fromEntries(next.slice(-MAX_LAYOUTS));
}

/** A row of the column list: a column, where it is and how it is shown. */
export interface ColumnRow {
  readonly key: string;
  readonly index: number;
  readonly name: string;
  readonly typeName: string;
  readonly hidden: boolean;
  readonly pinned: boolean;
}

/** All columns in the order of the layout (hidden ones too), those matching `filter` only. */
export function columnRows(
  layout: ColumnLayout,
  columns: readonly QueryColumn[],
  filter = '',
): ColumnRow[] {
  const keys = columnKeys(columns);
  const all = ordered(layout, keys);
  const pinned = layout.pinned.filter((k) => all.includes(k));
  const needle = filter.trim().toLowerCase();
  return [...pinned, ...all.filter((k) => !pinned.includes(k))]
    .map((key) => {
      const index = keys.indexOf(key);
      return {
        key,
        index,
        name: columns[index].name,
        typeName: columns[index].typeName,
        hidden: layout.hidden.includes(key),
        pinned: pinned.includes(key),
      };
    })
    .filter((row) => needle === '' || row.name.toLowerCase().includes(needle));
}

/** What the app does with the grid of a result from outside (prompt 029). */
export interface ResultGridHandle {
  /** The cell the cursor is on: its row and its column of the result. */
  cursor(): readonly [number, number] | null;
  /** Puts the cursor on a cell and brings it into view; `column`: of the result, `null` = as it is. */
  goTo(row: number, column: number | null): void;
  fitWidths(): void;
  focusGrid(): void;
}
