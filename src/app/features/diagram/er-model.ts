import { DiagramData, ForeignKey } from '../../core/schema/schema.models';

/**
 * The model of an ER diagram (prompt 037), pure: tables as nodes, foreign keys as edges with what they
 * say about „one“ and „many“. Built from what the catalog gives and the relations the user defined.
 */

export interface ErColumn {
  readonly name: string;
  readonly typeName: string;
  readonly nullable: boolean;
  readonly pk: boolean;
  /** Part of a foreign key of the table. */
  readonly fk: boolean;
}

export interface ErNode {
  /** Schema and name, unique in the diagram. */
  readonly id: string;
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly ErColumn[];
}

export interface ErEdge {
  readonly id: string;
  /** The table that has the key (the „many“ side, unless the key is unique). */
  readonly from: string;
  /** The table the key points to. */
  readonly to: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly refColumns: readonly string[];
  /** Several rows of `from` may point to one row of `to`; `false`: at most one (the key is unique). */
  readonly many: boolean;
  /** A row of `from` may point to nothing (a column of the key takes NULL). */
  readonly optional: boolean;
  /** Defined by the user, not by the database (prompt 030): drawn dashed. */
  readonly virtual: boolean;
}

export interface ErModel {
  readonly nodes: readonly ErNode[];
  readonly edges: readonly ErEdge[];
}

export const EMPTY_MODEL: ErModel = { nodes: [], edges: [] };

/** The id of a table in a diagram. */
export const nodeId = (schema: string, name: string): string => `${schema}\u0000${name}`;

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * The model of a schema. Keys that lead to a table outside of it are left out (their number is
 * `outside`); a virtual relation that names tables or columns the schema does not have is, too.
 */
export function buildModel(
  data: DiagramData,
  virtual: readonly ForeignKey[] = [],
): { model: ErModel; outside: number } {
  const ids = new Set(data.tables.map((t) => nodeId(t.schema, t.name)));
  const columnsOf = new Map(data.tables.map((t) => [nodeId(t.schema, t.name), t.columns]));
  let outside = 0;
  const edges: ErEdge[] = [];
  const seen = new Set<string>();
  const add = (key: ForeignKey, isVirtual: boolean) => {
    const from = nodeId(key.schema, key.table);
    const to = nodeId(key.refSchema, key.refTable);
    if (!ids.has(from) || !ids.has(to)) {
      outside += 1;
      return;
    }
    const own = columnsOf.get(from) ?? [];
    const target = columnsOf.get(to) ?? [];
    if (
      key.columns.length === 0 ||
      key.columns.length !== key.refColumns.length ||
      !key.columns.every((c) => own.some((o) => o.name === c)) ||
      !key.refColumns.every((c) => target.some((o) => o.name === c))
    ) {
      outside += 1;
      return;
    }
    const id = `${from}\u0000${key.name}\u0000${key.columns.join(',')}\u0000${to}`;
    if (seen.has(id)) return;
    seen.add(id);
    const unique = data.unique.some(
      (u) => nodeId(key.schema, u.table) === from && sameSet(u.columns, key.columns),
    );
    edges.push({
      id,
      from,
      to,
      name: key.name,
      columns: key.columns,
      refColumns: key.refColumns,
      many: !unique,
      optional: key.columns.some((c) => own.find((o) => o.name === c)?.nullable ?? true),
      virtual: isVirtual,
    });
  };
  data.keys.forEach((k) => add(k, false));
  virtual.forEach((k) => add(k, true));
  const nodes: ErNode[] = data.tables.map((t) => {
    const id = nodeId(t.schema, t.name);
    const inKey = new Set(edges.filter((e) => e.from === id).flatMap((e) => e.columns));
    return {
      id,
      schema: t.schema,
      name: t.name,
      columns: t.columns.map((c) => ({ ...c, fk: inKey.has(c.name) })),
    };
  });
  return { model: { nodes, edges }, outside };
}

/** The tables a table is related to, in either direction (not itself). */
export function neighbours(model: ErModel, id: string): string[] {
  const out = new Set<string>();
  for (const e of model.edges) {
    if (e.from === id && e.to !== id) out.add(e.to);
    if (e.to === id && e.from !== id) out.add(e.from);
  }
  return [...out];
}

/** The part of a model made of the given tables and the keys between them. */
export function subModel(model: ErModel, ids: ReadonlySet<string>): ErModel {
  return {
    nodes: model.nodes.filter((n) => ids.has(n.id)),
    edges: model.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
}

/** A table and what is related to it, up to `depth` keys away. */
export function neighbourhood(model: ErModel, root: string, depth: number): Set<string> {
  const ids = new Set<string>();
  if (!model.nodes.some((n) => n.id === root)) return ids;
  ids.add(root);
  let edge = [root];
  for (let d = 0; d < depth && edge.length > 0; d++) {
    const next: string[] = [];
    for (const id of edge) {
      for (const n of neighbours(model, id)) {
        if (!ids.has(n)) {
          ids.add(n);
          next.push(n);
        }
      }
    }
    edge = next;
  }
  return ids;
}

/**
 * At most `limit` tables of a model: those with the most keys first (among equals by name), so a large
 * schema starts with its core.
 */
export function mostConnected(model: ErModel, limit: number): Set<string> {
  if (model.nodes.length <= limit) return new Set(model.nodes.map((n) => n.id));
  const degree = new Map<string, number>();
  for (const e of model.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    if (e.to !== e.from) degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  return new Set(
    [...model.nodes]
      .sort(
        (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.name.localeCompare(b.name),
      )
      .slice(0, limit)
      .map((n) => n.id),
  );
}

/** What a key says, in words of crow's-foot notation: the side of `to`, then the side of `from`. */
export function cardinality(edge: ErEdge): {
  readonly to: 'one' | 'zeroOrOne';
  readonly from: 'many' | 'zeroOrOne';
} {
  return { to: edge.optional ? 'zeroOrOne' : 'one', from: edge.many ? 'many' : 'zeroOrOne' };
}

/** How much of a table a diagram shows. */
export type Detail = 'names' | 'keys' | 'all';

/** The columns of a table a level of detail shows. */
export function shownColumns(node: ErNode, detail: Detail): readonly ErColumn[] {
  if (detail === 'names') return [];
  if (detail === 'keys') return node.columns.filter((c) => c.pk || c.fk);
  return node.columns;
}
