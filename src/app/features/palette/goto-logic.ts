import { NameHit, NameKind } from '../../core/schema/schema.models';
import { fuzzyMatch } from './palette-logic';

/**
 * Pure logic of „go to anything“ (prompt 020): what a query asks for, the hits of what the window itself
 * knows (open tabs, connections), and what a key does with a hit. The objects of the database are searched
 * by the backend (`db/names.rs`).
 */
export type GotoKind = NameKind | 'tab' | 'connection' | 'saved';

/** A hit of the list, whatever it is. */
export interface GotoHit {
  /** Unique in the list (ids of DOM nodes are made of it). */
  readonly key: string;
  readonly kind: GotoKind;
  readonly name: string;
  /** Dimmed behind the name: schema, table of a column, arguments, what a tab is connected to. */
  readonly where: string;
  /** Indices of the characters of `name` that matched. */
  readonly marks: readonly number[];
  /** A name of the database. */
  readonly object?: NameHit;
  /** The id of a tab or a connection. */
  readonly id?: string;
}

/** What to do with a hit. */
export type GotoVariant = 'default' | 'details' | 'insert' | 'select' | 'tree';

/** What is searched where. */
export interface GotoScope {
  /** Ask the backend for names of the database. */
  readonly objects: boolean;
  readonly tabs: boolean;
  readonly connections: boolean;
  /** The text for the local sources (without its prefix). */
  readonly text: string;
  /** `q:` – saved queries (prompt 024). */
  readonly saved: boolean;
}

/**
 * Reads the prefix of a query: `@` connections only; `t:` `v:` `c:` `f:` `s:` names of the database only
 * (the backend reads the prefix itself); `q:` saved queries; nothing: everything.
 */
export function gotoScope(query: string): GotoScope {
  const q = query.trim();
  if (q.startsWith('@')) {
    return {
      objects: false,
      tabs: false,
      connections: true,
      text: q.slice(1).trim(),
      saved: false,
    };
  }
  if (/^q:/i.test(q)) {
    return {
      objects: false,
      tabs: false,
      connections: false,
      text: q.slice(2).trim(),
      saved: true,
    };
  }
  if (/^[tvcfs]:/i.test(q)) {
    return {
      objects: true,
      tabs: false,
      connections: false,
      text: q.slice(2).trim(),
      saved: false,
    };
  }
  return { objects: true, tabs: true, connections: true, text: q, saved: false };
}

export interface LocalItem {
  readonly id: string;
  readonly name: string;
  readonly where: string;
}

/** Tabs or connections that match, the best first; without a text all of them, as given. */
export function localHits(
  kind: 'tab' | 'connection' | 'saved',
  items: readonly LocalItem[],
  text: string,
): GotoHit[] {
  const hits: { hit: GotoHit; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const match = text ? fuzzyMatch(text, item.name) : { score: 0, marks: [] };
    if (!match) return;
    hits.push({
      hit: {
        key: `${kind}-${item.id}`,
        kind,
        name: item.name,
        where: item.where,
        // `fuzzyMatch` counts UTF-16 units; names of tabs and connections outside the BMP are rare enough
        marks: match.marks,
        id: item.id,
      },
      score: match.score,
      order,
    });
  });
  return hits.sort((a, b) => b.score - a.score || a.order - b.order).map((h) => h.hit);
}

/** A name of the database as a hit of the list. */
export function objectHit(hit: NameHit, index: number): GotoHit {
  return {
    key: `name-${index}`,
    kind: hit.kind,
    name: hit.name,
    where:
      hit.kind === 'column'
        ? `${hit.schema}.${hit.parent ?? ''}${hit.detail ? ` · ${hit.detail}` : ''}`
        : hit.kind === 'routine' && hit.detail
          ? `${hit.schema} · (${hit.detail})`
          : hit.schema,
    marks: hit.marks,
    object: hit,
  };
}

/**
 * The list: what the window knows first (an open tab or a connection is the nearest thing to go to), then
 * the names of the database in the order the backend ranked them. Local hits are few: at most `maxLocal`
 * of each kind while there are names, so they never push the names out of sight.
 */
export function mergeHits(
  tabs: readonly GotoHit[],
  connections: readonly GotoHit[],
  names: readonly GotoHit[],
  maxLocal = 5,
): GotoHit[] {
  const cap = names.length > 0 ? maxLocal : Number.MAX_SAFE_INTEGER;
  return [...tabs.slice(0, cap), ...connections.slice(0, cap), ...names];
}

/** What a key means: Enter the usual thing, with modifiers the variants. `null` = not a key of the list. */
export function variantOf(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): GotoVariant | null {
  if (event.key !== 'Enter') return null;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.shiftKey) return 'tree';
  if (mod) return 'select';
  if (event.shiftKey) return 'details';
  if (event.altKey) return 'insert';
  return 'default';
}

/** Whether a variant makes sense for a hit; the usual thing always does. */
export function allowsVariant(hit: GotoHit, variant: GotoVariant): boolean {
  if (variant === 'default') return true;
  // a saved query: put its text into the editor, or open and run it
  if (hit.kind === 'saved') return variant === 'insert' || variant === 'select';
  if (!hit.object) return false;
  const kind = hit.object.kind;
  const relation = kind === 'table' || kind === 'view' || kind === 'matview';
  switch (variant) {
    case 'details':
    case 'tree':
      return kind !== 'column' || variant === 'tree';
    case 'insert':
      return true;
    case 'select':
      return relation;
  }
}

/** A text in pieces by marked characters (indices of characters): `[text, marked]`. */
export function markedChars(text: string, marks: readonly number[]): [string, boolean][] {
  if (marks.length === 0) return [[text, false]];
  const set = new Set(marks);
  const parts: [string, boolean][] = [];
  [...text].forEach((ch, i) => {
    const marked = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last[1] === marked) last[0] += ch;
    else parts.push([ch, marked]);
  });
  return parts;
}

/** The key of an object for „chosen lately“. */
export const recentKey = (hit: NameHit) => `${hit.schema}.${hit.name}`;
