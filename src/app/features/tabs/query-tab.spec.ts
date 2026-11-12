import { TestBed } from '@angular/core/testing';
import { FakeConnectionsApi, FakeQueryApi } from '../../../testing/fake-apis';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { QueryTab } from './query-tab';
import { MAX_KEPT_RESULTS, runStatus, statusText } from './run-state';

describe('QueryTab', () => {
  let api: FakeQueryApi;
  let connections: FakeConnectionsApi;
  let store: ConnectionsStore;
  let tab: QueryTab;
  let options = { stopOnError: true, timeoutMs: 0 };

  beforeEach(async () => {
    options = { stopOnError: true, timeoutMs: 0 };
    api = new FakeQueryApi();
    connections = new FakeConnectionsApi();
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectionsApi, useValue: connections }],
    });
    store = TestBed.inject(ConnectionsStore);
    await store.load();
    tab = new QueryTab(
      {
        id: 't',
        title: 'T',
        customTitle: false,
        connection: 'demo',
        filePath: null,
        encoding: null,
      },
      { api, connections: store, options: () => options },
    );
  });

  it('runs on its connection and shows the rows', async () => {
    await tab.run('select 1');
    expect(tab.state().kind).toBe('done');
    expect(api.statements).toEqual([{ connection: 'demo', sql: 'select 1' }]);
    expect(statusText(tab.state())).toBe('2 Zeilen · 3 ms');
    expect(tab.running()).toBe(false);
    expect(tab.log().map((l) => [l.kind, l.sql, l.text])).toEqual([['ok', 'select 1', '2 Zeilen']]);
  });

  it('opens a closed connection first', async () => {
    await store.disconnect('demo');
    await tab.run('select 1');
    expect(tab.state().kind).toBe('done');
    expect(store.state('demo').kind).toBe('open');
  });

  it('shows the message of the server on an error and keeps the connection', async () => {
    api.error = { code: 'invalid_query', message: 'near "selec": syntax error' };
    await tab.run('selec 1');
    expect(tab.state()).toEqual({
      kind: 'failed',
      sql: 'selec 1',
      message: 'Die Anweisung ist ungültig. near "selec": syntax error',
      details: null,
    });
    expect(store.state('demo').kind).toBe('open');
  });

  it('marks in the text what runs and where it failed (prompt 022)', async () => {
    const marks: string[] = [];
    tab.attach({
      clearMarks: () => void marks.push('clear'),
      markRunning: (statements: readonly string[], index: number | null) =>
        void marks.push(index === null ? 'running: none' : `running: ${statements[index]}`),
      markError: (
        statements: readonly string[],
        index: number,
        message: string,
        details: unknown,
        jump: boolean,
      ) =>
        void marks.push(`error: ${statements[index]} | ${JSON.stringify(details)} | jump ${jump}`),
    } as never);
    api.error = {
      code: 'invalid_query',
      message: 'column "nmae" does not exist (42703)',
      details: { sqlstate: '42703', position: 8, hint: 'Perhaps you meant "name".' },
    } as never;
    const statements = ['select nmae from t', 'select 2'];
    await tab.runAll(statements);
    expect(marks).toEqual([
      'clear',
      'running: select nmae from t',
      'error: select nmae from t | {"sqlstate":"42703","hint":"Perhaps you meant \\"name\\".","position":8} | jump true',
      'running: none',
    ]);
    // the result area has the parts of the message apart
    expect(tab.state()).toMatchObject({
      kind: 'failed',
      details: { sqlstate: '42703', hint: 'Perhaps you meant "name".' },
    });
    // the next run starts with a clean text
    api.error = null;
    marks.length = 0;
    await tab.run('select 1');
    expect(marks).toEqual(['clear', 'running: select 1', 'running: none']);
  });

  it('says why when the connection cannot be opened', async () => {
    await store.disconnect('demo');
    connections.failOpen = { code: 'connection_failed', message: 'refused' };
    await tab.run('select 1');
    expect(tab.state()).toMatchObject({
      kind: 'failed',
      message: 'Die Verbindung ist fehlgeschlagen. refused',
    });
    expect(api.statements).toEqual([]);
  });

  it('asks the backend to stop and shows a cancelled statement as such', async () => {
    api.error = { code: 'cancelled', message: 'cancelled' };
    const run = tab.run('select sleep(60)');
    expect(tab.running()).toBe(true);
    tab.cancel();
    await run;
    expect(api.cancelled).toEqual(['demo']);
    expect(tab.state()).toEqual({ kind: 'cancelled', sql: 'select sleep(60)' });
    expect(statusText(tab.state())).toBe('Abgebrochen');
    // the statement was cancelled on the server: the session is still there
    expect(store.state('demo').kind).toBe('open');
    api.error = null;
    await tab.run('select 1');
    expect(tab.state().kind).toBe('done');
  });

  it('opens the connection again when the backend lost it', async () => {
    api.errors.push({ code: 'not_connected', message: 'not connected' });
    await tab.run('select 1');
    expect(tab.state().kind).toBe('done');
    expect(api.statements.length).toBe(2);
    expect(connections.opened.filter((o) => o.id === 'demo').length).toBe(2);
  });

  it('lets a new run take the place of a running one', async () => {
    const first = tab.run('select 1');
    const second = tab.run('select 2');
    await Promise.all([first, second]);
    const state = tab.state();
    expect(state.kind === 'done' && state.sql).toBe('select 2');
    expect(tab.runs().length).toBe(1);
    // the older statement was asked to stop
    expect(api.cancelled).toEqual(['demo']);
  });

  it('runs a script in order and shows the first result with rows', async () => {
    await tab.runAll(['select 1', '  ', 'select 2', 'select 3']);
    expect(api.statements.map((s) => s.sql)).toEqual(['select 1', 'select 2', 'select 3']);
    expect(tab.runs().map((r) => r.kind)).toEqual(['done', 'done', 'done']);
    expect(tab.shown()).toBe(0);
    expect(tab.log().length).toBe(3);
    expect(runStatus(tab.runs(), 0)).toBe('3 Anweisungen · 3 ausgeführt · 9 ms');
  });

  it('leaves out the rest after an error and shows the error', async () => {
    api.errors.push(null, { code: 'invalid_query', message: 'no such table: x' });
    await tab.runAll(['select 1', 'select * from x', 'select 3']);
    expect(tab.runs().map((r) => r.kind)).toEqual(['done', 'failed', 'skipped']);
    expect(api.statements.length).toBe(2);
    expect(tab.shown()).toBe(1);
    expect(tab.state()).toMatchObject({ kind: 'failed' });
    expect(tab.log().map((l) => l.kind)).toEqual(['ok', 'error']);
    expect(runStatus(tab.runs(), 0)).toContain('1 mit Fehler · 1 nicht ausgeführt');
  });

  it('goes on after an error when the setting says so', async () => {
    options.stopOnError = false;
    api.errors.push({ code: 'invalid_query', message: 'boom' });
    await tab.runAll(['selec 1', 'select 2']);
    expect(tab.runs().map((r) => r.kind)).toEqual(['failed', 'done']);
    expect(tab.shown()).toBe(0);
  });

  it('stops a script where it was cancelled', async () => {
    api.errors.push(null, { code: 'cancelled', message: 'cancelled' });
    await tab.runAll(['select 1', 'select sleep(60)', 'select 3']);
    expect(tab.runs().map((r) => r.kind)).toEqual(['done', 'cancelled', 'cancelled']);
    expect(api.statements.length).toBe(2);
  });

  it('shows the messages when no statement of a script has rows', async () => {
    api.rowsAffected = 3;
    await tab.runAll(['update a set n = 1', 'delete from b']);
    expect(tab.shown()).toBe('messages');
    expect(tab.log().map((l) => l.text)).toEqual(['3 Zeilen geändert', '3 Zeilen geändert']);
  });

  it('keeps only the first results of a long script', async () => {
    await tab.runAll(Array.from({ length: MAX_KEPT_RESULTS + 2 }, (_, i) => `select ${i}`));
    const runs = tab.runs();
    expect(runs.filter((r) => r.result !== null).length).toBe(MAX_KEPT_RESULTS);
    const last = runs[runs.length - 1];
    expect(last.kind).toBe('done');
    expect(last.rows).toBe(2);
    tab.shown.set(runs.length - 1);
    expect(tab.state()).toMatchObject({ kind: 'failed' });
    expect(tab.log().length).toBe(MAX_KEPT_RESULTS + 2);
    // what is not kept does not stay in the store either
    expect(api.results.size).toBe(MAX_KEPT_RESULTS);
    expect(api.freed.length).toBe(2);
  });

  it('sends the time limit of the settings and names a timeout', async () => {
    options.timeoutMs = 5000;
    api.errors.push({ code: 'timeout', message: 'no answer within 5 s' });
    await tab.run('select sleep(60)');
    expect(api.timeouts).toEqual([5000]);
    expect(tab.state()).toMatchObject({
      kind: 'failed',
      message: 'Keine Antwort in der vorgesehenen Zeit.',
    });
    // the statement was ended on the server: the session is kept
    expect(store.state('demo').kind).toBe('open');
  });

  it('describes changed rows and cut off results', async () => {
    api.rowsAffected = 1;
    await tab.run('update t set a = 1');
    expect(statusText(tab.state())).toBe('1 Zeile geändert · 3 ms');
    expect(tab.state()).toMatchObject({ kind: 'done', result: null });
    api.rowsAffected = null;
    api.truncated = true;
    await tab.run('select 1');
    expect(statusText(tab.state())).toBe('2 Zeilen (abgeschnitten) · 3 ms');
    expect(statusText({ kind: 'idle' })).toBe('Bereit');
  });

  it('keeps the rows in the store of the backend and reads windows of them', async () => {
    await tab.run('select 1');
    const state = tab.state();
    expect(state).toMatchObject({ kind: 'done', rows: 2, result: { resultId: 1 } });
    expect(await tab.window(1, 0, 10)).toEqual([
      [1, 'Ada'],
      [2, null],
    ]);
    // the next run replaces the result: the old one leaves the store
    await tab.run('select 2');
    expect(api.freed).toEqual([1]);
    expect([...api.results.keys()]).toEqual([2]);
    tab.dispose();
    expect(api.freed).toEqual([1, 2]);
    expect(tab.runs()).toEqual([]);
  });

  it('shows rows while the statement still reads', async () => {
    let finish: () => void = () => undefined;
    const seen: unknown[] = [];
    const real = api.run.bind(api);
    api.run = (connection, sql, timeoutMs, onEvent) => {
      onEvent?.({ kind: 'started', resultId: 9, columns: api.columns });
      onEvent?.({ kind: 'rows', rows: 5000 });
      seen.push(tab.state());
      return new Promise((resolve) => {
        finish = () => resolve(real(connection, sql, timeoutMs));
      });
    };
    const run = tab.run('select * from big');
    await Promise.resolve();
    await Promise.resolve();
    expect(seen[0]).toMatchObject({ kind: 'running', rows: 5000, result: { resultId: 9 } });
    expect(runStatus(tab.runs(), 1500)).toBe('Läuft … 1,50 s · 5\u202f000 Zeilen gelesen');
    finish();
    await run;
    expect(tab.state().kind).toBe('done');
  });

  it('forgets the rows of a statement that fails after it started', async () => {
    api.run = (_c, _s, _t, onEvent) => {
      onEvent?.({ kind: 'started', resultId: 7, columns: api.columns });
      return Promise.reject({ code: 'connection_failed', message: 'broken pipe' });
    };
    await tab.run('select * from big');
    expect(tab.runs()[0]).toMatchObject({ kind: 'failed', result: null, rows: null });
  });

  it('remembers what it is', () => {
    tab.title.set('Kunden');
    tab.customTitle.set(true);
    tab.connectionId.set('pg');
    expect(tab.meta()).toEqual({
      id: 't',
      title: 'Kunden',
      customTitle: true,
      connection: 'pg',
      filePath: null,
      encoding: null,
      group: 0,
      caretLine: 0,
      caretCh: 0,
    });
  });

  it('keeps its group and the place of the caret over a restart', () => {
    const restored = new QueryTab(
      {
        id: 'r',
        title: 'R',
        customTitle: false,
        connection: 'demo',
        filePath: null,
        encoding: null,
        group: 1,
        caretLine: 12,
        caretCh: 4,
      },
      {} as never,
    );
    expect(restored.group()).toBe(1);
    // never looked at: the place it came with is the place it leaves with
    expect(restored.meta()).toMatchObject({ group: 1, caretLine: 12, caretCh: 4 });
    // the editor is sent there once
    expect(restored.takeStartCaret()).toEqual({ line: 12, ch: 4 });
    expect(restored.takeStartCaret()).toBeNull();
    restored.caret.set({ line: 3, ch: 9 } as never);
    expect(restored.meta()).toMatchObject({ caretLine: 3, caretCh: 9 });
    // a broken file: first group, no place
    const broken = new QueryTab(
      {
        id: 'b',
        title: 'B',
        customTitle: false,
        connection: null,
        filePath: null,
        encoding: null,
        group: 9,
        caretLine: -3,
        caretCh: 2.5,
      },
      {} as never,
    );
    expect(broken.group()).toBe(0);
    expect(broken.takeStartCaret()).toBeNull();
  });
});

describe('QueryTab: results that are kept (prompt 041)', () => {
  let api: FakeQueryApi;
  let tab: QueryTab;
  let options: { stopOnError: boolean; timeoutMs: number; keepResults?: boolean };

  beforeEach(async () => {
    options = { stopOnError: true, timeoutMs: 0 };
    api = new FakeQueryApi();
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectionsApi, useValue: new FakeConnectionsApi() }],
    });
    const store = TestBed.inject(ConnectionsStore);
    await store.load();
    tab = new QueryTab(
      {
        id: 't',
        title: 'T',
        customTitle: false,
        connection: 'demo',
        filePath: null,
        encoding: null,
      },
      { api, connections: store, options: () => options },
    );
  });

  const ids = () => tab.runs().map((r) => r.result?.resultId ?? null);

  it('gives every statement of a script a tab with a title and its rows', async () => {
    await tab.runAll(Array.from({ length: 20 }, (_, i) => `select * from tabelle_${i}`));
    const subs = tab.subTabs();
    expect(subs.length).toBe(20);
    expect(subs[7]).toMatchObject({ target: 7, title: 'tabelle_7', rows: 2, kind: 'done' });
    tab.show(19);
    expect(tab.state().kind).toBe('done');
  });

  it('keeps a pinned result over the next run, and frees the others', async () => {
    await tab.runAll(['select * from a', 'select * from b']);
    const [a, b] = ids();
    tab.show(1);
    tab.togglePin();
    expect(tab.shown()).toBe('k1');
    expect(tab.isPinned()).toBe(true);
    // the statement of the run has no tab of its own any more
    expect(tab.subTabs().map((t) => t.target)).toEqual(['k1', 0]);
    await tab.runAll(['select * from c']);
    expect(api.freed).toEqual([a]);
    expect(api.results.has(b as number)).toBe(true);
    expect(tab.subTabs().map((t) => [t.target, t.title])).toEqual([
      ['k1', 'b'],
      [0, 'c'],
    ]);
    // the new run is on screen; the pinned one can be looked at
    expect(tab.shown()).toBe(0);
    tab.show('k1');
    expect(tab.state()).toMatchObject({ kind: 'done', sql: 'select * from b', rows: 2 });
  });

  it('lets an unpinned result go with the next run', async () => {
    await tab.run('select * from a');
    const [a] = ids();
    tab.togglePin();
    tab.togglePin();
    expect(tab.isPinned()).toBe(false);
    expect(tab.kept().length).toBe(1);
    await tab.run('select * from b');
    expect(tab.kept()).toEqual([]);
    expect(api.freed).toEqual([a]);
  });

  it('closes a kept result: it leaves the store, and its neighbour is shown', async () => {
    await tab.run('select * from a');
    const [a] = ids();
    tab.togglePin();
    tab.closeKept('k1');
    expect(api.freed).toEqual([a]);
    expect(tab.kept()).toEqual([]);
    expect(tab.shown()).toBe('messages');
  });

  it('with „keep the results“ every run gets new tabs', async () => {
    options.keepResults = true;
    await tab.run('select * from a');
    await tab.runAll(['select * from b', 'select * from c']);
    await tab.run('select * from d');
    expect(api.freed).toEqual([]);
    expect(tab.subTabs().map((t) => [t.title, t.pinned])).toEqual([
      ['a', false],
      ['b', false],
      ['c', false],
      ['d', false],
    ]);
    tab.closeKeptAll();
    expect(tab.kept()).toEqual([]);
    expect(api.freed.length).toBe(3);
  });

  it('frees what it keeps when the tab goes', async () => {
    await tab.runAll(['select * from a', 'select * from b']);
    const all = ids();
    tab.togglePin(0);
    tab.dispose();
    expect([...api.freed].sort()).toEqual([...all].sort());
  });

  it('names results', async () => {
    await tab.runAll(['select * from a', 'select * from b']);
    tab.renameResult(0, '  Stand vorher ');
    expect(tab.subTabs()[0].title).toBe('Stand vorher');
    const key = tab.keep(0);
    expect(tab.subTabs()[0]).toMatchObject({ target: key, title: 'Stand vorher' });
    tab.renameResult('k1', '');
    expect(tab.subTabs()[0].title).toBe('a');
  });

  it('pins no statement without a result and nothing of a failed one', async () => {
    api.rowsAffected = 3;
    await tab.run('update a set x = 1');
    expect(tab.canPin()).toBe(false);
    tab.togglePin();
    expect(tab.kept()).toEqual([]);
  });

  it('hands a kept result to another tab without freeing it', async () => {
    await tab.run('select * from a');
    tab.togglePin();
    const kept = tab.release('k1');
    expect(kept?.run.sql).toBe('select * from a');
    expect(tab.kept()).toEqual([]);
    expect(api.freed).toEqual([]);
    tab.adopt(kept!);
    expect(tab.shownKept()?.pinned).toBe(true);
  });

  it('compares two results: the outcome is a kept result, shown with its differences', async () => {
    await tab.runAll(['select * from a', 'select * from b']);
    const [a, b] = ids() as number[];
    const all = tab.comparable();
    expect(all.map((c) => c.title)).toEqual(['1: a', '2: b']);
    const spec = {
      left: a,
      right: b,
      keys: [0],
      ignore: [],
      trim: false,
      ignoreCase: false,
      decimals: null,
    };
    const progress: (number | null)[] = [];
    let open!: () => void;
    api.compareGate = new Promise<void>((r) => (open = r));
    const running = tab.compare(spec, 'a', 'b');
    progress.push(tab.comparing()?.done ?? null);
    open();
    expect(await running).toBe(true);
    expect(progress).toEqual([1]);
    expect(tab.comparing()).toBeNull();
    expect(api.compares[0].spec).toEqual(spec);
    const kept = tab.shownKept();
    expect(kept?.compare?.onlyDifferences).toBe(true);
    // the view of the differences is what the grid reads
    expect(tab.state()).toMatchObject({ kind: 'done', rows: 3, result: { resultId: 5003 } });
    expect(tab.subTabs()[0]).toMatchObject({ title: 'a ↔ b', compare: true, pinned: true });
    tab.setOnlyDifferences('k1', false);
    expect(tab.state()).toMatchObject({ rows: 4, result: { resultId: 5002 } });
    // a comparison is not compared again
    expect(tab.comparable().length).toBe(2);
    tab.closeKept('k1');
    expect(api.freed).toEqual([5002]);
  });

  it('a comparison that is stopped leaves nothing', async () => {
    await tab.runAll(['select * from a', 'select * from b']);
    let open!: () => void;
    api.compareGate = new Promise<void>((r) => (open = r));
    const spec = {
      left: 1,
      right: 2,
      keys: [],
      ignore: [],
      trim: false,
      ignoreCase: false,
      decimals: null,
    };
    const running = tab.compare(spec, 'a', 'b');
    tab.cancelCompare();
    expect(api.cancelledCompares.length).toBe(1);
    open();
    expect(await running).toBe(false);
    expect(tab.kept()).toEqual([]);
    // what the backend still answered is freed
    expect(api.freed).toEqual([5002]);
  });

  it('says why a comparison failed', async () => {
    await tab.runAll(['select * from a', 'select * from b']);
    api.compareError = { code: 'unsupported', message: 'the results have no column in common' };
    const spec = {
      left: 1,
      right: 2,
      keys: [],
      ignore: [],
      trim: false,
      ignoreCase: false,
      decimals: null,
    };
    expect(await tab.compare(spec, 'a', 'b')).toBe(false);
    expect(tab.compareProblem()).toBe('Das wird nicht unterstützt.');
  });

  it('runs again and names the old and the new result to compare', async () => {
    await tab.run('select * from a');
    const [old] = ids();
    const pair = await tab.runAgainToCompare();
    expect(api.statements.map((s) => s.sql)).toEqual(['select * from a', 'select * from a']);
    expect(pair?.left.result.resultId).toBe(old);
    expect(pair?.right.result.resultId).toBe(ids()[0]);
    expect(pair?.left.target).toBe('k1');
    expect(api.freed).toEqual([]);
    // from the kept one: again its statement
    tab.show('k1');
    const again = await tab.runAgainToCompare();
    expect(again?.left.target).toBe('k1');
    expect(again?.right.target).toBe(0);
  });

  it('jumps to the next difference of a comparison', async () => {
    await tab.runAll(['select * from a', 'select * from b']);
    const spec = {
      left: 1,
      right: 2,
      keys: [0],
      ignore: [],
      trim: false,
      ignoreCase: false,
      decimals: null,
    };
    await tab.compare(spec, 'a', 'b');
    const went: number[] = [];
    let cursor: readonly [number, number] | null = [0, 0];
    tab.grid = {
      cursor: () => cursor,
      goTo: (row) => went.push(row),
      fitWidths: () => undefined,
      focusGrid: () => undefined,
    };
    // only differences: the next row is the next difference
    expect(await tab.nextDifference(true)).toBe(true);
    cursor = [2, 0];
    expect(await tab.nextDifference(true)).toBe(false);
    expect(went).toEqual([1]);
    // all rows: the backend knows where the next one is
    tab.setOnlyDifferences('k1', false);
    api.neighbour = [1, 3];
    cursor = [1, 0];
    expect(await tab.nextDifference(true)).toBe(true);
    expect(went).toEqual([1, 3]);
    api.neighbour = null;
    expect(await tab.nextDifference(false)).toBe(false);
  });
});
