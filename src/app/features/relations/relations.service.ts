import { Injectable, inject, signal } from '@angular/core';
import { describeError } from '../../core/errors/app-error';
import { SchemaApi } from '../../core/schema/schema-api';
import { ForeignKey, TableRelations } from '../../core/schema/schema.models';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { QueryColumn, RowWindow } from '../../core/sql/query.models';
import { TableView, queryOf } from '../filter/filter-logic';
import { CopyService } from '../results/copy.service';
import { QueryTab } from '../tabs/query-tab';
import { TabsStore } from '../tabs/tabs.store';
import {
  Direction,
  EMPTY_NAV,
  MAX_VIRTUAL,
  canBack,
  canForward,
  columnIndex,
  keyLabel,
  keysOfColumn,
  linkColumns,
  navGo,
  navPush,
  readVirtual,
  relatedView,
  withVirtual,
} from './relation-logic';
import { RELATION_TEXTS } from './relation-texts';

/** Where the relatives are shown: in the tab, in a new one, or as a look at them. */
export type FollowIn = 'here' | 'tab' | 'peek';

/** Rows of the selection read for their keys at most. */
export const MAX_SOURCE_ROWS = 20_000;
/** Rows a look at the relatives shows. */
export const PEEK_ROWS = 5;
const WINDOW = 1000;
const FOCUS_AFTER_MS = 200;
/** Keys read from the catalog count as current this long. */
export const RELATIONS_FRESH_MS = 60_000;
const TIMEOUT_MS = 30_000;

/** A key in a list to choose from: where it leads, and – once asked – how many rows are there. */
export interface RelationItem {
  readonly key: ForeignKey;
  readonly direction: Direction;
  readonly label: string;
  /** `null`: the rows have no value for this key (NULL), nothing to follow. */
  readonly view: TableView | null;
  readonly count: number | 'busy' | 'failed' | null;
}

export type RelationDialog =
  | {
      readonly kind: 'list';
      readonly tab: QueryTab;
      readonly direction: Direction;
      readonly table: string;
      readonly items: readonly RelationItem[];
      readonly how: FollowIn;
    }
  | {
      readonly kind: 'peek';
      readonly tab: QueryTab;
      readonly title: string;
      readonly view: TableView;
      readonly columns: readonly QueryColumn[];
      readonly rows: RowWindow;
      /** There are more rows than are shown. */
      readonly more: boolean;
    }
  | {
      readonly kind: 'define';
      readonly tab: QueryTab;
      readonly schema: string;
      readonly table: string;
      readonly columns: readonly string[];
      readonly column: string;
    };

/**
 * From a row to its relatives (prompt 030). Works in table views: there the table of every column is
 * known. The foreign keys come from the catalog (and from the user's own relations); the statements for
 * the relatives are built by the backend with every value bound. Each tab keeps the path it came along.
 */
@Injectable({ providedIn: 'root' })
export class RelationsService {
  private readonly schemaApi = inject(SchemaApi);
  private readonly api = inject(QueryApi);
  private readonly settings = inject(SettingsService);
  private readonly tabs = inject(TabsStore);
  private readonly copier = inject(CopyService);
  private readonly t = RELATION_TEXTS;

  /** The keys read from the catalog, by connection and table. */
  private readonly known = signal<Readonly<Record<string, TableRelations>>>({});
  private readonly loading = new Map<string, Promise<TableRelations | null>>();
  private readonly readAt = new Map<string, number>();
  /** The list, the look or the form on screen. */
  readonly dialog = signal<RelationDialog | null>(null);

  private say(text: string): void {
    this.tabs.notice.set(text);
  }

  private place(tab: QueryTab): { connection: string; schema: string; table: string } | null {
    const view = tab.tableView();
    if (!view || !view.schema) return null;
    return { connection: tab.connectionId(), schema: view.schema, table: view.table };
  }

  private static id(p: { connection: string; schema: string; table: string }): string {
    // not joined with a sign a name may hold: `a.b` + `c` is another table than `a` + `b.c`
    return JSON.stringify([p.connection, p.schema, p.table]);
  }

  /** The user's own relations of a connection. */
  virtual(connection: string): ForeignKey[] {
    return readVirtual(this.settings.settings().virtualRelations[connection]);
  }

  /** The keys of the table a tab shows, once they are read (reads signals). */
  relationsOf(tab: QueryTab): TableRelations | undefined {
    const p = this.place(tab);
    if (!p) return undefined;
    const real = this.known()[RelationsService.id(p)];
    if (!real) return undefined;
    return withVirtual(real, this.virtual(p.connection), p.schema, p.table);
  }

  /** The columns of the result of a tab whose cells are links (reads signals). */
  links(tab: QueryTab, columns: readonly QueryColumn[]): ReadonlySet<number> {
    return linkColumns(this.relationsOf(tab), columns);
  }

  /** Reads the keys of the table a tab shows, once; `null` if it shows no table or the catalog fails. */
  ensure(tab: QueryTab): Promise<TableRelations | null> {
    const p = this.place(tab);
    if (!p) return Promise.resolve(null);
    const id = RelationsService.id(p);
    // keys change with DDL: what was read a while ago is read again (what is on screen stays meanwhile)
    const fresh = Date.now() - (this.readAt.get(id) ?? 0) < RELATIONS_FRESH_MS;
    const have = fresh ? this.known()[id] : undefined;
    const merged = () =>
      withVirtual(this.known()[id], this.virtual(p.connection), p.schema, p.table);
    if (have) return Promise.resolve(merged());
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.schemaApi
        .relations(p.connection, p.schema, p.table)
        .then(
          (relations) => {
            this.readAt.set(id, Date.now());
            this.known.update((all) => ({ ...all, [id]: relations }));
            return merged();
          },
          () => null,
        )
        .finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }

  /** The rows the user means: the marked ones, else the row of the cursor. */
  private async sourceRows(
    tab: QueryTab,
  ): Promise<{ rows: RowWindow; columns: readonly QueryColumn[]; cut: boolean } | null> {
    const current = this.copier.current();
    const cursor = tab.grid?.cursor() ?? null;
    if (!current || tab !== this.tabs.active()) return null;
    const marked = this.copier.selection().rows;
    const ranges: readonly (readonly [number, number])[] =
      marked.length > 0 ? marked : cursor ? [[cursor[0], cursor[0]]] : [];
    if (ranges.length === 0) return null;
    const rows: RowWindow[number][] = [];
    let cut = false;
    for (const [a, b] of ranges) {
      for (let from = a; from <= b; from += WINDOW) {
        if (rows.length >= MAX_SOURCE_ROWS) {
          cut = true;
          break;
        }
        const count = Math.min(WINDOW, b - from + 1, MAX_SOURCE_ROWS - rows.length);
        rows.push(...(await tab.window(current.result.resultId, from, count)));
      }
    }
    return { rows, columns: current.result.columns, cut };
  }

  private itemsOf(
    keys: readonly ForeignKey[],
    direction: Direction,
    source: { rows: RowWindow; columns: readonly QueryColumn[] },
    schema: string,
  ): RelationItem[] {
    return keys.map((key) => ({
      key,
      direction,
      label: keyLabel(key, direction, schema),
      view: relatedView(key, direction, source.rows, source.columns).view,
      count: null,
    }));
  }

  /** What stands in the way of following anything from a tab; `null` if nothing does. */
  private async ready(tab: QueryTab) {
    const p = this.place(tab);
    if (!p) {
      this.say(this.t.onlyTables);
      return null;
    }
    const relations = await this.ensure(tab);
    if (!relations) {
      this.say(this.t.noCatalog);
      return null;
    }
    let source;
    try {
      source = await this.sourceRows(tab);
    } catch (e) {
      this.say(describeError(e));
      return null;
    }
    if (!source) {
      this.say(this.t.noRow);
      return null;
    }
    return { p, relations, source };
  }

  /**
   * Forward: to the row(s) the cell of the cursor points to. One key of the column: at once; several, or
   * the cursor beside the keys: a list of the keys of the table.
   */
  async follow(tab: QueryTab, how: FollowIn): Promise<void> {
    const r = await this.ready(tab);
    if (!r) return;
    const cursor = tab.grid?.cursor() ?? null;
    const column = cursor ? r.source.columns[cursor[1]]?.name : undefined;
    const own = column ? keysOfColumn(r.relations, column) : [];
    const keys = own.length > 0 ? own : r.relations.outgoing;
    if (keys.length === 0) return this.say(this.t.noKeys(r.p.table));
    const items = this.itemsOf(keys, 'forward', r.source, r.p.schema);
    if (own.length === 1) return this.open(tab, items[0], how, r.source);
    this.dialog.set({ kind: 'list', tab, direction: 'forward', table: r.p.table, items, how });
  }

  /** Backward: the tables that point to the row(s), to choose from. */
  async referencedBy(tab: QueryTab): Promise<void> {
    const r = await this.ready(tab);
    if (!r) return;
    if (r.relations.incoming.length === 0) return this.say(this.t.noIncoming(r.p.table));
    const items = this.itemsOf(r.relations.incoming, 'backward', r.source, r.p.schema);
    this.dialog.set({
      kind: 'list',
      tab,
      direction: 'backward',
      table: r.p.table,
      items,
      how: 'here',
    });
  }

  /** Opens what an item leads to. */
  async open(
    tab: QueryTab,
    item: RelationItem,
    how: FollowIn,
    source?: { rows: RowWindow; columns: readonly QueryColumn[]; cut?: boolean },
  ): Promise<void> {
    const view = item.view;
    if (!view) {
      const values = source
        ? relatedView(item.key, item.direction, source.rows, source.columns).values
        : null;
      return this.say(values && values.long > 0 ? this.t.longKey : this.t.nullKey);
    }
    const connection = tab.connectionId();
    const title = view.table;
    if (source) {
      const values = relatedView(item.key, item.direction, source.rows, source.columns).values;
      if (values.cut || source.cut) this.say(this.t.cut(values.keys?.rows.length ?? 0));
    }
    try {
      if (how === 'peek') {
        const built = await this.api.tableQuery(
          connection,
          queryOf({ ...view, spec: { ...view.spec, limit: PEEK_ROWS + 1 } }),
        );
        const out = await this.api.run(connection, built.sql, TIMEOUT_MS, undefined, {
          params: built.params,
        });
        let rows: RowWindow = [];
        if (out.resultId !== null) {
          try {
            rows = await this.api.window(out.resultId, 0, PEEK_ROWS + 1);
          } finally {
            void this.api.free([out.resultId]).catch(() => undefined);
          }
        }
        this.dialog.set({
          kind: 'peek',
          tab,
          title,
          view,
          columns: out.columns,
          rows: rows.slice(0, PEEK_ROWS),
          more: rows.length > PEEK_ROWS,
        });
        return;
      }
      this.dialog.set(null);
      if (how === 'tab') {
        const built = await this.api.tableQuery(connection, queryOf(view));
        const next = this.tabs.newTab(built.display, { title, customTitle: true, connection });
        next.nav.set(navPush(EMPTY_NAV, { view, title }));
        await next.openTable(view, built);
        return;
      }
      // in this tab: the place the user leaves is the start of the path, if there is none yet
      const from = tab.tableView();
      const nav =
        tab.nav().entries.length > 0 || !from
          ? tab.nav()
          : navPush(EMPTY_NAV, { view: from, title: from.table });
      tab.nav.set(navPush(nav, { view, title }));
      await tab.openTable(view);
      // the grid shows the new rows a moment later: then it gets the keyboard back
      setTimeout(() => tab.grid?.focusGrid(), FOCUS_AFTER_MS);
    } catch (e) {
      this.say(describeError(e));
    }
  }

  /** From the look at the relatives: open them. */
  async openPeek(how: 'here' | 'tab'): Promise<void> {
    const d = this.dialog();
    if (d?.kind !== 'peek') return;
    const item: RelationItem = {
      key: {
        name: '',
        schema: '',
        table: '',
        columns: [],
        refSchema: '',
        refTable: '',
        refColumns: [],
      },
      direction: 'forward',
      label: d.title,
      view: d.view,
      count: null,
    };
    await this.open(d.tab, item, how);
  }

  /** Counts the rows an item of the list on screen leads to. */
  async count(index: number): Promise<void> {
    const d = this.dialog();
    const item = d?.kind === 'list' ? d.items[index] : undefined;
    if (!d || d.kind !== 'list' || !item?.view || item.count === 'busy') return;
    const set = (count: RelationItem['count']) =>
      this.dialog.update((now) =>
        now === d ||
        (now?.kind === 'list' && now.tab === d.tab && now.items[index]?.key === item.key)
          ? {
              ...(now as typeof d),
              items: (now as typeof d).items.map((it, i) => (i === index ? { ...it, count } : it)),
            }
          : now,
      );
    set('busy');
    const connection = d.tab.connectionId();
    try {
      const built = await this.api.tableQuery(connection, { ...queryOf(item.view), count: true });
      const out = await this.api.run(connection, built.sql, TIMEOUT_MS, undefined, {
        params: built.params,
      });
      let n: number | null = null;
      if (out.resultId !== null) {
        try {
          const cell = (await this.api.window(out.resultId, 0, 1))[0]?.[0];
          n = typeof cell === 'number' || typeof cell === 'string' ? Number(cell) : null;
        } finally {
          void this.api.free([out.resultId]).catch(() => undefined);
        }
      }
      set(n !== null && Number.isFinite(n) ? n : 'failed');
    } catch {
      set('failed');
    }
  }

  /**
   * Counts for every item of the list that leads somewhere – one after the other (they share the session
   * of the connection), and no further once the list is closed.
   */
  async countAll(): Promise<void> {
    const d = this.dialog();
    if (d?.kind !== 'list') return;
    for (let i = 0; i < d.items.length; i++) {
      const now = this.dialog();
      if (now?.kind !== 'list' || now.tab !== d.tab || now.items.length !== d.items.length) return;
      if (now.items[i].view && now.items[i].count === null) await this.count(i);
    }
  }

  close(): void {
    const tab = this.dialog()?.tab;
    this.dialog.set(null);
    setTimeout(() => tab?.grid?.focusGrid());
  }

  // --- the path ---------------------------------------------------------------------------------

  canBack(tab: QueryTab | null): boolean {
    return !!tab && canBack(tab.nav());
  }

  canForward(tab: QueryTab | null): boolean {
    return !!tab && canForward(tab.nav());
  }

  /** Goes to a place of the path of a tab. */
  async go(tab: QueryTab, index: number): Promise<void> {
    const nav = navGo(tab.nav(), index);
    if (nav === tab.nav()) return;
    tab.nav.set(nav);
    await tab.openTable(nav.entries[nav.index].view);
    setTimeout(() => tab.grid?.focusGrid(), FOCUS_AFTER_MS);
  }

  back(tab: QueryTab): Promise<void> {
    return this.go(tab, tab.nav().index - 1);
  }

  forward(tab: QueryTab): Promise<void> {
    return this.go(tab, tab.nav().index + 1);
  }

  // --- relations of the user's own ----------------------------------------------------------------

  /** Opens the form for a relation from the column of the cursor. */
  define(tab: QueryTab): void {
    const p = this.place(tab);
    const current = this.copier.current();
    if (!p || !current) return this.say(this.t.onlyTables);
    const columns = current.result.columns.map((c) => c.name);
    const cursor = tab.grid?.cursor() ?? null;
    this.dialog.set({
      kind: 'define',
      tab,
      schema: p.schema,
      table: p.table,
      columns,
      column: (cursor && columns[cursor[1]]) ?? columns[0] ?? '',
    });
  }

  /** The user's own relations that start at the table of the form. */
  ownOf(connection: string, schema: string, table: string): ForeignKey[] {
    return this.virtual(connection).filter(
      (k) =>
        k.schema.toLowerCase() === schema.toLowerCase() &&
        k.table.toLowerCase() === table.toLowerCase(),
    );
  }

  private store(connection: string, keys: ForeignKey[]): void {
    const all = { ...this.settings.settings().virtualRelations };
    if (keys.length === 0) delete all[connection];
    else all[connection] = keys.slice(0, MAX_VIRTUAL);
    this.settings.update({ virtualRelations: all });
  }

  /** Adds a relation of one column; `false` if a name is missing. */
  addVirtual(
    connection: string,
    from: { schema: string; table: string; column: string },
    to: { schema: string; table: string; column: string },
  ): boolean {
    const clean = (s: string) => s.trim();
    if (!clean(from.column) || !clean(to.table) || !clean(to.column)) return false;
    const key: ForeignKey = {
      name: '',
      schema: from.schema,
      table: from.table,
      columns: [clean(from.column)],
      refSchema: clean(to.schema) || from.schema,
      refTable: clean(to.table),
      refColumns: [clean(to.column)],
    };
    const same = (k: ForeignKey) => JSON.stringify({ ...k, name: '' }) === JSON.stringify(key);
    const all = this.virtual(connection);
    if (!all.some(same)) this.store(connection, [...all, key]);
    return true;
  }

  removeVirtual(connection: string, key: ForeignKey): void {
    const id = JSON.stringify({ ...key, name: '' });
    this.store(
      connection,
      this.virtual(connection).filter((k) => JSON.stringify({ ...k, name: '' }) !== id),
    );
  }

  /** Whether a column of the result of a tab is in the result at all (for the form). */
  hasColumn(columns: readonly QueryColumn[], name: string): boolean {
    return columnIndex(columns, name) >= 0;
  }
}
