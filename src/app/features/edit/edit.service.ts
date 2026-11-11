import { Injectable, inject, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SchemaApi } from '../../core/schema/schema-api';
import { ColumnInfo, TableInfo } from '../../core/schema/schema.models';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { Cell, EditKind, QueryColumn } from '../../core/sql/query.models';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { ConfirmService } from '../../shared/confirm';
import { resolveLayout } from '../results/column-layout';
import { ColumnLayouts } from '../results/column-layouts.service';
import { parseBlock } from './block-parser';
import { needingConfirmation } from '../guard/guard-logic';
import { GuardService } from '../guard/guard.service';
import { CopyService } from '../results/copy.service';
import { QueryTab } from '../tabs/query-tab';
import { TabsStore } from '../tabs/tabs.store';
import {
  EMPTY_BUFFER,
  EditBuffer,
  EditMarks,
  addRows,
  asOneStep,
  invalidCells,
  pasteBlock,
  removeNewRows,
  setNewCell,
  toggleDeleted,
  MAX_EDIT_ROWS,
  NewValue,
  ReadOnlyReason,
  ValueProblem,
  editCount,
  editability,
  marksOf,
  originOf,
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
/** Rows a row operation (duplicate, delete, fill) takes at once. */
export const MAX_CHOSEN_ROWS = 20_000;
/** A pasted block with more cells than this asks first. */
export const ASK_PASTE_FROM = 200;
/** Statements a question of the guard shows. */
const GUARD_SHOWN = 20;

/** The cell that is being edited. */
export interface Editing {
  readonly tab: QueryTab;
  readonly row: number;
  /** Index of the result column. */
  readonly column: number;
  readonly key: string;
  /** The id of the new row the cell is in; `null`: a row of the table. */
  readonly newId: number | null;
  /** Where the row is from (`originOf`): the value is only taken while the tab still shows that. */
  readonly origin: string;
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
  private readonly clipboard = inject(ClipboardApi);
  private readonly confirm = inject(ConfirmService);
  private readonly layouts = inject(ColumnLayouts);
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
    /** Rows to delete, to change and to insert. */
    readonly counts: Readonly<Record<EditKind, number>>;
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
  marks(tab: QueryTab, columns: readonly QueryColumn[] = []): EditMarks | null {
    return marksOf(tab.edits(), columns.length > 0 ? this.invalid(tab, columns) : undefined);
  }

  count(tab: QueryTab | null | undefined): ReturnType<typeof editCount> {
    return editCount(tab ? tab.edits() : EMPTY_BUFFER);
  }

  /** Where the rows a tab shows are from; `null` if it shows no table view. */
  private originNow(tab: QueryTab): string | null {
    const view = tab.tableView();
    const current = this.copier.current();
    if (!view || !current || tab !== this.tabs.active()) return null;
    return originOf(tab.connectionId(), view.schema, view.table, current.result.resultId);
  }

  /** Whether the changes of a tab were made in what it shows now (an empty buffer belongs anywhere). */
  private belongs(tab: QueryTab): boolean {
    const origin = tab.edits().origin;
    return origin === null || origin === this.originNow(tab);
  }

  /** Changes a cell of the buffer; the first change notes where the rows are from. */
  private change(tab: QueryTab, origin: string, f: (b: EditBuffer) => EditBuffer): void {
    // while the buffer is being written nothing gets into it – whatever was started before (rows that
    // were still being read): it would be dropped with the buffer, and reported as written
    if (this.busy()) {
      this.say(this.t.busy);
      return;
    }
    tab.edits.update((b) => {
      const next = f(b.origin === null ? { ...b, origin } : b);
      // a buffer that is empty again belongs nowhere
      return editCount(next).total === 0 && next.undo.length === 0 && next.redo.length === 0
        ? EMPTY_BUFFER
        : next;
    });
  }

  /** The result and the cell the user is at, if the tab is the one in front and can be edited. */
  private async place(tab: QueryTab) {
    const current = this.copier.current();
    if (!current || tab !== this.tabs.active()) return null;
    if (this.busy()) {
      this.say(this.t.busy);
      return null;
    }
    if (!this.belongs(tab)) {
      this.say(this.t.stale);
      return null;
    }
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
    const origin = this.originNow(tab);
    if (origin === null) return null;
    const base = { resultId: current.result.resultId, columns, row, column, origin, pk: state.pk };
    if (row >= current.rows) {
      // a new row of the buffer: it has no cells of the table and no key yet
      const fresh = tab.edits().inserts[row - current.rows];
      if (!fresh) return null;
      return { ...base, original: [] as readonly Cell[], key: `new:${fresh.id}`, newId: fresh.id };
    }
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
    return { ...base, original, key, newId: null as number | null };
  }

  /** Sets (or takes back, with `null`) a cell at a place: of a row of the table, or of a new row. */
  private put(
    tab: QueryTab,
    p: {
      origin: string;
      newId: number | null;
      key: string;
      row: number;
      column: number;
      original: readonly Cell[];
    },
    value: NewValue | null,
  ): void {
    this.change(tab, p.origin, (b) =>
      p.newId !== null
        ? setNewCell(b, p.newId, p.column, value)
        : setCell(b, p.key, p.row, p.original, p.column, value),
    );
  }

  /** Opens the edit row for the cell of the cursor. */
  async begin(tab: QueryTab): Promise<void> {
    const p = await this.place(tab);
    if (!p) return;
    const meta = p.columns[p.column];
    const cell = p.original[p.column];
    const change =
      p.newId !== null
        ? (tab.edits().inserts.find((r) => r.id === p.newId)?.cells[p.column] ?? null)
        : (tab.edits().rows[p.key]?.cells[p.column] ?? null);
    if (tab.edits().deletes[p.key]) return this.say(this.t.rowDeleted);
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
      newId: p.newId,
      origin: p.origin,
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
    if (this.busy()) return this.t.busy;
    // the rows were read anew (or the tab shows something else) since the field was opened: its row and
    // column are not those of what is on screen any more
    if (e.origin !== this.originNow(e.tab) || !this.belongs(e.tab)) return this.t.staleCell;
    const problem = validate(value, e.meta, e.info);
    if (problem) return this.problemText(problem, e.meta.typeName);
    // the new row the field was opened for is gone (undone, removed): its value has no place
    if (e.newId !== null && !e.tab.edits().inserts.some((r) => r.id === e.newId)) {
      return this.t.staleCell;
    }
    this.put(e.tab, e, value);
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
    this.put(tab, p, value);
  }

  undo(tab: QueryTab): void {
    if (!this.busy()) tab.edits.update(undoEdit);
  }

  redo(tab: QueryTab): void {
    if (!this.busy()) tab.edits.update(redoEdit);
  }

  /** Takes the change of the cell of the cursor back. */
  async resetCell(tab: QueryTab): Promise<void> {
    const p = await this.place(tab);
    if (p) this.put(tab, p, null);
  }

  /** Takes the changes of the row of the cursor back. */
  async resetRowAtCursor(tab: QueryTab): Promise<void> {
    const p = await this.place(tab);
    if (!p) return;
    this.change(tab, p.origin, (b) =>
      p.newId !== null ? removeNewRows(b, [p.newId]) : resetRow(b, p.key),
    );
  }

  // --- whole rows (prompt 032) ----------------------------------------------------------------------

  /** What row operations need: an editable table in front, and where its rows are from. */
  private rowsPlace(tab: QueryTab) {
    const current = this.copier.current();
    if (!current || tab !== this.tabs.active()) return null;
    if (this.busy()) {
      this.say(this.t.busy);
      return null;
    }
    if (!this.belongs(tab)) {
      this.say(this.t.stale);
      return null;
    }
    const state = this.state(tab, current.result.columns);
    if ('reason' in state) {
      this.say(this.t.reasons[state.reason]);
      return null;
    }
    const origin = this.originNow(tab);
    if (origin === null) return null;
    return {
      origin,
      pk: state.pk,
      columns: current.result.columns,
      resultId: current.result.resultId,
      rows: current.rows,
    };
  }

  /**
   * The rows the user means: the marked ones, else the row of the cursor – rows of the table with their
   * cells, and new rows of the buffer. `null` when there is none, or too many.
   */
  private async chosenRows(tab: QueryTab, place: { resultId: number; rows: number }) {
    const cursor = tab.grid?.cursor() ?? null;
    const marked = this.copier.selection();
    const ranges: readonly (readonly [number, number])[] =
      marked.rows.length > 0 ? marked.rows : cursor ? [[cursor[0], cursor[0]]] : [];
    if (ranges.length === 0) {
      this.say(this.t.noCell);
      return null;
    }
    const total = place.rows + tab.edits().inserts.length;
    const table: { row: number; original: readonly Cell[] }[] = [];
    const fresh: number[] = [];
    const seen = new Set<number>();
    for (const [a, b] of ranges) {
      const last = Math.min(b, total - 1);
      if (last - a + 1 + seen.size > MAX_CHOSEN_ROWS) {
        this.say(this.t.tooManyRows(MAX_CHOSEN_ROWS));
        return null;
      }
      const lastOfTable = Math.min(last, place.rows - 1);
      for (let from = a; from <= lastOfTable; from += 1000) {
        const cells = await tab.window(
          place.resultId,
          from,
          Math.min(1000, lastOfTable - from + 1),
        );
        cells.forEach((original, i) => {
          if (seen.has(from + i)) return;
          seen.add(from + i);
          table.push({ row: from + i, original });
        });
      }
      for (let row = Math.max(a, place.rows); row <= last; row++) {
        if (seen.has(row)) continue;
        seen.add(row);
        fresh.push(row - place.rows);
      }
    }
    return { table, fresh, columns: marked.rows.length > 0 ? marked.columns : [] };
  }

  /** Adds an empty row below the table and puts the cursor into it. */
  addRow(tab: QueryTab): void {
    const p = this.rowsPlace(tab);
    if (!p) return;
    this.change(tab, p.origin, (b) => addRows(b, [{}]).buffer);
    const row = p.rows + tab.edits().inserts.length - 1;
    setTimeout(() => {
      tab.grid?.goTo(row, null);
      tab.grid?.focusGrid();
    }, 50);
  }

  /** Adds copies of the chosen rows as new rows – without the key, which the database gives. */
  async duplicateRows(tab: QueryTab): Promise<void> {
    const p = this.rowsPlace(tab);
    if (!p) return;
    try {
      const chosen = await this.chosenRows(tab, p);
      if (!chosen || this.originNow(tab) !== p.origin) return;
      const inserts = tab.edits().inserts;
      const copies: Record<number, NewValue>[] = [
        ...chosen.table.map(({ original }) => {
          const cells: Record<number, NewValue> = {};
          original.forEach((cell, c) => {
            if (p.pk.includes(c)) return;
            // binary data and texts the row holds cut cannot be copied from here: left to the database
            if (cell !== null && typeof cell === 'object') return;
            if (typeof cell === 'string' && cell.length >= 1000) return;
            cells[c] = cell === null ? { kind: 'null' } : { kind: 'value', text: String(cell) };
          });
          // the row as it is shown: with its changes that are not written yet
          const key = rowKey(original, p.pk);
          const changed = key !== null ? tab.edits().rows[key]?.cells : undefined;
          for (const [c, value] of Object.entries(changed ?? {})) {
            if (p.pk.includes(Number(c))) continue;
            if (value.kind === 'default') delete cells[Number(c)];
            else cells[Number(c)] = value;
          }
          return cells;
        }),
        ...chosen.fresh.map((n) => ({ ...(inserts[n]?.cells ?? {}) })),
      ];
      if (copies.length === 0) return;
      this.change(tab, p.origin, (b) => addRows(b, copies).buffer);
      this.say(this.t.duplicated(copies.length));
      const row = p.rows + tab.edits().inserts.length - copies.length;
      setTimeout(() => tab.grid?.goTo(row, null), 50);
    } catch (e) {
      this.say(describeError(e));
    }
  }

  /**
   * Marks the chosen rows to be deleted (or takes the mark away when all of them have it); new rows of
   * the buffer just go.
   */
  async deleteRows(tab: QueryTab): Promise<void> {
    const p = this.rowsPlace(tab);
    if (!p) return;
    try {
      const chosen = await this.chosenRows(tab, p);
      if (!chosen || this.originNow(tab) !== p.origin) return;
      const ids = chosen.fresh
        .map((n) => tab.edits().inserts[n]?.id)
        .filter((id): id is number => id !== undefined);
      const rows = chosen.table.flatMap((r) => {
        const key = rowKey(r.original, p.pk);
        return key === null ? [] : [{ ...r, key }];
      });
      this.change(tab, p.origin, (b) =>
        asOneStep(b, (start) => toggleDeleted(removeNewRows(start, ids), rows)),
      );
      if (rows.length < chosen.table.length) this.say(this.t.noRowKey);
    } catch (e) {
      this.say(describeError(e));
    }
  }

  /**
   * Pastes the block of cells on the clipboard from the cell of the cursor: over the rows below it, and
   * on into new rows. A big block asks first.
   */
  async paste(tab: QueryTab, text?: string): Promise<void> {
    const p = this.rowsPlace(tab);
    if (!p) return;
    const cursor = tab.grid?.cursor() ?? null;
    if (!cursor) return this.say(this.t.noCell);
    try {
      // pasted into the grid: the text came with the event; from the menu the backend reads it
      const block = parseBlock(text ?? (await this.clipboard.readText()));
      if (block.rows.length === 0) return this.say(this.t.nothingToPaste);
      // the columns as the grid shows them, from the cursor to the right
      const shown = resolveLayout(this.layouts.of(tab), p.columns).shown;
      const at = shown.indexOf(cursor[1]);
      const columns = at < 0 ? [cursor[1]] : shown.slice(at);
      const width = Math.min(columns.length, Math.max(...block.rows.map((r) => r.length)));
      const onTable = Math.max(0, Math.min(block.rows.length, p.rows - cursor[0]));
      const have = tab.edits().inserts.length;
      const firstNew = cursor[0] >= p.rows ? cursor[0] - p.rows : 0;
      const added = Math.max(0, block.rows.length - onTable - (have - firstNew));
      if (block.rows.length * width > ASK_PASTE_FROM) {
        const yes = await this.confirm.ask({
          title: this.t.pasteTitle,
          message: this.t.pasteQuestion(block.rows.length, width, onTable, added),
          confirm: this.t.pasteYes,
        });
        if (!yes) return;
      }
      const existing: { key: string | null; row: number; original: readonly Cell[] }[] = [];
      for (let from = cursor[0]; from < cursor[0] + onTable; from += 1000) {
        const count = Math.min(1000, cursor[0] + onTable - from);
        const cells = await tab.window(p.resultId, from, count);
        cells.forEach((original, i) =>
          existing.push({ key: rowKey(original, p.pk), row: from + i, original }),
        );
      }
      // the tab may have moved on while the rows were read: only if it still shows what it showed
      if (this.originNow(tab) !== p.origin || this.busy()) return;
      let result = { cells: 0, added: 0, skipped: 0 };
      this.change(tab, p.origin, (b) => {
        const pasted = pasteBlock(b, block.rows, { existing, firstNew, columns }, p.columns);
        result = pasted;
        return pasted.buffer;
      });
      const invalid = this.invalid(tab, p.columns).size;
      this.say(this.t.pasted(result.cells, result.added, invalid, result.skipped, block.cut));
    } catch (e) {
      this.say(describeError(e));
    }
  }

  /**
   * Sets the marked cells – of rows of the table and of new rows – column by column. `fill`: every
   * column gets the value of its top cell in the rows below it; else `valueOf` says the value.
   */
  private async setChosen(
    tab: QueryTab,
    valueOf: (top: NewValue | null) => NewValue | null,
    fill: boolean,
  ): Promise<boolean> {
    const p = this.rowsPlace(tab);
    if (!p) return false;
    const chosen = await this.chosenRows(tab, p);
    if (!chosen || this.originNow(tab) !== p.origin) return false;
    const cursor = tab.grid?.cursor() ?? null;
    const columns = chosen.columns.length > 0 ? chosen.columns : cursor ? [cursor[1]] : [];
    if (columns.length === 0) return false;
    const buffer = tab.edits();
    const rows = [
      ...chosen.table.map((r) => ({
        ...r,
        key: rowKey(r.original, p.pk),
        newId: null as number | null,
      })),
      ...chosen.fresh.map((n) => ({
        row: p.rows + n,
        original: [] as readonly Cell[],
        key: null as string | null,
        newId: buffer.inserts[n]?.id ?? null,
      })),
    ].sort((a, b) => a.row - b.row);
    if (rows.length < (fill ? 2 : 1)) return false;
    // what the top cell of a column holds now: its change in the buffer, else what was read
    const top = (column: number): NewValue | null => {
      const first = rows[0];
      if (first.newId !== null) {
        return (
          buffer.inserts.find((r) => r.id === first.newId)?.cells[column] ?? { kind: 'default' }
        );
      }
      const change = first.key ? buffer.rows[first.key]?.cells[column] : undefined;
      if (change) return change;
      const cell = first.original[column];
      if (cell === null) return { kind: 'null' };
      if (cell === undefined || typeof cell === 'object') return null;
      if (typeof cell === 'string' && cell.length >= 1000) return null;
      return { kind: 'value', text: String(cell) };
    };
    this.change(tab, p.origin, (b) =>
      asOneStep(b, (start) => {
        let next = start;
        for (const column of columns) {
          const value = valueOf(fill ? top(column) : null);
          if (value === null) continue;
          for (const row of fill ? rows.slice(1) : rows) {
            if (row.newId !== null) next = setNewCell(next, row.newId, column, value);
            else if (row.key !== null && !next.deletes[row.key]) {
              next = setCell(next, row.key, row.row, row.original, column, value);
            }
          }
        }
        return next;
      }),
    );
    return true;
  }

  /** Fills the marked cells of every column with the value of its top cell. */
  async fillDown(tab: QueryTab): Promise<void> {
    try {
      if (!(await this.setChosen(tab, (top) => top, true))) this.say(this.t.nothingToFill);
    } catch (e) {
      this.say(describeError(e));
    }
  }

  /** Sets the marked cells – or the cell of the cursor – to NULL or to the default. */
  async setCells(tab: QueryTab, value: NewValue): Promise<void> {
    const marked = this.copier.selection();
    const many =
      marked.rows.length > 0 &&
      (marked.rows.length > 1 ||
        marked.rows[0][0] !== marked.rows[0][1] ||
        marked.columns.length > 1);
    if (!many) return this.setAtCursor(tab, value);
    try {
      await this.setChosen(tab, () => value, false);
    } catch (e) {
      this.say(describeError(e));
    }
  }

  /** The buffered values of a tab that their columns cannot take (reads signals). */
  invalid(tab: QueryTab, columns: readonly QueryColumn[]): ReadonlyMap<string, ValueProblem> {
    const info = this.infoOf(tab);
    return invalidCells(
      tab.edits(),
      columns,
      columns.map((c) => info?.find((i) => i.name === c.name)),
    );
  }

  /** Forgets all changes of a tab – after a question, when the user asks for it (they cannot be undone). */
  async discardAsked(tab: QueryTab): Promise<void> {
    if (this.busy()) return this.say(this.t.busy);
    if (await this.tabs.dropEdits([tab])) this.discard(tab);
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
    if (editCount(tab.edits()).total === 0) {
      this.say(this.t.nothing);
      return null;
    }
    // changes are written where they were made, nowhere else
    if (!this.belongs(tab)) {
      this.say(this.t.stale);
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
      this.connections.profiles().find((p) => p.id === tab.connectionId())?.kind ?? 'sqlite',
    );
    const rows =
      built.plan.rows.length +
      (built.plan.deletes?.length ?? 0) +
      (built.plan.inserts?.length ?? 0);
    if (rows > MAX_EDIT_ROWS) {
      this.say(this.t.tooMany(MAX_EDIT_ROWS));
      return null;
    }
    // a value its column cannot take is marked in the grid: it is put right before anything is written
    const invalid = this.invalid(tab, current.result.columns);
    if (invalid.size > 0) {
      this.say(this.t.invalidCells(invalid.size));
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
      this.preview.set({
        tab,
        statements: statements.map((s) => s.display),
        counts: {
          delete: planned.plan.deletes?.length ?? 0,
          update: planned.plan.rows.length,
          insert: planned.plan.inserts?.length ?? 0,
        },
      });
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
    const current = this.copier.current();
    if (!planned || !current) return false;
    const connection = tab.connectionId();
    this.busy.set(true);
    try {
      // rows that go do not come back: said once more before they are written
      const deleting = planned.plan.deletes?.length ?? 0;
      if (deleting > 0) {
        const yes = await this.confirm.ask({
          title: this.t.deleteTitle,
          message: this.t.deleteQuestion(deleting, planned.view.table),
          confirm: this.t.deleteYes,
        });
        if (!yes) return false;
      }
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
      if (applied.blocked) {
        this.say(this.t.txOpen);
        return false;
      }
      if (applied.unknown) {
        this.say(this.t.unknownOutcome);
        return false;
      }
      if (applied.failed === null && !applied.error && applied.done === sqls.length) {
        this.discard(tab);
        // what was sent, not what the buffer holds: a row changed and deleted counts as deleted
        this.say(
          this.t.writtenAll(
            planned.plan.deletes?.length ?? 0,
            planned.plan.rows.length,
            planned.plan.inserts?.length ?? 0,
            applied.inserted.slice(0, 20),
          ),
        );
        // read again what the database has now
        await tab.applyTable(planned.view.spec);
        return true;
      }
      // which row was it? Its place among the rows of its kind in the plan
      const at = applied.failed;
      const buffer = tab.edits();
      let mark: string | null = null;
      let row = -1;
      let what = '';
      if (at !== null && applied.failedKind === 'insert') {
        const id = planned.insertIds[at];
        const n = buffer.inserts.findIndex((r) => r.id === id);
        if (n >= 0) {
          mark = `new:${id}`;
          row = current.rows + n;
          // a statement for several new rows failed and the row could not be told: all of them
          what =
            applied.failedSpan > 1
              ? this.t.newRowsSpan(n + 1, n + applied.failedSpan)
              : this.t.newRowN(n + 1);
        }
      } else if (at !== null) {
        const key = (applied.failedKind === 'delete' ? planned.deleteKeys : planned.keys)[at];
        const place = key ? (buffer.deletes[key] ?? buffer.rows[key]) : undefined;
        if (key && place) {
          mark = key;
          row = place.row;
          what = this.t.rowN(row + 1);
        }
      }
      tab.edits.update((b) => ({ ...b, failed: mark }));
      if (applied.conflict) {
        // only a changed row can have been „changed by someone else“; a delete or an insert that did
        // not do its one row may as well have been turned away by a trigger or a rule
        this.say(
          mark === null
            ? this.t.conflictSome
            : applied.failedKind === 'update' || applied.failedKind === null
              ? this.t.conflict(what)
              : this.t.notOneRow(what),
        );
      } else if (applied.error && mark !== null) {
        this.say(this.t.failed(what, describeError(toAppError(applied.error))));
      } else this.say(this.t.notWritten(describeError(toAppError(applied.error ?? {}))));
      if (row >= 0) tab.grid?.goTo(row, null);
      return false;
    } catch (e) {
      const error = toAppError(e);
      this.say(this.t.notWritten(describeError(error)));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
