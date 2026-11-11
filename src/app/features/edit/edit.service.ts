import { Injectable, inject, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SchemaApi } from '../../core/schema/schema-api';
import { ColumnInfo, TableInfo } from '../../core/schema/schema.models';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { Cell, QueryColumn } from '../../core/sql/query.models';
import { needingConfirmation } from '../guard/guard-logic';
import { GuardService } from '../guard/guard.service';
import { CopyService } from '../results/copy.service';
import { QueryTab } from '../tabs/query-tab';
import { TabsStore } from '../tabs/tabs.store';
import {
  EMPTY_BUFFER,
  EditMarks,
  MAX_EDIT_ROWS,
  NewValue,
  ReadOnlyReason,
  ValueProblem,
  editCount,
  editability,
  marksOf,
  maxLength,
  planOf,
  redoEdit,
  resetRow,
  rowKey,
  setCell,
  startText,
  undoEdit,
  validate,
} from './edit-buffer';
import { EDIT_TEXTS } from './edit-texts';

/** A value that is read whole to be edited is at most this long (bytes). */
export const MAX_EDIT_BYTES = 1024 * 1024;
/** Statements a question of the guard shows. */
const GUARD_SHOWN = 20;

/** The cell that is being edited. */
export interface Editing {
  readonly tab: QueryTab;
  readonly row: number;
  /** Index of the result column. */
  readonly column: number;
  readonly key: string;
  readonly original: readonly Cell[];
  readonly meta: QueryColumn;
  readonly info: ColumnInfo | undefined;
  /** What the field starts with. */
  readonly text: string;
}

/**
 * Editing the cells of a table view (prompt 031). Changes are collected in the buffer of the tab and
 * shown in the grid; nothing reaches the database until the user writes them – then all together, in one
 * transaction, built and bound by the backend, through the guard of the connection.
 */
@Injectable({ providedIn: 'root' })
export class EditService {
  private readonly api = inject(QueryApi);
  private readonly schemaApi = inject(SchemaApi);
  private readonly settings = inject(SettingsService);
  private readonly tabs = inject(TabsStore);
  private readonly copier = inject(CopyService);
  private readonly connections = inject(ConnectionsStore);
  private readonly guard = inject(GuardService);
  private readonly t = EDIT_TEXTS;

  /** The columns of tables as the catalog has them (key, NULL allowed), by connection and table. */
  private readonly infos = signal<Readonly<Record<string, TableInfo>>>({});
  private readonly loading = new Set<string>();
  /** The cell in the edit row. */
  readonly editing = signal<Editing | null>(null);
  /** The statements a preview shows. */
  readonly preview = signal<{
    readonly tab: QueryTab;
    readonly statements: readonly string[];
  } | null>(null);
  /** Changes are being written. */
  readonly busy = signal(false);

  private say(text: string): void {
    this.tabs.notice.set(text);
  }

  private static id(tab: QueryTab): string | null {
    const view = tab.tableView();
    return view?.schema ? JSON.stringify([tab.connectionId(), view.schema, view.table]) : null;
  }

  /** Reads the columns of the table a tab shows, once. */
  ensure(tab: QueryTab): void {
    const id = EditService.id(tab);
    const view = tab.tableView();
    if (!id || !view?.schema || this.infos()[id] || this.loading.has(id)) return;
    this.loading.add(id);
    this.schemaApi
      .table(tab.connectionId(), view.schema, view.table)
      .then(
        (info) => this.infos.update((all) => ({ ...all, [id]: info })),
        () => undefined,
      )
      .finally(() => this.loading.delete(id));
  }

  private infoOf(tab: QueryTab): readonly ColumnInfo[] | undefined {
    const id = EditService.id(tab);
    return id ? this.infos()[id]?.columns : undefined;
  }

  /** Whether the result a tab shows can be edited: its key columns, or the reason why not (reads signals). */
  state(
    tab: QueryTab,
    columns: readonly QueryColumn[],
  ):
    { readonly pk: readonly number[] } | { readonly reason: ReadOnlyReason | 'local' | 'running' } {
    const view = tab.tableView();
    const profile = this.connections.profiles().find((p) => p.id === tab.connectionId());
    const base = editability(
      !!view,
      !!view?.schema,
      this.infoOf(tab),
      columns,
      profile?.protection === 'readonly',
    );
    if ('reason' in base) return base;
    if (tab.localView() !== null) return { reason: 'local' };
    if (tab.running()) return { reason: 'running' };
    return base;
  }

  /** What the grid of a tab shows instead of what was read (reads signals). */
  marks(tab: QueryTab): EditMarks | null {
    return marksOf(tab.edits());
  }

  count(tab: QueryTab | null | undefined): { cells: number; rows: number } {
    return tab ? editCount(tab.edits()) : { cells: 0, rows: 0 };
  }

  /** The result and the cell the user is at, if the tab is the one in front and can be edited. */
  private async place(tab: QueryTab) {
    const current = this.copier.current();
    if (!current || tab !== this.tabs.active()) return null;
    const columns = current.result.columns;
    const state = this.state(tab, columns);
    if ('reason' in state) {
      this.say(this.t.reasons[state.reason]);
      return null;
    }
    const cursor = tab.grid?.cursor() ?? null;
    if (!cursor) {
      this.say(this.t.noCell);
      return null;
    }
    const [row, column] = cursor;
    let original: readonly Cell[] | undefined;
    try {
      original = (await tab.window(current.result.resultId, row, 1))[0];
    } catch (e) {
      this.say(describeError(e));
      return null;
    }
    if (!original) return null;
    const key = rowKey(original, state.pk);
    if (key === null) {
      this.say(this.t.noRowKey);
      return null;
    }
    return { resultId: current.result.resultId, columns, row, column, original, key };
  }

  /** Opens the edit row for the cell of the cursor. */
  async begin(tab: QueryTab): Promise<void> {
    const p = await this.place(tab);
    if (!p) return;
    const meta = p.columns[p.column];
    const cell = p.original[p.column];
    const change = tab.edits().rows[p.key]?.cells[p.column] ?? null;
    if (cell !== null && typeof cell === 'object') return this.say(this.t.binary);
    let text = startText(cell, change);
    // the row holds long texts cut: the whole value is read to be edited
    if (!change && typeof cell === 'string' && cell.length >= 1000) {
      try {
        const part = await this.api.cellValue(p.resultId, p.row, p.column, 0, MAX_EDIT_BYTES);
        if (part.kind !== 'text' || part.to < part.total) return this.say(this.t.tooBig);
        text = part.text ?? '';
      } catch (e) {
        return this.say(describeError(e));
      }
    }
    const info = this.infoOf(tab)?.find((c) => c.name === meta.name);
    this.editing.set({
      tab,
      row: p.row,
      column: p.column,
      key: p.key,
      original: p.original,
      meta,
      info,
      text,
    });
  }

  /** What is wrong about a value for the cell in the edit row, in words; `null` if nothing is. */
  problemText(problem: ValueProblem, typeName: string): string {
    return problem === 'tooLong'
      ? this.t.problems.tooLong(maxLength(typeName) ?? 0)
      : this.t.problems[problem];
  }

  /** Takes the value of the edit row into the buffer; says what is wrong about it instead, if anything. */
  commit(value: NewValue): string | null {
    const e = this.editing();
    if (!e) return null;
    const problem = validate(value, e.meta, e.info);
    if (problem) return this.problemText(problem, e.meta.typeName);
    e.tab.edits.update((b) => setCell(b, e.key, e.row, e.original, e.column, value));
    this.cancel();
    return null;
  }

  /** Closes the edit row; the grid gets the keyboard back. */
  cancel(): void {
    const tab = this.editing()?.tab;
    this.editing.set(null);
    setTimeout(() => tab?.grid?.focusGrid());
  }

  /** Sets the cell of the cursor to NULL or to its default, without the edit row. */
  async setAtCursor(tab: QueryTab, value: NewValue): Promise<void> {
    const p = await this.place(tab);
    if (!p) return;
    const meta = p.columns[p.column];
    const problem = validate(
      value,
      meta,
      this.infoOf(tab)?.find((c) => c.name === meta.name),
    );
    if (problem) return this.say(this.problemText(problem, meta.typeName));
    tab.edits.update((b) => setCell(b, p.key, p.row, p.original, p.column, value));
  }

  undo(tab: QueryTab): void {
    tab.edits.update(undoEdit);
  }

  redo(tab: QueryTab): void {
    tab.edits.update(redoEdit);
  }

  /** Takes the change of the cell of the cursor back. */
  async resetCell(tab: QueryTab): Promise<void> {
    const p = await this.place(tab);
    if (p) tab.edits.update((b) => setCell(b, p.key, p.row, p.original, p.column, null));
  }

  /** Takes the changes of the row of the cursor back. */
  async resetRowAtCursor(tab: QueryTab): Promise<void> {
    const p = await this.place(tab);
    if (p) tab.edits.update((b) => resetRow(b, p.key));
  }

  /** Forgets all changes of a tab. */
  discard(tab: QueryTab): void {
    tab.edits.set(EMPTY_BUFFER);
    if (this.editing()?.tab === tab) this.editing.set(null);
    if (this.preview()?.tab === tab) this.preview.set(null);
  }

  /** The plan for what a tab has to write, if it can be written. */
  private planFor(tab: QueryTab) {
    const view = tab.tableView();
    const current = this.copier.current();
    if (!view || !current || tab !== this.tabs.active()) return null;
    if (editCount(tab.edits()).rows === 0) {
      this.say(this.t.nothing);
      return null;
    }
    const state = this.state(tab, current.result.columns);
    if ('reason' in state) {
      this.say(this.t.reasons[state.reason]);
      return null;
    }
    const built = planOf(
      tab.edits(),
      current.result.columns,
      state.pk,
      this.settings.settings().editLock,
      view.schema,
      view.table,
    );
    if (built.plan.rows.length > MAX_EDIT_ROWS) {
      this.say(this.t.tooMany(MAX_EDIT_ROWS));
      return null;
    }
    return { ...built, view };
  }

  /** Shows the statements that would be written. */
  async showPreview(tab: QueryTab): Promise<void> {
    const planned = this.planFor(tab);
    if (!planned) return;
    try {
      const statements = await this.api.editPreview(tab.connectionId(), planned.plan);
      this.preview.set({ tab, statements: statements.map((s) => s.display) });
    } catch (e) {
      this.say(describeError(e));
    }
  }

  /**
   * Writes the changes of a tab: all rows in one transaction, or none. `true` when they are written –
   * then the table is read again (triggers and defaults may have changed more than was typed).
   */
  async save(tab: QueryTab): Promise<boolean> {
    if (this.busy()) return false;
    const planned = this.planFor(tab);
    if (!planned) return false;
    const connection = tab.connectionId();
    this.busy.set(true);
    try {
      const statements = await this.api.editPreview(connection, planned.plan);
      const sqls = statements.map((s) => s.sql);
      // the guard of the connection: the backend decides; here the user is asked where it wants that
      let tokens: (string | null)[] = [];
      const verdicts = await this.api.check(connection, sqls, false);
      const guarded = needingConfirmation(
        statements.map((s) => s.display),
        verdicts,
      );
      if (guarded.length > 0) {
        const profile = this.connections.profiles().find((p) => p.id === connection);
        const answer = profile
          ? await this.guard.ask({
              connection: profile,
              statements: guarded.slice(0, GUARD_SHOWN),
              total: sqls.length,
            })
          : null;
        if (!answer) return false;
        tokens = await this.api.confirm(connection, sqls, answer.typedName, false);
      }
      const applied = await this.api.editApply(
        connection,
        tab.id,
        planned.plan,
        tokens,
        this.settings.settings().statementTimeoutSec * 1000,
      );
      if (applied.failed === null && !applied.error && applied.done === sqls.length) {
        this.discard(tab);
        this.say(this.t.written(applied.done));
        // read again what the database has now
        await tab.applyTable(planned.view.spec);
        return true;
      }
      const key = applied.failed !== null ? (planned.keys[applied.failed] ?? null) : null;
      const row = key !== null ? (tab.edits().rows[key]?.row ?? 0) + 1 : 0;
      tab.edits.update((b) => ({ ...b, failed: key }));
      if (applied.conflict) this.say(this.t.conflict(row));
      else if (applied.error && key !== null) {
        this.say(this.t.failed(row, describeError(toAppError(applied.error))));
      } else this.say(this.t.notWritten(describeError(toAppError(applied.error ?? {}))));
      if (key !== null) tab.grid?.goTo(row - 1, null);
      return false;
    } catch (e) {
      const error = toAppError(e);
      this.say(
        error.code === 'unsupported' ? this.t.txOpen : this.t.notWritten(describeError(error)),
      );
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
