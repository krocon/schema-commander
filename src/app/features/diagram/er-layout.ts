import { Detail, ErModel, ErNode, shownColumns } from './er-model';

/**
 * The automatic arrangement of an ER diagram (prompt 037), pure and of our own (no layout library:
 * the graphs are small, the rule is simple, and it stays stable for the same input): tables in layers
 * – a table stands right of everything it points to –, ordered within a layer so that keys cross
 * little, tables without keys in a block of their own.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly w: number;
  readonly h: number;
}

export interface Rect extends Point, Size {}

export const HEADER = 26;
export const ROW = 18;
const CHAR = 7.2;
const PAD = 14;
const GAP_X = 90;
const GAP_Y = 26;
/** Tables stacked in one column of a layer at most. */
const STACK = 12;

/** How large a table is drawn. */
export function nodeSize(node: ErNode, detail: Detail): Size {
  const columns = shownColumns(node, detail);
  const widest = Math.max(
    node.name.length + 2,
    ...columns.map((c) => c.name.length + (detail === 'all' ? c.typeName.length + 5 : 3)),
  );
  return {
    w: Math.round(Math.min(360, Math.max(110, widest * CHAR + 2 * PAD))),
    h: HEADER + columns.length * ROW + (columns.length > 0 ? 6 : 0),
  };
}

/**
 * The layer of every table that has a key: 0 for tables that point to nothing, else one more than the
 * highest layer it points to. Keys that would close a circle (and keys of a table to itself) do not
 * count.
 */
export function layers(model: ErModel): Map<string, number> {
  const parents = new Map<string, string[]>();
  const linked = new Set<string>();
  for (const e of model.edges) {
    if (e.from === e.to) {
      linked.add(e.from);
      continue;
    }
    linked.add(e.from);
    linked.add(e.to);
    parents.set(e.from, [...(parents.get(e.from) ?? []), e.to]);
  }
  const rank = new Map<string, number>();
  const open = new Set<string>();
  const visit = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    // a circle: this key is ignored for the layers
    if (open.has(id)) return -1;
    open.add(id);
    let r = 0;
    for (const p of [...(parents.get(id) ?? [])].sort()) r = Math.max(r, visit(p) + 1);
    open.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const id of [...linked].sort()) visit(id);
  return rank;
}

/** Where every table stands: no two overlap, and the same model gives the same places. */
export function layout(model: ErModel, detail: Detail): Map<string, Point> {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const size = new Map(model.nodes.map((n) => [n.id, nodeSize(n, detail)]));
  const rank = layers(model);
  const columns: string[][] = [];
  for (const [id, r] of rank) (columns[r] ??= []).push(id);
  const name = (id: string) => byId.get(id)?.name ?? id;
  for (const column of columns) column?.sort((a, b) => name(a).localeCompare(name(b)));

  // order within the layers: a table near the middle of what it is linked to in the layer before
  const linked = new Map<string, string[]>();
  for (const e of model.edges) {
    if (e.from === e.to) continue;
    linked.set(e.from, [...(linked.get(e.from) ?? []), e.to]);
    linked.set(e.to, [...(linked.get(e.to) ?? []), e.from]);
  }
  // the same sums whatever order the keys came in
  for (const list of linked.values()) list.sort();
  const sweep = (order: number[]) => {
    for (const r of order) {
      const column = columns[r];
      if (!column) continue;
      const place = new Map<string, number>();
      columns.forEach((c, i) => {
        if (i !== r) c?.forEach((id, n) => place.set(id, n / Math.max(1, c.length - 1 || 1)));
      });
      const weight = (id: string, n: number) => {
        const near = (linked.get(id) ?? []).filter(
          (o) => place.has(o) && Math.abs((rank.get(o) ?? 0) - r) === 1,
        );
        return near.length === 0
          ? n / Math.max(1, column.length - 1 || 1)
          : near.reduce((sum, o) => sum + (place.get(o) ?? 0), 0) / near.length;
      };
      const weights = new Map(column.map((id, n) => [id, weight(id, n)]));
      column.sort(
        (a, b) => (weights.get(a) ?? 0) - (weights.get(b) ?? 0) || name(a).localeCompare(name(b)),
      );
    }
  };
  const down = columns.map((_, i) => i);
  for (let pass = 0; pass < 3; pass++) {
    sweep(down);
    sweep([...down].reverse());
  }

  const out = new Map<string, Point>();
  let x = 0;
  let bottom = 0;
  for (const column of columns) {
    if (!column) continue;
    // a long layer is split into stacks side by side
    for (let from = 0; from < column.length; from += STACK) {
      const stack = column.slice(from, from + STACK);
      let y = 0;
      let width = 0;
      for (const id of stack) {
        const s = size.get(id) ?? { w: 110, h: HEADER };
        out.set(id, { x, y });
        y += s.h + GAP_Y;
        width = Math.max(width, s.w);
      }
      bottom = Math.max(bottom, y);
      x += width + (from + STACK < column.length ? GAP_X / 2 : GAP_X);
    }
  }
  // tables without keys: rows of a block below the rest
  const alone = model.nodes
    .filter((n) => !rank.has(n.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const perRow = Math.max(1, Math.ceil(Math.sqrt(alone.length * 2)));
  let ax = 0;
  let ay = bottom + (bottom > 0 ? GAP_Y : 0);
  let rowHeight = 0;
  alone.forEach((n, i) => {
    const s = size.get(n.id) ?? { w: 110, h: HEADER };
    if (i > 0 && i % perRow === 0) {
      ax = 0;
      ay += rowHeight + GAP_Y;
      rowHeight = 0;
    }
    out.set(n.id, { x: ax, y: ay });
    ax += s.w + GAP_X / 3;
    rowHeight = Math.max(rowHeight, s.h);
  });
  return out;
}

/**
 * How far below the top of a table the row of the first of `columns` is drawn; `null` when the level of
 * detail does not show it.
 */
export function anchor(node: ErNode, detail: Detail, columns: readonly string[]): number | null {
  const row = shownColumns(node, detail).findIndex((c) => c.name === columns[0]);
  return row < 0 ? null : HEADER + 14 + row * ROW - 4;
}

/** The rectangle around everything; `null` for nothing. */
export function bounds(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}

/** Whether two rectangles share an area. */
export const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const n1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The line of a key as an SVG path: from the side of `from` that faces `to` to the facing side of
 * `to`, as a curve; a key of a table to itself as a loop at its right side.
 */
export function edgePath(
  from: Rect,
  to: Rect,
  self: boolean,
  nth = 0,
  fromAt: number | null = null,
  toAt: number | null = null,
): string {
  if (self) {
    const x = from.x + from.w;
    const y1 = from.y + HEADER / 2 + nth * 6;
    const y2 = y1 + 22;
    return `M${n1(x)},${n1(y1)} C${n1(x + 46)},${n1(y1 - 8)} ${n1(x + 46)},${n1(y2 + 8)} ${n1(x)},${n1(y2)}`;
  }
  // at the row of the key's column where it is shown, else at the head of the table
  const fromMid = from.y + (fromAt ?? Math.min(from.h, HEADER) / 2 + nth * 5);
  const toMid = to.y + (toAt ?? Math.min(to.h, HEADER) / 2 + nth * 5);
  // `to` left of `from`: leave on the left, arrive on the right – else the other way round
  const leftwards = to.x + to.w / 2 <= from.x + from.w / 2;
  const x1 = leftwards ? from.x : from.x + from.w;
  const x2 = leftwards ? to.x + to.w : to.x;
  const bend = Math.max(30, Math.abs(x2 - x1) / 2);
  const c1 = leftwards ? x1 - bend : x1 + bend;
  const c2 = leftwards ? x2 + bend : x2 - bend;
  return `M${n1(x1)},${n1(fromMid)} C${n1(c1)},${n1(fromMid)} ${n1(c2)},${n1(toMid)} ${n1(x2)},${n1(toMid)}`;
}
