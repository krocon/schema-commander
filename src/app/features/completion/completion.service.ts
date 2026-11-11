import { Injectable, inject } from '@angular/core';
import { SchemaApi } from '../../core/schema/schema-api';
import { DetailSection, NameHit, SchemaInfo } from '../../core/schema/schema.models';
import { SettingsService } from '../../core/settings/settings.service';
import { Dialect, offsetOf, statementAt } from '../editor/sql-split';
import { SchemaStore } from '../schema/schema.store';
import { SqlContext, TableRef, analyse } from './sql-context';
import { Token, lex } from './sql-lex';
import { ForeignKey, Meta, RoutineMeta, Suggestion, TableMeta, needsOf, suggest } from './suggest';

/** What the editor hands a provider (the part the completion reads; see editlicious-editor). */
export interface ProviderContext {
  readonly position: { readonly line: number; readonly ch: number };
  readonly word: string;
  /** The character whose typing asked (`.`, a blank …); `null` when the user asked or typed a word. */
  readonly triggerCharacter?: string | null;
  readonly signal: AbortSignal;
  /** Lines `from..to` (1-based, inclusive). */
  getSlice(from: number, to: number): Promise<string>;
}

/** An entry as the editor takes it. */
export interface ProvidedItem {
  label: string;
  insertText: string;
  kind: string;
  detail?: string;
  documentation?: string;
  sortText: string;
  filterText?: string;
}

/** Where the list opens by itself after a blank: a table is named, or the columns of an INSERT. */
const OPENS_ITSELF: ReadonlySet<string> = new Set(['table', 'join', 'insertColumns']);

/** Lines read around the caret: the statement being written is found in them. */
export const LINES_BEFORE = 400;
export const LINES_AFTER = 150;
/** How long what was read of a table is believed. */
const FRESH_MS = 5 * 60_000;

interface Cached<T> {
  readonly at: number;
  readonly value: Promise<T | null>;
}

/**
 * The completion that knows the schema (prompt 021). For every question of the editor it reads the
 * statement around the caret (never the whole text), finds out what fits there (`sql-context.ts`), reads
 * what it needs of the database – from the name index and the catalog, kept for a few minutes – and answers
 * with the list (`suggest.ts`). Nothing here blocks typing: the editor drops an answer that comes too late,
 * and without a connection the list is made of keywords alone.
 */
@Injectable({ providedIn: 'root' })
export class CompletionService {
  private readonly api = inject(SchemaApi);
  private readonly schema = inject(SchemaStore);
  private readonly settings = inject(SettingsService);
  private readonly tables = new Map<string, Cached<TableMeta>>();
  private readonly schemas = new Map<
    string,
    { at: number; value: Promise<readonly SchemaInfo[]> }
  >();
  private readonly keys = new Map<string, Cached<Pick<TableMeta, 'references' | 'referencedBy'>>>();

  /** The context at the caret of an editor, from the lines around it. */
  async contextAt(context: ProviderContext, dialect: Dialect): Promise<SqlContext> {
    const first = Math.max(1, context.position.line - LINES_BEFORE);
    const text = await context.getSlice(first, context.position.line + LINES_AFTER);
    const offset = offsetOf(text, context.position.line - first + 1, context.position.ch);
    const statement = statementAt(text, offset, dialect);
    // the caret stands behind the last statement, or the text is empty: a new one begins
    if (!statement || offset > statement.end + 1) return analyse('', 0, dialect);
    // not the trimmed text: blanks before the caret may be inside a string that is still open
    const whole = text.slice(statement.start, Math.max(statement.end, offset));
    return analyse(whole, Math.max(0, offset - statement.start), dialect);
  }

  /** The entries for the caret of an editor; `null` = nothing to offer. */
  async provide(
    connectionId: string | null,
    dialect: Dialect,
    context: ProviderContext,
  ): Promise<{ items: ProvidedItem[]; incomplete: boolean } | null> {
    let sql: SqlContext;
    try {
      sql = await this.contextAt(context, dialect);
    } catch {
      return null;
    }
    if (sql.expect === 'none' || context.signal.aborted) return null;
    // a blank, a comma or a parenthesis opens the list only where a name of the database is due –
    // behind FROM, JOIN, INTO … –, never after every word
    const quiet = context.triggerCharacter && context.triggerCharacter !== '.';
    if (quiet && !OPENS_ITSELF.has(sql.expect)) return null;
    const meta = connectionId ? await this.meta(connectionId, sql, context.signal) : null;
    if (context.signal.aborted) return null;
    const list = suggest(sql, meta?.meta ?? this.offline(), {
      dialect,
      keywordCase: this.settings.settings().completionKeywordCase,
    });
    if (list.length === 0) return null;
    return { items: list.map(toItem), incomplete: meta?.narrowed ?? false };
  }

  private offline(): Meta {
    return { currentSchema: '', schemas: [], tables: [], routines: [] };
  }

  /**
   * What the list needs of the database, read side by side. A part that fails (not connected, no rights)
   * is simply missing. `narrowed`: tables or routines were asked for by the word typed so far, so the
   * editor must ask again when the word changes.
   */
  private async meta(
    id: string,
    sql: SqlContext,
    signal: AbortSignal,
  ): Promise<{ meta: Meta; narrowed: boolean }> {
    const needs = needsOf(sql);
    const known = await this.schemasOf(id);
    const currentSchema = known.find((s) => s.current)?.name ?? '';
    const nameContext = {
      currentSchema,
      recent: this.settings.settings().recentObjects,
    };
    const search = (query: string) =>
      this.api.names(id, query, nameContext).then(
        (found) => found.hits,
        () => [] as readonly NameHit[],
      );
    const listed =
      needs.tablesIn === undefined
        ? Promise.resolve([] as readonly NameHit[])
        : search(`t:${needs.tablesIn ? `${needs.tablesIn}.` : ''}${sql.word}`);
    const routines = needs.routines ? search(`f:${sql.word}`) : Promise.resolve([]);
    const read = Promise.all(
      needs.columnsOf.map((ref) => this.table(id, ref, currentSchema, search)),
    );
    const [tableHits, routineHits, scope] = await Promise.all([listed, routines, read]);
    let tables: TableMeta[] = scope.filter((t): t is TableMeta => t !== null);
    if (needs.joins && !signal.aborted) {
      // the foreign keys of the tables in reach: the join proposals are made of them
      const inReach = await Promise.all(
        sql.tables.filter((t) => !t.local).map((ref) => this.table(id, ref, currentSchema, search)),
      );
      const withKeys = await Promise.all(
        inReach
          .filter((t): t is TableMeta => t !== null)
          .map(async (t) => ({ ...t, ...((await this.keysOf(id, t)) ?? {}) })),
      );
      tables = [...withKeys, ...tables];
    }
    for (const hit of tableHits) {
      if (hit.kind === 'column' || hit.kind === 'routine' || hit.kind === 'sequence') continue;
      if (tables.some((t) => t.schema === hit.schema && t.name === hit.name)) continue;
      tables.push({
        schema: hit.schema,
        name: hit.name,
        kind: hit.kind,
        quoted: hit.quoted,
        quotedName: hit.quotedName,
      });
    }
    const meta: Meta = {
      currentSchema,
      // the schemas of the database itself are not offered (their tables still are, when asked for)
      schemas: known.filter((s) => !s.system).map((s) => ({ name: s.name, quoted: s.quoted })),
      tables,
      routines: routineHits.map((hit): RoutineMeta => ({
        schema: hit.schema,
        name: hit.name,
        detail: hit.detail,
        quoted: hit.quoted,
        quotedName: hit.quotedName,
      })),
    };
    return { meta, narrowed: needs.tablesIn !== undefined || needs.routines };
  }

  /**
   * The schemas of a connection: what the tree knows, else asked for once. The completion needs the
   * current one to write names of it without their schema.
   */
  private schemasOf(id: string): Promise<readonly SchemaInfo[]> {
    const known = this.schema.stateOf(id).schemas;
    if (known?.state === 'ready') return Promise.resolve(known.value);
    const cached = this.schemas.get(id);
    if (cached && Date.now() - cached.at < FRESH_MS) return cached.value;
    const value = this.api.schemas(id).catch(() => [] as SchemaInfo[]);
    this.schemas.set(id, { at: Date.now(), value });
    void value.then((list) => {
      if (list.length === 0 && this.schemas.get(id)?.value === value) this.schemas.delete(id);
    });
    return value;
  }

  /** A table a statement names, with its columns; `null` when the database does not know it. */
  private table(
    id: string,
    ref: TableRef,
    currentSchema: string,
    search: (query: string) => Promise<readonly NameHit[]>,
  ): Promise<TableMeta | null> {
    const key = `${id}\u0001${(ref.schema ?? '').toLowerCase()}\u0001${ref.name.toLowerCase()}`;
    const cached = this.tables.get(key);
    if (cached && Date.now() - cached.at < FRESH_MS) return cached.value;
    const value = (async (): Promise<TableMeta | null> => {
      // which schema an unqualified name means: the index knows where the name exists
      const hits = await search(`t:${ref.schema ? `${ref.schema}.` : ''}${ref.name}`);
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      const named = hits.filter(
        (h) => same(h.name, ref.name) && (!ref.schema || same(h.schema, ref.schema)),
      );
      const hit = named.find((h) => same(h.schema, currentSchema)) ?? named[0];
      if (!hit || hit.kind === 'column' || hit.kind === 'routine' || hit.kind === 'sequence') {
        return null;
      }
      const info = await this.api.table(id, hit.schema, hit.name);
      return {
        schema: hit.schema,
        name: hit.name,
        kind: hit.kind,
        quoted: hit.quoted,
        quotedName: hit.quotedName,
        columns: info.columns.map((c) => ({
          name: c.name,
          quoted: c.quoted,
          type: c.typeName,
          key: c.key,
        })),
      };
    })().catch(() => null);
    this.tables.set(key, { at: Date.now(), value });
    // a table that could not be read is asked for again next time
    void value.then((table) => {
      if (table === null && this.tables.get(key)?.value === value) this.tables.delete(key);
    });
    return value;
  }

  /** The foreign keys of a table, both ways (from the object details, prompt 019). */
  private keysOf(
    id: string,
    table: TableMeta,
  ): Promise<Pick<TableMeta, 'references' | 'referencedBy'> | null> {
    const key = `${id}\u0001${table.schema}\u0001${table.name}`;
    const cached = this.keys.get(key);
    if (cached && Date.now() - cached.at < FRESH_MS) return cached.value;
    const value = this.api.details(id, table.schema, table.name, 'table', '').then(
      (details) => ({
        references: foreignKeys(details.sections.find((s) => s.id === 'references')),
        referencedBy: foreignKeys(details.sections.find((s) => s.id === 'referencedBy')).map(
          (fk) => ({
            // seen from the table that is referred to: the other table holds the key
            schema: fk.refSchema,
            name: fk.refName,
            columns: fk.columns,
            refSchema: table.schema,
            refName: table.name,
            // the list does not say which columns are meant: the primary key of this table
            refColumns: (table.columns ?? []).filter((c) => c.key === 'pk').map((c) => c.name),
          }),
        ),
      }),
      () => null,
    );
    this.keys.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * `*` written out (prompt 021): the columns of the tables it stands for – of one table behind `o.*`, of
   * all in reach else – as a replacement for the star at or before `caret`. `null` = no star, or nothing
   * known of its tables.
   */
  async expandStar(
    id: string,
    dialect: Dialect,
    sql: string,
    caret: number,
  ): Promise<{ from: number; to: number; text: string } | null> {
    const tokens = lex(sql, dialect).filter((t) => t.kind !== 'comment');
    const stars = tokens.filter((t, i) => {
      const before = tokens[i - 1];
      // a star of a select list, not a factor: behind SELECT, a comma or `alias.`
      return (
        t.text === '*' &&
        (!before ||
          before.text === ',' ||
          before.text === '.' ||
          ['SELECT', 'DISTINCT', 'ALL'].includes(before.value))
      );
    });
    const star = [...stars].reverse().find((t) => t.start <= caret) ?? stars[0];
    if (!star) return null;
    const at = tokens.indexOf(star);
    const qualified = tokens[at - 1]?.text === '.' ? tokens[at - 2] : undefined;
    const context = analyse(sql, star.start, dialect);
    const wanted = qualified
      ? context.tables.filter((t) => t.alias.toLowerCase() === nameOf(qualified).toLowerCase())
      : context.tables;
    if (wanted.length === 0) return null;
    const currentSchema = (await this.schemasOf(id)).find((s) => s.current)?.name ?? '';
    const search = (query: string) =>
      this.api.names(id, query, { currentSchema, recent: [] }).then(
        (found) => found.hits,
        () => [] as readonly NameHit[],
      );
    const parts: string[] = [];
    for (const ref of wanted) {
      const columns = ref.columns
        ? ref.columns.map((name) => name)
        : ((await this.table(id, ref, currentSchema, search))?.columns ?? []).map((c) => c.quoted);
      if (columns.length === 0) return null;
      // behind `o.` the star already has its table; with several tables every column names its own
      const prefix = qualified ? '' : context.tables.length > 1 ? `${ref.alias}.` : '';
      columns.forEach((column, i) =>
        parts.push(`${qualified && i > 0 ? `${ref.alias}.` : prefix}${column}`),
      );
    }
    return { from: star.start, to: star.end, text: parts.join(', ') };
  }

  /** Forgets what was read (after DDL: the next question reads again). */
  forget(): void {
    this.tables.clear();
    this.keys.clear();
    this.schemas.clear();
  }
}

const nameOf = (token: Token): string => (token.kind === 'quoted' ? token.value : token.text);

const list = (text: string | null | undefined): string[] =>
  (text ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/** The foreign keys a list of the object details holds (`references` or `referencedBy`). */
export function foreignKeys(section: DetailSection | undefined): ForeignKey[] {
  if (!section) return [];
  const at = (key: string) => section.columns.indexOf(key);
  const [columns, refSchema, refName, refColumns] = [
    at('columns'),
    at('refSchema'),
    at('refName'),
    at('refColumns'),
  ];
  return section.rows
    .filter((row) => refName >= 0 && row[refName])
    .map((row) => ({
      columns: list(row[columns]),
      refSchema: (refSchema < 0 ? null : row[refSchema]) ?? '',
      refName: row[refName] ?? '',
      // `referencedBy` does not say which columns are meant: the key of the table that is referred to
      refColumns: refColumns < 0 ? [] : list(row[refColumns]),
    }));
}

/** An entry for the editor; the order of the list is kept by `sortText`. */
export function toItem(suggestion: Suggestion, index: number): ProvidedItem {
  return {
    label: suggestion.label,
    insertText: suggestion.insertText,
    kind: suggestion.kind,
    ...(suggestion.detail ? { detail: suggestion.detail } : {}),
    ...(suggestion.documentation ? { documentation: suggestion.documentation } : {}),
    sortText: String(index).padStart(5, '0'),
    ...(suggestion.filterText ? { filterText: suggestion.filterText } : {}),
  };
}
