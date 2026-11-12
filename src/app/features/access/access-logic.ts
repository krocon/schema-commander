/** Users, roles and rights (prompt 047): the matrix, the changes that wait, "rights like". Pure. */
import { AccessChange, Grant, Principal, Who } from '../../core/access/access-api';
import { DbKind } from '../../core/connections/connection.models';
import catalog from './privileges.json';

/** The privileges that can be granted from here – the list of the backend (a test there holds them equal). */
export function privilegesOf(kind: DbKind, level: string): readonly string[] {
  const levels = (catalog as Record<string, Record<string, string[]>>)[kind] ?? {};
  return levels[level] ?? [];
}

/** The levels a right can be granted on, for a database. */
export function levelsOf(kind: DbKind): string[] {
  return Object.keys((catalog as Record<string, Record<string, string[]>>)[kind] ?? {});
}

export const sameWho = (a: Who, b: Who): boolean => a.name === b.name && a.host === b.host;

export const labelOf = (who: Who): string =>
  who.host === '' ? who.name : `${who.name}@${who.host}`;

/** The principals whose name, role or attribute holds `text`; users first, then roles, by name. */
export function listed(principals: readonly Principal[], text: string): Principal[] {
  const needle = text.trim().toLowerCase();
  return principals
    .filter(
      (p) =>
        needle === '' ||
        p.label.toLowerCase().includes(needle) ||
        p.memberOf.some((r) => r.toLowerCase().includes(needle)) ||
        p.attributes.some((a) => a.toLowerCase().includes(needle)),
    )
    .sort(
      (a, b) =>
        Number(b.login) - Number(a.login) ||
        a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
    );
}

/** A change that waits, with the password that goes with it (never part of the change). */
export interface Pending {
  readonly change: AccessChange;
  readonly password: string | null;
}

type GrantChange = Extract<AccessChange, { op: 'grant' }>;

const sameTarget = (a: GrantChange, b: GrantChange): boolean =>
  sameWho(a.who, b.who) &&
  a.level === b.level &&
  a.schema === b.schema &&
  a.object === b.object &&
  a.column === b.column &&
  a.privilege === b.privilege;

/** Whether two changes are about the same thing, so the later one replaces or undoes the earlier one. */
function sameSubject(a: AccessChange, b: AccessChange): boolean {
  if (a.op !== b.op) return false;
  switch (a.op) {
    case 'grant':
      return sameTarget(a, b as GrantChange);
    case 'member': {
      const o = b as Extract<AccessChange, { op: 'member' }>;
      return sameWho(a.role, o.role) && sameWho(a.member, o.member);
    }
    case 'attribute': {
      const o = b as Extract<AccessChange, { op: 'attribute' }>;
      return sameWho(a.who, o.who) && a.attribute === o.attribute;
    }
    case 'password':
    case 'create':
    case 'drop':
      return sameWho(a.who, (b as typeof a).who);
  }
}

const direction = (c: AccessChange): boolean | null =>
  c.op === 'grant' || c.op === 'member' ? c.add : c.op === 'attribute' ? c.on : null;

/**
 * Adds a change to those that wait. A change that undoes one that waits (grant, then revoke the same)
 * takes that one away instead; a change about the same thing replaces the earlier one.
 */
export function queued(pending: readonly Pending[], next: Pending): Pending[] {
  const at = pending.findIndex((p) => sameSubject(p.change, next.change));
  if (at < 0) return [...pending, next];
  const before = direction(pending[at].change);
  const now = direction(next.change);
  const rest = pending.filter((_, i) => i !== at);
  // the opposite of what waits: both are gone
  if (before !== null && now !== null && before !== now) return rest;
  return [...rest, next];
}

/** One cell of the matrix: a privilege on an object. */
export interface MatrixCell {
  readonly privilege: string;
  /** Granted to the principal itself. */
  readonly direct: boolean;
  readonly grantable: boolean;
  /** The roles it comes through as well (`PUBLIC` for everybody). */
  readonly via: readonly string[];
  /** What a change that waits will make of `direct`; `null`: nothing waits. */
  readonly planned: boolean | null;
}

export interface MatrixRow {
  readonly schema: string;
  readonly object: string;
  readonly owner: boolean;
  readonly cells: readonly MatrixCell[];
}

/** `ALL` granted directly holds every privilege of the level. */
const holds = (g: Grant, privilege: string): boolean =>
  g.privilege === privilege || g.privilege === 'ALL' || g.privilege === 'ALL PRIVILEGES';

/**
 * Objects × privileges for one principal: what it holds on each table of a schema, itself and through
 * roles, and what the changes that wait will make of it.
 */
export function matrix(
  who: Who,
  schema: string,
  objects: readonly string[],
  privileges: readonly string[],
  grants: readonly Grant[],
  pending: readonly Pending[],
): MatrixRow[] {
  const mine = grants.filter((g) => g.level === 'table' && g.schema === schema);
  return objects.map((object) => {
    const here = mine.filter((g) => g.object === object);
    return {
      schema,
      object,
      owner: here.some((g) => g.privilege === 'OWNER' && g.via === ''),
      cells: privileges.map((privilege) => {
        const held = here.filter((g) => holds(g, privilege));
        const waiting = pending
          .map((p) => p.change)
          .find(
            (c): c is GrantChange =>
              c.op === 'grant' &&
              sameWho(c.who, who) &&
              c.level === 'table' &&
              c.schema === schema &&
              c.object === object &&
              c.privilege === privilege,
          );
        return {
          privilege,
          direct: held.some((g) => g.via === '' && g.privilege === privilege),
          grantable: held.some((g) => g.via === '' && g.grantable),
          via: [...new Set(held.filter((g) => g.via !== '').map((g) => g.via))].sort(),
          planned: waiting ? waiting.add : null,
        };
      }),
    };
  });
}

/** The change a click on a cell of the matrix asks for. */
export function cellChange(who: Who, row: MatrixRow, cell: MatrixCell): AccessChange {
  const now = cell.planned ?? cell.direct;
  return {
    op: 'grant',
    who,
    level: 'table',
    schema: row.schema,
    object: row.object,
    column: '',
    privilege: cell.privilege,
    grantable: false,
    add: !now,
  };
}

/**
 * "Rights like": the grants that give `to` what `source` holds itself and `to` does not – as far as it
 * can be granted from here.
 */
export function likeChanges(
  kind: DbKind,
  to: Who,
  source: readonly Grant[],
  target: readonly Grant[],
): AccessChange[] {
  const has = (g: Grant) =>
    target.some(
      (t) =>
        t.via === '' &&
        t.level === g.level &&
        t.schema === g.schema &&
        t.object === g.object &&
        t.column === g.column &&
        t.privilege === g.privilege,
    );
  return source
    .filter((g) => g.via === '' && privilegesOf(kind, g.level).includes(g.privilege) && !has(g))
    .map((g) => ({
      op: 'grant' as const,
      who: to,
      level: g.level,
      schema: g.schema,
      object: g.object,
      column: g.column,
      privilege: g.privilege,
      grantable: g.grantable,
      add: true,
    }));
}

/** The grants in an order to read: by level, object, privilege; own rights before inherited ones. */
export function sortedGrants(grants: readonly Grant[], text: string): Grant[] {
  const needle = text.trim().toLowerCase();
  return grants
    .filter(
      (g) =>
        needle === '' ||
        [g.level, g.schema, g.object, g.column, g.privilege, g.via].some((v) =>
          v.toLowerCase().includes(needle),
        ),
    )
    .sort(
      (a, b) =>
        a.level.localeCompare(b.level) ||
        a.schema.localeCompare(b.schema) ||
        a.object.localeCompare(b.object) ||
        a.column.localeCompare(b.column) ||
        a.privilege.localeCompare(b.privilege) ||
        a.via.localeCompare(b.via),
    );
}

/** `schema.object.column`, as far as there is one. */
export function objectName(g: Grant): string {
  return [g.schema, g.object, g.column].filter((p) => p !== '').join('.');
}

/**
 * Whether every password that waits can travel as a verifier (PostgreSQL): plain ASCII. Any other goes to
 * the server as text – which may write it into its log. Mirrors `password_literal` in access.rs.
 */
export function travelAsVerifier(pending: readonly Pending[]): boolean {
  return pending.every((p) => {
    if (p.password === null) return true;
    for (let i = 0; i < p.password.length; i++) {
      const c = p.password.charCodeAt(i);
      if (c < 32 || c > 126) return false;
    }
    return true;
  });
}

/** A name a user or role can have: something, and no line break. */
export function nameProblem(name: string): 'empty' | 'control' | null {
  if (name.trim() === '') return 'empty';
  for (let i = 0; i < name.length; i++) if (name.charCodeAt(i) < 32) return 'control';
  return null;
}
