import { Rect, HEADER, ROW, anchor, edgePath } from './er-layout';
import { Detail, ErEdge, ErModel, ErNode, cardinality, shownColumns } from './er-model';

/** Exports of an ER diagram as text (prompt 037), pure: Mermaid, DBML and a stand-alone SVG. */

const plainName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
/** A name in double quotes where it needs them; a quote in it cannot be written and becomes `'`. */
const quoted = (name: string) => (plainName(name) ? name : `"${name.replace(/"/g, "'")}"`);
const word = (text: string) => text.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/** Whether the tables of a model come from more than one schema (then names carry it). */
const manySchemas = (model: ErModel) => new Set(model.nodes.map((n) => n.schema)).size > 1;

/** The model as a Mermaid `erDiagram`. */
export function toMermaid(model: ErModel): string {
  const qualify = manySchemas(model);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const name = (n: ErNode) => quoted(qualify && n.schema ? `${n.schema}.${n.name}` : n.name);
  const lines = ['erDiagram'];
  for (const n of model.nodes) {
    lines.push(`  ${name(n)} {`);
    for (const c of n.columns) {
      const marks = [c.pk ? 'PK' : '', c.fk ? 'FK' : ''].filter(Boolean).join(', ');
      lines.push(`    ${word(c.typeName || 'unknown')} ${word(c.name)}${marks ? ` ${marks}` : ''}`);
    }
    lines.push('  }');
  }
  for (const e of model.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    const c = cardinality(e);
    const left = c.to === 'one' ? '||' : '|o';
    const right = c.from === 'many' ? 'o{' : 'o|';
    const line = e.virtual ? '..' : '--';
    lines.push(
      `  ${name(to)} ${left}${line}${right} ${name(from)} : "${e.columns.join(', ').replace(/"/g, "'")}"`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The model as DBML. */
export function toDbml(model: ErModel): string {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const name = (n: ErNode) => (n.schema ? `${quoted(n.schema)}.${quoted(n.name)}` : quoted(n.name));
  const lines: string[] = [];
  for (const n of model.nodes) {
    lines.push(`Table ${name(n)} {`);
    for (const c of n.columns) {
      const settings = [c.pk ? 'pk' : '', c.nullable ? '' : 'not null'].filter(Boolean);
      const type = plainName(c.typeName)
        ? c.typeName
        : `"${(c.typeName || 'unknown').replace(/"/g, "'")}"`;
      lines.push(
        `  ${quoted(c.name)} ${type}${settings.length ? ` [${settings.join(', ')}]` : ''}`,
      );
    }
    lines.push('}', '');
  }
  for (const e of model.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    const columns = (list: readonly string[]) =>
      list.length === 1 ? quoted(list[0]) : `(${list.map(quoted).join(', ')})`;
    lines.push(
      `Ref: ${name(from)}.${columns(e.columns)} ${e.many ? '>' : '-'} ${name(to)}.${columns(e.refColumns)}`,
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The colours of a drawing, resolved (an exported file knows no tokens). */
export interface Palette {
  readonly background: string;
  readonly panel: string;
  readonly border: string;
  readonly text: string;
  readonly dim: string;
  readonly accent: string;
}

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The marks at the two ends of a key, as words for `marker-*` ids. */
export function markers(edge: ErEdge): { readonly start: string; readonly end: string } {
  const c = cardinality(edge);
  return {
    start: c.from === 'many' ? 'er-many' : 'er-zero-one',
    end: c.to === 'one' ? 'er-one' : 'er-zero-one',
  };
}

/** The `<defs>` with the marks of crow's-foot notation, in one colour. */
export function markerDefs(color: string, background: string): string {
  const base = `markerUnits="userSpaceOnUse" markerWidth="18" markerHeight="14" refY="7" orient="auto-start-reverse"`;
  const stroke = `fill="none" stroke="${color}" stroke-width="1.4"`;
  return (
    `<marker id="er-many" ${base} refX="0"><path d="M0,1 L12,7 L0,13 M12,7 L0,7" ${stroke}/>` +
    `<circle cx="15" cy="7" r="2.6" fill="${background}" stroke="${color}" stroke-width="1.2"/></marker>` +
    `<marker id="er-one" ${base} refX="0"><path d="M5,1 L5,13 M9,1 L9,13" ${stroke}/></marker>` +
    `<marker id="er-zero-one" ${base} refX="0"><path d="M4,1 L4,13" ${stroke}/>` +
    `<circle cx="11" cy="7" r="2.6" fill="${background}" stroke="${color}" stroke-width="1.2"/></marker>`
  );
}

/**
 * The diagram as a file of its own: every colour written out, nothing but text and shapes. `rects`
 * holds where each table stands and how large it is.
 */
export function toSvg(
  model: ErModel,
  rects: ReadonlyMap<string, Rect>,
  detail: Detail,
  palette: Palette,
): string {
  const all = [...rects.values()];
  const minX = Math.min(0, ...all.map((r) => r.x)) - 30;
  const minY = Math.min(0, ...all.map((r) => r.y)) - 30;
  const maxX = Math.max(100, ...all.map((r) => r.x + r.w)) + 70;
  const maxY = Math.max(60, ...all.map((r) => r.y + r.h)) + 30;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" ` +
      `width="${maxX - minX}" height="${maxY - minY}" font-family="system-ui, sans-serif" font-size="12">`,
    `<defs>${markerDefs(palette.dim, palette.background)}</defs>`,
    `<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${palette.background}"/>`,
  ];
  const nodeOf = new Map(model.nodes.map((n) => [n.id, n]));
  const at = (id: string, columns: readonly string[]) => {
    const node = nodeOf.get(id);
    return node ? anchor(node, detail, columns) : null;
  };
  const nth = new Map<string, number>();
  for (const e of model.edges) {
    const from = rects.get(e.from);
    const to = rects.get(e.to);
    if (!from || !to) continue;
    const pair = `${e.from}\u0000${e.to}`;
    const n = nth.get(pair) ?? 0;
    nth.set(pair, n + 1);
    const m = markers(e);
    out.push(
      `<path d="${edgePath(from, to, e.from === e.to, n, at(e.from, e.columns), at(e.to, e.refColumns))}" fill="none" stroke="${palette.dim}" stroke-width="1.4"` +
        `${e.virtual ? ' stroke-dasharray="6 4"' : ''} marker-start="url(#${m.start})" marker-end="url(#${m.end})"/>`,
    );
  }
  for (const n of model.nodes) {
    const r = rects.get(n.id);
    if (!r) continue;
    out.push(
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="5" fill="${palette.panel}" stroke="${palette.border}"/>`,
      `<text x="${r.x + 10}" y="${r.y + 17}" font-weight="600" fill="${palette.text}">${esc(n.name)}</text>`,
    );
    const columns = shownColumns(n, detail);
    if (columns.length > 0) {
      out.push(`<path d="M${r.x},${r.y + HEADER} h${r.w}" stroke="${palette.border}"/>`);
    }
    columns.forEach((c, i) => {
      const y = r.y + HEADER + 14 + i * ROW;
      const mark = c.pk ? 'PK ' : c.fk ? 'FK ' : '';
      out.push(
        `<text x="${r.x + 10}" y="${y}" fill="${c.pk || c.fk ? palette.accent : palette.text}">${esc(mark + c.name)}</text>`,
      );
      if (detail === 'all') {
        out.push(
          `<text x="${r.x + r.w - 10}" y="${y}" text-anchor="end" fill="${palette.dim}">${esc(c.typeName)}</text>`,
        );
      }
    });
  }
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}
