import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEMO_PROFILE,
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { ConfirmService } from '../../shared/confirm';
import { EMPTY_SPEC } from '../filter/filter-logic';
import { GuardService } from '../guard/guard.service';
import { CopyService } from '../results/copy.service';
import { QueryTab } from '../tabs/query-tab';
import { TabsStore } from '../tabs/tabs.store';
import { EditService } from './edit.service';

describe('EditService', () => {
  let query: FakeQueryApi;
  let schema: FakeSchemaApi;
  let tabs: TabsStore;
  let edit: EditService;
  let copier: CopyService;
  let cursor: [number, number];
  /** Counts the tests: what an earlier one scheduled must not move the cursor of this one. */
  let live = 0;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    query = new FakeQueryApi();
    schema = new FakeSchemaApi();
    const connections = new FakeConnectionsApi();
    connections.profiles = [DEMO_PROFILE, { ...DEMO_PROFILE, id: 'other', name: 'Other' }];
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: connections },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: schema },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: ClipboardApi, useValue: new FakeClipboardApi() },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    tabs = TestBed.inject(TabsStore);
    await tabs.load();
    edit = TestBed.inject(EditService);
    copier = TestBed.inject(CopyService);
    cursor = [0, 2];
    live++;
  });

  const settle = () => new Promise((r) => setTimeout(r, 0));

  /** Opens the table of the fake catalog (id pk, customer_id, note) as a table view with a cursor. */
  async function table(): Promise<QueryTab> {
    const tab = tabs.active()!;
    query.columns = [
      { name: 'id', kind: 'int', typeName: 'integer' },
      { name: 'customer_id', kind: 'int', typeName: 'integer' },
      { name: 'note', kind: 'text', typeName: 'text' },
    ];
    query.rows = [
      [1, 42, 'first'],
      [2, 42, null],
      [3, 7, 'third'],
    ];
    await tab.openTable({ schema: 'public', table: 'orders', spec: EMPTY_SPEC });
    const mine = live;
    tab.grid = {
      cursor: () => cursor,
      // a jump that a test before this one left behind (they come a moment later) is not ours
      goTo: (row) => {
        if (mine === live) cursor = [row, cursor[1]];
      },
      fitWidths: () => undefined,
      focusGrid: () => undefined,
    };
    edit.ensure(tab);
    await settle();
    return tab;
  }

  const columns = () => copier.current()!.result.columns;

  /** Writes, and says yes to the question that comes when rows are to be deleted. */
  async function saveYes(tab: QueryTab): Promise<boolean> {
    const saving = edit.save(tab);
    await settle();
    const confirm = TestBed.inject(ConfirmService);
    if (confirm.request()) confirm.answer(true);
    return saving;
  }

  it('edits where the table has a key in the result, and says why not elsewhere', async () => {
    const tab = await table();
    expect(edit.state(tab, columns())).toEqual({ pk: [0] });
    expect(edit.state(tab, columns().slice(1))).toEqual({ reason: 'keyMissing' });
    await tab.setLocal({ text: 'x', column: null, sort: [] });
    expect(edit.state(tab, columns())).toEqual({ reason: 'local' });
    tab.dropLocal();
    tab.tableView.set(null);
    expect(edit.state(tab, columns())).toEqual({ reason: 'noTable' });
    await edit.begin(tab);
    expect(edit.editing()).toBeNull();
    expect(tabs.notice()).toContain('Daten öffnen');
  });

  it('opens the cell of the cursor, checks the value and collects the change', async () => {
    const tab = await table();
    await edit.begin(tab);
    expect(edit.editing()).toMatchObject({ row: 0, column: 2, text: 'first', key: '["1"]' });
    expect(edit.commit({ kind: 'value', text: 'changed' })).toBeNull();
    expect(edit.editing()).toBeNull();
    expect(edit.count(tab)).toMatchObject({ cells: 1, rows: 1 });
    expect(edit.marks(tab)!.at(0, 2)).toEqual({ kind: 'value', text: 'changed' });
    // a number column takes no text; the cell stays in the edit row
    cursor = [1, 1];
    await edit.begin(tab);
    expect(edit.commit({ kind: 'value', text: 'many' })).toBe('Keine ganze Zahl.');
    expect(edit.editing()).not.toBeNull();
    // the key column of the fake catalog takes no NULL
    edit.cancel();
    cursor = [1, 0];
    await edit.setAtCursor(tab, { kind: 'null' });
    expect(tabs.notice()).toBe('Die Spalte nimmt kein NULL.');
    expect(edit.count(tab).cells).toBe(1);
    // editing a changed cell starts with the change; undo and redo
    cursor = [0, 2];
    await edit.begin(tab);
    expect(edit.editing()?.text).toBe('changed');
    edit.cancel();
    edit.undo(tab);
    expect(edit.count(tab).cells).toBe(0);
    edit.redo(tab);
    expect(edit.count(tab).cells).toBe(1);
  });

  it('writes all changes together, bound by the backend, and reads the table again', async () => {
    const tab = await table();
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: "it's" });
    cursor = [1, 2];
    await edit.setAtCursor(tab, { kind: 'default' });
    cursor = [2, 1];
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: '8' });
    const runs = query.statements.length;
    expect(await edit.save(tab)).toBe(true);
    const sent = query.applied.at(-1)!;
    expect(sent.session).toBe(tab.id);
    expect(sent.plan).toMatchObject({ schema: 'public', table: 'orders' });
    expect(sent.plan.rows.map((r) => [r.key[0].value, r.set[0].column, r.set[0].value])).toEqual([
      ['1', 'note', "it's"],
      ['2', 'note', null],
      ['3', 'customer_id', '8'],
    ]);
    // the lock: what the cells held when they were read
    expect(sent.plan.rows[0].expect).toEqual([
      { column: 'note', kind: 'text', typeName: 'text', value: 'first' },
    ]);
    expect(sent.plan.rows[1].set[0].default).toBe(true);
    expect(edit.count(tab).cells).toBe(0);
    expect(tabs.notice()).toBe('3 geändert – geschrieben.');
    // read again: one more statement ran, and nobody was asked about discarding
    expect(query.statements.length).toBe(runs + 1);
    expect(TestBed.inject(ConfirmService).request()).toBeNull();
    // without the lock no old values are sent
    TestBed.inject(SettingsService).update({ editLock: false });
    cursor = [0, 2];
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'again' });
    await edit.save(tab);
    expect(query.applied.at(-1)!.plan.rows[0].expect).toEqual([]);
  });

  it('keeps the changes when a row was changed by someone else, and marks the row', async () => {
    const tab = await table();
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'mine' });
    cursor = [2, 2];
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'mine too' });
    query.applyAnswer = { done: 0, failed: 1, conflict: true };
    const runs = query.statements.length;
    expect(await edit.save(tab)).toBe(false);
    expect(tabs.notice()).toContain('Zeile 3 wurde inzwischen');
    expect(edit.count(tab)).toMatchObject({ cells: 2, rows: 2 });
    expect(edit.marks(tab)!.failed(2)).toBe(true);
    expect(edit.marks(tab)!.failed(0)).toBe(false);
    expect(query.statements.length).toBe(runs);
    // a row the answer names that is none of the plan: said without a row number
    query.applyAnswer = { done: 0, failed: 9, conflict: true };
    await edit.save(tab);
    expect(tabs.notice()).toBe(
      'Eine Zeile wurde inzwischen von jemand anderem geändert (oder ist weg). Nichts wurde geschrieben.',
    );
    // an error of the database is said with its row
    query.applyAnswer = {
      done: 0,
      failed: 0,
      error: { code: 'invalid_query', message: 'check failed' },
    };
    await edit.save(tab);
    expect(tabs.notice()).toContain('Zeile 1');
    expect(tabs.notice()).toContain('check failed');
    expect(edit.count(tab).cells).toBe(2);
  });

  it('asks where the connection guards writing, and writes with the confirmations', async () => {
    const tab = await table();
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'x' });
    // the connection asks before it writes; reading goes on as ever
    query.verdict = (sql) =>
      sql.startsWith('UPDATE')
        ? { class: 'write', need: 'confirm' }
        : { class: 'read', need: 'nothing' };
    const guard = TestBed.inject(GuardService);
    const saving = edit.save(tab);
    await settle();
    // the question shows the statement readable, with its value
    expect(guard.request()?.statements[0].sql).toContain("note = 'x'");
    guard.answer(null);
    expect(await saving).toBe(false);
    expect(query.applied).toHaveLength(0);
    expect(edit.count(tab).cells).toBe(1);
    const again = edit.save(tab);
    await settle();
    guard.answer({ typedName: null });
    expect(await again).toBe(true);
    expect(query.applied.at(-1)!.confirmations).toHaveLength(1);
    expect(query.applied.at(-1)!.confirmations[0]).toContain('token');
  });

  // --- whole rows (prompt 032) ----------------------------------------------------------------------

  it('adds a row, fills its cells, duplicates and deletes rows – all in the buffer', async () => {
    const tab = await table();
    edit.addRow(tab);
    expect(edit.count(tab)).toMatchObject({ inserts: 1, total: 1 });
    // the new row stands below the three rows of the table
    cursor = [3, 2];
    await edit.begin(tab);
    expect(edit.editing()).toMatchObject({ newId: 1, text: '' });
    edit.commit({ kind: 'value', text: 'brand new' });
    expect(edit.marks(tab)!.newAt(0, 2)).toEqual({ kind: 'value', text: 'brand new' });
    // duplicating a row of the table: its cells without the key
    cursor = [0, 1];
    await edit.duplicateRows(tab);
    const copy = tab.edits().inserts[1];
    expect(copy.cells).toEqual({
      1: { kind: 'value', text: '42' },
      2: { kind: 'value', text: 'first' },
    });
    expect(tabs.notice()).toBe('1 Zeile als neue Zeile dupliziert.');
    // deleting: a row of the table is marked, a new row just goes
    cursor = [1, 0];
    await edit.deleteRows(tab);
    expect(edit.marks(tab)!.deleted(1)).toBe(true);
    await edit.begin(tab);
    expect(edit.editing()).toBeNull();
    expect(tabs.notice()).toContain('zum Löschen vorgemerkt');
    cursor = [4, 0];
    await edit.deleteRows(tab);
    expect(edit.count(tab)).toMatchObject({ inserts: 1, deletes: 1 });
    // the same row again: the mark goes
    cursor = [1, 0];
    await edit.deleteRows(tab);
    expect(edit.count(tab).deletes).toBe(0);
    edit.undo(tab);
    expect(edit.count(tab).deletes).toBe(1);
  });

  it('pastes a block from the cursor over rows and on into new ones, asking for a big one', async () => {
    const tab = await table();
    cursor = [2, 1];
    await edit.paste(tab, '8\tlast row\n9\tnew one\nten\tbad number\n');
    expect(edit.count(tab)).toMatchObject({ cells: 2, rows: 1, inserts: 2 });
    expect(edit.marks(tab)!.at(2, 2)).toEqual({ kind: 'value', text: 'last row' });
    expect(tabs.notice()).toContain(
      '6 Zellen eingefügt; 2 neue Zeilen; 1 Zellen halten einen Wert',
    );
    // the value a number column cannot take is marked, and writing waits for it
    expect(edit.marks(tab, columns())!.newInvalid(1, 1)).toBe(true);
    expect(await edit.save(tab)).toBe(false);
    expect(tabs.notice()).toContain('Erst richtigstellen');
    expect(query.applied).toHaveLength(0);
    // one undo takes the block back
    edit.undo(tab);
    expect(edit.count(tab).total).toBe(0);
    // a big block asks first; a no changes nothing
    const big = Array.from({ length: 150 }, (_, i) => `${i}\tx`).join('\n');
    const confirm = TestBed.inject(ConfirmService);
    const pasting = edit.paste(tab, big);
    await settle();
    expect(confirm.request()?.title).toBe('Block einfügen?');
    expect(confirm.request()?.message).toContain('150 Zeilen mit je 2 Zellen: 1 vorhandene Zeile');
    confirm.answer(false);
    await pasting;
    expect(edit.count(tab).total).toBe(0);
  });

  it('fills the marked cells down and sets marked cells to NULL', async () => {
    const tab = await table();
    copier.register(copier.current()!.result.resultId, () => ({ rows: [[0, 2]], columns: [2] }));
    cursor = [0, 2];
    await edit.fillDown(tab);
    expect(edit.marks(tab)!.at(1, 2)).toEqual({ kind: 'value', text: 'first' });
    expect(edit.marks(tab)!.at(2, 2)).toEqual({ kind: 'value', text: 'first' });
    expect(edit.marks(tab)!.at(0, 2)).toBeNull();
    edit.undo(tab);
    expect(edit.count(tab).total).toBe(0);
    await edit.setCells(tab, { kind: 'null' });
    // row 2 holds NULL already: two cells change
    expect(edit.count(tab)).toMatchObject({ cells: 2, rows: 2 });
  });

  it('writes deleted, changed and new rows as one plan and says which row failed', async () => {
    const tab = await table();
    cursor = [0, 2];
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'changed' });
    cursor = [1, 0];
    await edit.deleteRows(tab);
    edit.addRow(tab);
    cursor = [3, 2];
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'new' });
    await edit.showPreview(tab);
    expect(edit.preview()?.counts).toEqual({ delete: 1, update: 1, insert: 1 });
    expect(edit.preview()?.statements.map((s) => s.split(' ')[0])).toEqual([
      'DELETE',
      'UPDATE',
      'INSERT',
    ]);
    edit.preview.set(null);
    // the new row breaks a rule: nothing is written, and it is the one marked
    query.applyAnswer = {
      done: 0,
      failed: 0,
      failedKind: 'insert',
      error: { code: 'invalid_query', message: 'null value in column "customer_id"' },
    };
    expect(await saveYes(tab)).toBe(false);
    expect(tabs.notice()).toContain('Neue Zeile 1');
    expect(edit.marks(tab)!.newFailed(0)).toBe(true);
    expect(cursor[0]).toBe(3);
    // the row to delete is held by others
    query.applyAnswer = {
      done: 0,
      failed: 0,
      failedKind: 'delete',
      error: { code: 'invalid_query', message: 'still referenced from table "lines"' },
    };
    await saveYes(tab);
    expect(tabs.notice()).toContain('Zeile 2');
    expect(tabs.notice()).toContain('lines');
    expect(edit.marks(tab)!.failed(1)).toBe(true);
    // written: the keys the database gave are said
    query.applyAnswer = { inserted: ['17'] };
    expect(await saveYes(tab)).toBe(true);
    const plan = query.applied.at(-1)!.plan;
    expect([plan.deletes?.length, plan.rows.length, plan.inserts?.length]).toEqual([1, 1, 1]);
    expect(plan.returning).toBe('id');
    expect(tabs.notice()).toBe(
      '1 gelöscht, 1 geändert, 1 eingefügt – geschrieben. Neue Schlüssel: 17.',
    );
    expect(edit.count(tab).total).toBe(0);
  });

  // --- review 032 -----------------------------------------------------------------------------------

  it('duplicates a row as it is shown, with its changes that are not written', async () => {
    const tab = await table();
    cursor = [0, 2];
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'changed' });
    await edit.duplicateRows(tab);
    expect(tab.edits().inserts[0].cells[2]).toEqual({ kind: 'value', text: 'changed' });
  });

  it('asks before rows are deleted, and says how many rows of each kind were really written', async () => {
    const tab = await table();
    cursor = [0, 2];
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'changed' });
    // the same row is also deleted: it counts as deleted, not as changed
    await edit.deleteRows(tab);
    cursor = [1, 0];
    await edit.deleteRows(tab);
    const confirm = TestBed.inject(ConfirmService);
    const saving = edit.save(tab);
    await settle();
    expect(confirm.request()?.message).toContain('2 Zeilen');
    confirm.answer(false);
    expect(await saving).toBe(false);
    expect(query.applied).toHaveLength(0);
    const again = edit.save(tab);
    await settle();
    confirm.answer(true);
    expect(await again).toBe(true);
    expect(tabs.notice()).toBe('2 gelöscht – geschrieben.');
  });

  it('takes no row operation into the buffer while it writes', async () => {
    const tab = await table();
    cursor = [0, 2];
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'one' });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    // the rows of a row operation are still being read when the writing starts
    const window = query.window.bind(query);
    let held = false;
    query.window = async (id: number, from: number, count: number) => {
      if (!held) {
        held = true;
        await gate;
      }
      return window(id, from, count);
    };
    cursor = [1, 0];
    const deleting = edit.deleteRows(tab);
    await settle();
    const apply = query.editApply.bind(query);
    let release!: () => void;
    const applying = new Promise<void>((r) => (release = r));
    query.editApply = async (...args: Parameters<typeof apply>) => {
      await applying;
      return apply(...args);
    };
    const saving = edit.save(tab);
    await settle();
    expect(edit.busy()).toBe(true);
    open();
    await deleting;
    // the mark did not get into the buffer that is being written
    expect(edit.count(tab).deletes).toBe(0);
    release();
    expect(await saving).toBe(true);
    expect(tabs.notice()).toBe('1 geändert – geschrieben.');
  });

  it('says which rows a shared insert failed for when no single row can be named', async () => {
    const tab = await table();
    edit.addRow(tab);
    edit.addRow(tab);
    query.applyAnswer = {
      done: 0,
      failed: 0,
      failedKind: 'insert',
      failedSpan: 2,
      error: { code: 'invalid_query', message: 'deadlock' },
    };
    expect(await edit.save(tab)).toBe(false);
    expect(tabs.notice()).toContain('Neue Zeilen 1–2');
    // a row that could not be deleted is not blamed on somebody else changing it
    edit.discard(tab);
    cursor = [1, 0];
    await edit.deleteRows(tab);
    query.applyAnswer = { done: 0, failed: 0, failedKind: 'delete', conflict: true };
    const confirm = TestBed.inject(ConfirmService);
    const saving = edit.save(tab);
    await settle();
    confirm.answer(true);
    await saving;
    expect(tabs.notice()).toContain('nicht genau eine Zeile');
  });

  it('does not take a value for a new row that is gone', async () => {
    const tab = await table();
    edit.addRow(tab);
    cursor = [3, 2];
    await edit.begin(tab);
    edit.undo(tab);
    expect(edit.commit({ kind: 'value', text: 'late' })).not.toBeNull();
    expect(edit.count(tab).total).toBe(0);
  });

  // --- review 031 -----------------------------------------------------------------------------------

  it('leaves the tab where it is when the user keeps the changes instead of going to another table', async () => {
    const tab = await table();
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'mine' });
    const confirm = TestBed.inject(ConfirmService);
    const asked = query.tableQueries.length;
    // following a foreign key, back, forward: another table in the same tab
    const going = tab.openTable({ schema: 'public', table: 'customer', spec: EMPTY_SPEC });
    await settle();
    expect(confirm.request()?.title).toBe('Änderungen verwerfen?');
    // while the question is open nothing has changed yet
    expect(tab.tableView()).toMatchObject({ table: 'orders' });
    confirm.answer(false);
    await going;
    expect(tab.tableView()).toMatchObject({ table: 'orders' });
    expect(query.tableQueries.length).toBe(asked);
    expect(edit.count(tab).cells).toBe(1);
    // and writing still writes to the table the changes were made in
    await edit.save(tab);
    expect(query.applied.at(-1)!.plan.table).toBe('orders');
  });

  it('never writes changes into another table or another connection than they were made in', async () => {
    const tab = await table();
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'mine' });
    // the tab shows another table while the buffer still holds rows of the first (however that came)
    tab.tableView.set({ schema: 'public', table: 'customer', spec: EMPTY_SPEC });
    expect(await edit.save(tab)).toBe(false);
    expect(query.applied).toHaveLength(0);
    expect(tabs.notice()).toContain('andere Tabelle');
    tab.tableView.set({ schema: 'public', table: 'orders', spec: EMPTY_SPEC });
    tab.connectionId.set('elsewhere');
    expect(await edit.save(tab)).toBe(false);
    expect(query.applied).toHaveLength(0);
  });

  it('does not let the connection of a tab change under changes that are not written', async () => {
    const tab = await table();
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'mine' });
    const connections = TestBed.inject(ConnectionsStore);
    connections.activate('other');
    await settle();
    expect(tab.connectionId()).toBe('demo');
    expect(tabs.notice()).toContain('nicht geschrieben');
    expect(edit.count(tab).cells).toBe(1);
    // without changes the tab goes to the other connection – and is no table view of the old one any more
    tabs.notice.set(null);
    edit.discard(tab);
    connections.activate('other');
    await settle();
    expect(tab.connectionId()).toBe('other');
    expect(tab.tableView()).toBeNull();
  });

  it('does not take the value of an edit row whose rows are gone', async () => {
    const tab = await table();
    await edit.begin(tab);
    expect(edit.editing()).not.toBeNull();
    // the table is read again while the field is open (a filter, a click on a head)
    await tab.applyTable({ ...EMPTY_SPEC, limit: 200 });
    expect(edit.commit({ kind: 'value', text: 'late' })).not.toBeNull();
    expect(edit.count(tab).cells).toBe(0);
  });

  it('takes no changes while it writes, so none is lost with the buffer', async () => {
    const tab = await table();
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'one' });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const apply = query.editApply.bind(query);
    query.editApply = async (...args: Parameters<typeof apply>) => {
      await gate;
      return apply(...args);
    };
    const saving = edit.save(tab);
    await settle();
    expect(edit.busy()).toBe(true);
    cursor = [1, 1];
    await edit.begin(tab);
    expect(edit.editing()).toBeNull();
    await edit.setAtCursor(tab, { kind: 'default' });
    edit.undo(tab);
    expect(edit.count(tab)).toMatchObject({ cells: 1, rows: 1 });
    open();
    expect(await saving).toBe(true);
    expect(query.applied.at(-1)!.plan.rows).toHaveLength(1);
  });

  it('says what stopped the writing: an open transaction, an outcome nobody knows', async () => {
    const tab = await table();
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'x' });
    query.applyAnswer = { done: 0, blocked: true, tx: 'active' };
    expect(await edit.save(tab)).toBe(false);
    expect(tabs.notice()).toContain('Transaktion offen');
    query.applyAnswer = {
      done: 0,
      unknown: true,
      error: { code: 'connection_failed', message: 'gone' },
    };
    expect(await edit.save(tab)).toBe(false);
    expect(tabs.notice()).toContain('nicht bekannt');
    expect(edit.count(tab).cells).toBe(1);
    // any other refusal of the backend is said as it is, not as „a transaction is open“
    query.applyAnswer = null;
    query.applyError = { code: 'unsupported', message: 'too many values in one statement' };
    await edit.save(tab);
    expect(tabs.notice()).not.toContain('Transaktion offen');
  });

  it('shows what would be written, and asks before unwritten changes are lost', async () => {
    const tab = await table();
    await edit.showPreview(tab);
    expect(edit.preview()).toBeNull();
    expect(tabs.notice()).toBe('Es gibt keine Änderungen zu schreiben.');
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'x' });
    await edit.showPreview(tab);
    expect(edit.preview()?.statements).toEqual([
      "UPDATE public.orders SET note = 'x' WHERE id = '1'",
    ]);
    edit.preview.set(null);
    // reading the table anew would lose the change: no → nothing runs, yes → gone
    const confirm = TestBed.inject(ConfirmService);
    const runs = query.statements.length;
    const first = tab.applyTable({ ...EMPTY_SPEC, limit: 200 });
    await settle();
    expect(confirm.request()?.title).toBe('Änderungen verwerfen?');
    confirm.answer(false);
    await first;
    expect(query.statements.length).toBe(runs);
    expect(edit.count(tab).cells).toBe(1);
    const second = tab.applyTable({ ...EMPTY_SPEC, limit: 200 });
    await settle();
    confirm.answer(true);
    await second;
    expect(query.statements.length).toBe(runs + 1);
    expect(edit.count(tab).cells).toBe(0);
    // closing a tab asks the same
    await edit.begin(tab);
    edit.commit({ kind: 'value', text: 'y' });
    const closing = tabs.close(tab.id);
    await settle();
    expect(confirm.request()?.title).toBe('Änderungen verwerfen?');
    confirm.answer(false);
    await closing;
    expect(tabs.tabs()).toContain(tab);
  });
});
