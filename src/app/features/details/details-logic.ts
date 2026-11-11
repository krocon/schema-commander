import { DetailSection, ObjectKind } from '../../core/schema/schema.models';

/** An object the details are shown of. */
export interface DetailTarget {
  readonly connectionId: string;
  readonly schema: string;
  readonly name: string;
  readonly kind: ObjectKind;
  /** The arguments of a routine as the tree shows them (tells overloads apart). */
  readonly detail: string;
}

/** The lists in the order the dialog shows them; lists it does not know come last, as they came. */
export const SECTION_ORDER = [
  'columns',
  'properties',
  'parameters',
  'values',
  'indexes',
  'constraints',
  'references',
  'referencedBy',
  'triggers',
  'partitions',
  'uses',
  'usedBy',
  'privileges',
  'stats',
] as const;

export function orderSections(sections: readonly DetailSection[]): DetailSection[] {
  const rank = (id: string) => {
    const i = (SECTION_ORDER as readonly string[]).indexOf(id);
    return i < 0 ? SECTION_ORDER.length : i;
  };
  return [...sections].sort((a, b) => rank(a.id) - rank(b.id));
}

const fold = (text: string) => text.toLocaleLowerCase();

/** The rows of a list that hold every word of the search in some cell. */
export function filterRows(rows: DetailSection['rows'], query: string): DetailSection['rows'] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((row) => {
    const hay = fold(row.map((cell) => cell ?? '').join('\n'));
    return words.every((w) => hay.includes(w));
  });
}

/** The objects the rows of a list lead to (`refSchema` + `refName`), each once, in their order. */
export function linksOf(section: DetailSection): { schema: string; name: string }[] {
  const s = section.columns.indexOf('refSchema');
  const n = section.columns.indexOf('refName');
  if (n < 0) return [];
  const seen = new Set<string>();
  const out: { schema: string; name: string }[] = [];
  for (const row of section.rows) {
    const name = row[n];
    if (!name) continue;
    const schema = (s < 0 ? null : row[s]) ?? '';
    const key = `${schema}\u0001${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ schema, name });
  }
  return out;
}

/**
 * What a row of `uses`/`usedBy`/`references` … leads to is a table or a view: which, the catalog does not
 * say in these lists. A relation is asked for as a table; the backend reads both the same way.
 */
export function linkTarget(
  from: DetailTarget,
  link: { schema: string; name: string },
): DetailTarget {
  return {
    connectionId: from.connectionId,
    schema: link.schema || from.schema,
    name: link.name,
    kind: 'table',
    detail: '',
  };
}

export const sameTarget = (a: DetailTarget, b: DetailTarget) =>
  a.connectionId === b.connectionId &&
  a.schema === b.schema &&
  a.name === b.name &&
  a.kind === b.kind &&
  a.detail === b.detail;

/** Objects one can go back to at most. */
export const MAX_TRAIL = 30;
