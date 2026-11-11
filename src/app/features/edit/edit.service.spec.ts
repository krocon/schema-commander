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

  beforeEach(async () => {
    TestBed.resetTestingModule();
    query = new FakeQueryApi();
    schema = new FakeSchemaApi();
    const connections = new FakeConnectionsApi();
    connections.profiles = [DEMO_PROFILE];
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
    tab.grid = {
      cursor: () => cursor,
      goTo: (row) => (cursor = [row, cursor[1]]),
      fitWidths: () => undefined,
      focusGrid: () => undefined,
    };
    edit.ensure(tab);
    await settle();
    return tab;
  }

  const columns = () => copier.current()!.result.columns;

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
    expect(edit.count(tab)).toEqual({ cells: 1, rows: 1 });
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
    expect(tabs.notice()).toBe('3 Zeilen geschrieben.');
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
    expect(edit.count(tab)).toEqual({ cells: 2, rows: 2 });
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
    // a transaction of the user's own is open in the tab
    query.applyAnswer = null;
    query.applyError = { code: 'unsupported', message: 'a transaction is open on this tab' };
    await edit.save(tab);
    expect(tabs.notice()).toContain('Transaktion offen');
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
