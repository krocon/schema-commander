import { computed, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { TabMeta } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { RowWindow, RunEvent, RunOutcome } from '../../core/sql/query.models';
import { EdCaret } from '../editor/editlicious';
import {
  LogEntry,
  MAX_KEPT_RESULTS,
  MAX_LOG,
  RunState,
  StatementRun,
  firstLine,
  outcomeText,
  pending,
  stateOf,
} from './run-state';

/** What a tab needs of its editor; the pane of the tab registers it. */
export interface TabEditor {
  getText(): Promise<string>;
  setText(text: string): Promise<void>;
  focus(): void;
  /** Runs the selection if there is one, else the statement under the caret. */
  runCurrent(): Promise<void>;
  /** Runs the whole script. */
  runScript(): Promise<void>;
}

/** The services a tab works with (handed in by the `TabsStore`, tabs are no injectables). */
export interface TabServices {
  readonly api: QueryApi;
  readonly connections: ConnectionsStore;
  /** How statements run right now (from the settings). */
  readonly options: () => RunOptions;
}

export interface RunOptions {
  /** Leave out the rest of a script after an error. */
  readonly stopOnError: boolean;
  /** Time at most per statement, 0 = as long as it takes. */
  readonly timeoutMs: number;
}

/**
 * A query tab (prompts 004, 005): its title, connection, editor, the statements of its last run with their
 * results, and its messages. One instance per tab, addressed by id.
 */
export class QueryTab {
  readonly id: string;
  readonly title = signal('');
  /** The user named the tab: the title no longer follows its text. */
  readonly customTitle = signal(false);
  /** The profile statements run on. */
  readonly connectionId = signal('demo');
  readonly filePath = signal<string | null>(null);
  readonly encoding = signal<string | null>(null);

  /** The statements of the last run (one statement, a selection or a script) and how they went. */
  readonly runs = signal<readonly StatementRun[]>([]);
  /** What the result area shows: a statement of the run, or the messages. */
  readonly shown = signal<number | 'messages'>(0);
  /** What the tab ran so far, the newest last. */
  readonly log = signal<readonly LogEntry[]>([]);
  /** How long the run takes so far (ticks while it runs). */
  readonly elapsedMs = signal(0);
  /** The outcome of the statement shown. */
  readonly state = computed<RunState>(() => {
    const shown = this.shown();
    return stateOf(this.runs()[shown === 'messages' ? 0 : shown]);
  });
  readonly caret = signal<EdCaret | null>(null);
  /** The tab was shown once: its editor exists (tabs restored at the start are built when first looked at). */
  readonly mounted = signal(false);
  /** The text changed since it was loaded or written to its file. Only tabs with a file show it. */
  readonly dirty = signal(false);
  /** Characters of the text, as far as the editor told (for the pace of the backup). */
  readonly chars = signal(0);

  readonly running = computed(() =>
    this.runs().some((r) => r.kind === 'running' || r.kind === 'pending'),
  );

  private editor: TabEditor | null = null;
  private runId = 0;
  private runningOn: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    meta: TabMeta,
    private readonly services: TabServices,
    /** A text the tab starts with instead of its backup (new tab from a file, duplicate). */
    readonly startText: string | null = null,
  ) {
    this.id = meta.id;
    this.title.set(meta.title);
    this.customTitle.set(meta.customTitle);
    this.connectionId.set(meta.connection ?? 'demo');
    this.filePath.set(meta.filePath);
    this.encoding.set(meta.encoding);
  }

  meta(): TabMeta {
    return {
      id: this.id,
      title: this.title(),
      customTitle: this.customTitle(),
      connection: this.connectionId(),
      filePath: this.filePath(),
      encoding: this.encoding(),
    };
  }

  attach(editor: TabEditor): void {
    this.editor = editor;
  }

  detach(editor: TabEditor): void {
    if (this.editor === editor) this.editor = null;
  }

  /** The text of the editor; `null` while the tab has none (never shown). */
  text(): Promise<string | null> {
    return this.editor ? this.editor.getText() : Promise.resolve(null);
  }

  focus(): void {
    this.editor?.focus();
  }

  runCurrent(): void {
    void this.editor?.runCurrent();
  }

  runScript(): void {
    void this.editor?.runScript();
  }

  /** Runs one statement. */
  run(sql: string): Promise<void> {
    return this.runAll([sql]);
  }

  /**
   * Runs statements one after the other on the tab's connection, opening it first when it is closed. After
   * an error the rest is left out, unless the setting says to go on. A run started while another runs takes
   * its place: the older one is stopped and its answers are dropped.
   */
  async runAll(statements: readonly string[]): Promise<void> {
    const sqls = statements.filter((s) => s.trim() !== '');
    if (sqls.length === 0) return;
    const { connections } = this.services;
    if (this.running()) this.cancel();
    const id = ++this.runId;
    const latest = () => id === this.runId;
    const connection = this.connectionId();
    const options = this.services.options();
    this.freeAll();
    this.runs.set(sqls.map(pending));
    this.shown.set(0);
    this.startTimer();
    const set = (index: number, change: Partial<StatementRun>) => {
      if (!latest()) return;
      this.runs.update((all) => all.map((r, i) => (i === index ? { ...r, ...change } : r)));
    };
    let kept = 0;
    let stop: 'failed' | 'cancelled' | null = null;
    try {
      for (let index = 0; index < sqls.length && latest(); index++) {
        const sql = sqls[index];
        if (stop !== null) {
          set(index, { kind: stop === 'cancelled' ? 'cancelled' : 'skipped' });
          continue;
        }
        set(index, { kind: 'running' });
        this.runningOn = connection;
        const started = Date.now();
        try {
          if (!(await connections.connect(connection))) {
            const state = connections.state(connection);
            // no message: the password dialog was dismissed
            const message = state.kind === 'failed' ? state.message : null;
            set(index, { kind: message ? 'failed' : 'cancelled', message, elapsedMs: 0 });
            if (latest()) this.note(index, started);
            stop = message ? 'failed' : 'cancelled';
            continue;
          }
          const keep = kept < MAX_KEPT_RESULTS;
          const outcome = await this.runOnce(connection, sql, options.timeoutMs, (event) => {
            // rows can be looked at while the rest is still read
            if (event.kind === 'rows') set(index, { rows: event.rows });
            else if (keep) set(index, { result: event, rows: 0 });
          });
          const hasRows = outcome.resultId !== null;
          if (hasRows && keep) kept++;
          if (outcome.resultId !== null && (!keep || !latest())) this.free([outcome.resultId]);
          set(index, {
            kind: 'done',
            result:
              keep && outcome.resultId !== null
                ? { resultId: outcome.resultId, columns: outcome.columns }
                : null,
            rows: hasRows ? outcome.rows : null,
            rowsAffected: outcome.rowsAffected,
            truncated: outcome.truncated,
            elapsedMs: outcome.elapsedMs,
          });
        } catch (e) {
          const error = toAppError(e);
          const elapsedMs = Date.now() - started;
          // the backend says whether the session survived; a lost one is opened again by the next run
          if (
            !['invalid_query', 'permission_denied', 'cancelled', 'timeout'].includes(error.code)
          ) {
            connections.markClosed(connection);
          }
          // a statement that did not end well leaves no result behind (the backend freed it)
          set(index, { result: null, rows: null });
          if (error.code === 'cancelled') {
            set(index, { kind: 'cancelled', elapsedMs });
            stop = 'cancelled';
          } else {
            set(index, { kind: 'failed', message: describeError(error), elapsedMs });
            if (options.stopOnError) stop = 'failed';
          }
        }
        if (latest()) this.note(index, started);
      }
    } finally {
      if (latest()) {
        this.runningOn = null;
        this.stopTimer();
        this.showFirstOfInterest();
      }
    }
  }

  /** Asks the backend to stop the statement that runs. */
  cancel(): void {
    if (this.runningOn !== null) {
      void this.services.api.cancel(this.runningOn).catch(() => undefined);
    }
  }

  /** The connection was open in the store but the backend lost it: open it again, once. */
  private async runOnce(
    connection: string,
    sql: string,
    timeoutMs: number,
    onEvent: (event: RunEvent) => void,
  ): Promise<RunOutcome> {
    const { api, connections } = this.services;
    try {
      return await api.run(connection, sql, timeoutMs, onEvent);
    } catch (e) {
      if (toAppError(e).code !== 'not_connected') throw e;
      connections.markClosed(connection);
      if (!(await connections.connect(connection))) throw e;
      return api.run(connection, sql, timeoutMs, onEvent);
    }
  }

  /** The tab goes: its statement is stopped and its results leave the store. */
  dispose(): void {
    this.cancel();
    this.runId++;
    this.stopTimer();
    this.freeAll();
    this.runs.set([]);
  }

  /** Rows `from..from + count` of a result of this tab. */
  window(resultId: number, from: number, count: number): Promise<RowWindow> {
    return this.services.api.window(resultId, from, count);
  }

  /** The results of the last run leave the store of the backend. */
  private freeAll(): void {
    this.free(this.runs().flatMap((r) => (r.result ? [r.result.resultId] : [])));
  }

  private free(ids: readonly number[]): void {
    if (ids.length > 0) void this.services.api.free(ids).catch(() => undefined);
  }

  /** Writes the outcome of a statement into the messages. */
  private note(index: number, started: number): void {
    const run = this.runs()[index];
    if (!run) return;
    const kind = run.kind === 'done' ? 'ok' : run.kind === 'failed' ? 'error' : 'cancelled';
    const entry: LogEntry = {
      at: started,
      kind,
      sql: firstLine(run.sql),
      text: outcomeText(run),
      elapsedMs: run.elapsedMs,
    };
    this.log.update((all) => [...all, entry].slice(-MAX_LOG));
  }

  /** After a run: the first error, else the first result with rows, else the messages of a script. */
  private showFirstOfInterest(): void {
    const runs = this.runs();
    const failed = runs.findIndex((r) => r.kind === 'failed');
    const rows = runs.findIndex((r) => r.kind === 'done' && r.rowsAffected === null);
    if (runs.length === 1) this.shown.set(0);
    else if (failed >= 0) this.shown.set(failed);
    else if (rows >= 0) this.shown.set(rows);
    else this.shown.set('messages');
  }

  private startTimer(): void {
    this.stopTimer();
    const started = Date.now();
    this.elapsedMs.set(0);
    this.timer = setInterval(() => this.elapsedMs.set(Date.now() - started), 100);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
