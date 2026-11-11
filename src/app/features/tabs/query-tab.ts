import { Dialect } from '../editor/sql-split';
import {
  BoundStatement,
  ParamValue,
  bind,
  describeValue,
  findParams,
  formsOf,
  paramKeys,
  writtenPosition,
} from '../params/param-logic';
import type { ParamRequest } from '../params/param.service';
import { PARAM_TEXTS } from '../params/param-texts';
import { FormatMode } from '../../core/format/format-api';
import { FormatOutcome } from '../format/format-logic';
import { RunGuard } from '../../core/sql/query-api';
import { GuardAnswer, GuardedStatement, needingConfirmation } from '../guard/guard-logic';
import type { RanStatement } from '../history/history.service';
import { computed, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { ErrorDetails, describeError, toAppError } from '../../core/errors/app-error';
import { TabMeta } from '../../core/session/session-api';
import { Group, restoreGroup } from './layout-logic';
import { QueryApi } from '../../core/sql/query-api';
import { RowWindow, RunEvent, RunOutcome, TxState } from '../../core/sql/query.models';
import { txOpen } from './tx-logic';
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
import { TABS_TEXTS } from './tabs-texts';

/** What a tab needs of its editor; the pane of the tab registers it. */
export interface TabEditor {
  /** Puts the caret at a line and column (both from 1) and shows the place. */
  goTo(line: number, ch: number): Promise<void>;
  getText(): Promise<string>;
  /** The selected text; `''` = nothing selected. */
  selectedText(): Promise<string>;
  setText(text: string): Promise<void>;
  focus(): void;
  /** Puts text where the caret is (over the selection); a snippet has placeholders to tab through. */
  insert(text: string, snippet: boolean): Promise<void>;
  /** Runs the selection if there is one, else the statement under the caret. */
  runCurrent(): Promise<void>;
  /** Runs the whole script. */
  runScript(): Promise<void>;
  /** Writes out the `*` at the caret as its columns; resolves with whether it did. */
  expandStar(): Promise<boolean>;
  /** Formats the script, or the selection / the statement under the caret (prompt 023). */
  format(mode: FormatMode, whole: boolean): Promise<FormatOutcome>;
  /** Comments the selected lines out or in. */
  toggleComment(): Promise<void>;
  /**
   * Marks in the text (prompt 022). `statements` is the list a run was started with: the editor knows
   * where each of its statements stands. `markRunning(…, null)` ends the mark of the running statement.
   */
  clearMarks(): void;
  markRunning(statements: readonly string[], index: number | null): void;
  markError(
    statements: readonly string[],
    index: number,
    message: string,
    details: ErrorDetails | null,
    jump: boolean,
  ): void;
  /** Puts the caret on the place of the error that is marked, if there is one. */
  goToError(): void;
}

/** The services a tab works with (handed in by the `TabsStore`, tabs are no injectables). */
export interface TabServices {
  readonly api: QueryApi;
  readonly connections: ConnectionsStore;
  /** How statements run right now (from the settings). */
  readonly options: () => RunOptions;
  /**
   * Asks the user about statements the connection guards (prompt 012); `null` = no. Without it, guarded
   * statements are not confirmed and the backend refuses them.
   */
  readonly confirmRun?: (
    connection: string,
    statements: readonly GuardedStatement[],
    total: number,
  ) => Promise<GuardAnswer | null>;
  /** Something the user must know and no result shows (a transaction lost with its connection). */
  readonly notify?: (message: string) => void;
  /**
   * Parameters in statements (prompt 025): whether they are looked for, which forms count on a connection,
   * and the question for their values (`null` = the run is off). Without it statements run as written.
   */
  readonly params?: {
    enabled(): boolean;
    forms(connectionId: string): readonly string[] | undefined;
    ask(request: ParamRequest): Promise<Readonly<Record<string, ParamValue>> | null>;
  };
  /** A statement ended, one way or the other (the history notes it). */
  readonly record?: (ran: RanStatement) => void;
  /** Statements ended well on a connection (the schema tree reads again after DDL). */
  readonly ran?: (connection: string, statements: readonly string[]) => void;
}

export interface RunOptions {
  /** Leave out the rest of a script after an error. */
  readonly stopOnError: boolean;
  /** Time at most per statement, 0 = as long as it takes. */
  readonly timeoutMs: number;
  /** Dangerous statements on unprotected connections run without a question. */
  readonly allowDangerous?: boolean;
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
  /**
   * The values of parameters given in this tab, by name (prompt 025). Kept while the tab lives, in memory
   * only: they are data of the user and go neither into the session nor into the history.
   */
  readonly paramValues = signal<Readonly<Record<string, ParamValue>>>({});
  /** The statements of the last run that had parameters: to run them again with the same values. */
  private lastStatements: readonly string[] | null = null;
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
  /** The tab group it is in (prompt 016); only the `TabsStore` moves it. */
  readonly group = signal<Group>(0);
  /** Where the caret was when the app closed; the editor goes there once it has its text. */
  private restoreCaret: { line: number; ch: number } | null = null;
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
  /** What the server says about the transaction of this tab's session (prompt 013). */
  readonly tx = signal<TxState>('idle');
  /** When the open transaction was first seen (ms since the epoch). */
  readonly txSince = signal<number | null>(null);
  /** Statements that ran in the open transaction. */
  readonly txStatements = signal(0);
  /** Manual commit: statements open a transaction that stays open until commit or rollback. */
  readonly manual = signal(false);
  /** The run `cancel` was asked for last. */
  private cancelledRun = 0;
  /** Who wrote the statements of the run that is on. */
  private origin: 'user' | 'app' = 'user';
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
    this.group.set(restoreGroup(meta.group));
    const line = meta.caretLine ?? 0;
    if (Number.isInteger(line) && line > 0) {
      this.restoreCaret = { line, ch: Math.max(1, Math.trunc(meta.caretCh ?? 1) || 1) };
    }
  }

  /** Where the editor starts (once): the place of the last run; `null` = at the top. */
  takeStartCaret(): { line: number; ch: number } | null {
    const at = this.restoreCaret;
    this.restoreCaret = null;
    return at;
  }

  meta(): TabMeta {
    return {
      id: this.id,
      title: this.title(),
      customTitle: this.customTitle(),
      connection: this.connectionId(),
      filePath: this.filePath(),
      encoding: this.encoding(),
      group: this.group(),
      // a tab never looked at keeps the place it was restored with
      caretLine: this.caret()?.line ?? this.restoreCaret?.line ?? 0,
      caretCh: this.caret()?.ch ?? this.restoreCaret?.ch ?? 0,
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

  /** The selected text of the editor; `''` when nothing is selected or the editor is not on screen. */
  selectedText(): Promise<string> {
    return this.editor?.selectedText() ?? Promise.resolve('');
  }

  focus(): void {
    this.editor?.focus();
  }

  /** Puts text into the editor at the caret and goes there; nothing happens while it is not on screen. */
  insert(text: string, snippet = false): void {
    const editor = this.editor;
    if (!editor) return;
    void editor.insert(text, snippet).then(() => editor.focus());
  }

  runCurrent(): void {
    void this.editor?.runCurrent();
  }

  /** The caret goes to the place of the error that is marked in the text. */
  goToError(): void {
    this.editor?.goToError();
  }

  /** `*` at the caret → the columns it stands for; `false` when there is nothing to write out. */
  expandStar(): Promise<boolean> {
    return this.editor?.expandStar() ?? Promise.resolve(false);
  }

  runScript(): void {
    void this.editor?.runScript();
  }

  /** Formats in the editor; `nothing` while it is not on screen. Rejects when the text was refused. */
  format(mode: FormatMode, whole: boolean): Promise<FormatOutcome> {
    return this.editor?.format(mode, whole) ?? Promise.resolve('nothing');
  }

  toggleComment(): void {
    void this.editor?.toggleComment();
  }

  /** Runs one statement; `origin` says whether the user wrote it or the app (for the history). */
  run(sql: string, origin: 'user' | 'app' = 'user'): Promise<void> {
    return this.runAll([sql], origin);
  }

  /**
   * Runs statements one after the other on the tab's connection, opening it first when it is closed. After
   * an error the rest is left out, unless the setting says to go on. A run started while another runs takes
   * its place: the older one is stopped and its answers are dropped.
   */
  async runAll(
    statements: readonly string[],
    origin: 'user' | 'app' = 'user',
    /** Use the values given last without asking, as far as they are all there (prompt 025). */
    sameValues = false,
  ): Promise<void> {
    this.origin = origin;
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
    // what the connection guards is asked about once, for the whole run (prompt 012)
    const allowDangerous = options.allowDangerous ?? false;
    let tokens: (string | null)[] = [];
    this.runningOn = connection;
    /** Ends the run before a statement was sent. */
    const abandon = () => {
      this.runs.update((all) => all.map((r) => ({ ...r, kind: 'cancelled' as const })));
      this.runningOn = null;
      this.stopTimer();
      this.shown.set(0);
    };
    // parameters (prompt 025): the values are asked for once, for the whole run; from here on `sent` is
    // what the driver gets – the placeholders in the text, the values apart
    let sent: readonly BoundStatement[] | null = null;
    const params =
      origin === 'user' && this.services.params?.enabled() ? this.services.params : null;
    const dialect = this.dialectOf(connection);
    if (params) {
      const formsNow = () => formsOf(dialect, params.forms(connection));
      const bindAll = (values: Readonly<Record<string, ParamValue>>) => {
        const all: BoundStatement[] = [];
        for (const sql of sqls) {
          const bound = bind(sql, dialect, formsNow(), values);
          if (!bound.ok) return bound;
          all.push(bound.statement);
        }
        return all;
      };
      if (paramKeys(sqls, dialect, formsNow()).length > 0) {
        let values = this.paramValues();
        let bound = bindAll(values);
        if (!sameValues || !Array.isArray(bound)) {
          const answer = await params.ask({ connectionId: connection, dialect, sqls, values });
          if (!latest()) return;
          if (!answer) {
            abandon();
            return;
          }
          values = { ...values, ...answer };
          this.paramValues.set(values);
          bound = bindAll(values);
        }
        if (!Array.isArray(bound)) {
          // the dialog checks before it answers; this is for an answer from elsewhere
          this.services.notify?.(PARAM_TEXTS.notBound(bound.key));
          abandon();
          return;
        }
        sent = bound;
        const keysNow = (sql: string) => [
          ...new Set(findParams(sql, dialect, formsNow()).map((u) => u.key)),
        ];
        this.runs.update((all) =>
          all.map((r, i) => {
            const described = keysNow(sqls[i]).map((k) => describeValue(k, values[k]));
            return described.length > 0 ? { ...r, values: described.join(' · ') } : r;
          }),
        );
        this.lastStatements = statements;
      }
    }
    /** What goes to the backend for a statement: as written, or with the placeholders of the driver. */
    const texts = sent ? sent.map((s) => s.sql) : sqls;
    try {
      const verdicts = await this.services.api.check(connection, texts, allowDangerous);
      const guarded = needingConfirmation(sqls, verdicts);
      if (guarded.length > 0 && latest()) {
        const answer = await this.services.confirmRun?.(connection, guarded, sqls.length);
        if (!latest()) return;
        if (!answer) {
          // a no: nothing of the run happens
          abandon();
          return;
        }
        tokens = await this.services.api.confirm(
          connection,
          texts,
          answer.typedName,
          allowDangerous,
        );
      }
    } catch {
      // the check itself failed (unknown connection, wrong name): the run goes on and the backend, which
      // decides anyway, says why each statement does not run
      tokens = [];
    }
    if (!latest()) return;
    if (this.cancelledRun === id) {
      abandon();
      return;
    }
    let kept = 0;
    const succeeded: string[] = [];
    let stop: 'failed' | 'cancelled' | null = null;
    // the marks of the last run go; the statement that runs is shown in the text (prompt 022)
    let jumped = false;
    this.editor?.clearMarks();
    try {
      for (let index = 0; index < sqls.length && latest(); index++) {
        const sql = sqls[index];
        if (stop !== null) {
          set(index, { kind: stop === 'cancelled' ? 'cancelled' : 'skipped' });
          continue;
        }
        set(index, { kind: 'running' });
        this.editor?.markRunning(statements, index);
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
          const guard = {
            confirmation: tokens[index] ?? null,
            allowDangerous,
            session: this.id,
            manual: this.manual(),
            params: sent?.[index].params ?? [],
          };
          const outcome = await this.runOnce(
            connection,
            texts[index],
            options.timeoutMs,
            (event) => {
              // rows can be looked at while the rest is still read
              if (event.kind === 'rows') set(index, { rows: event.rows });
              else if (keep) set(index, { result: event, rows: 0 });
            },
            guard,
          );
          succeeded.push(sql);
          this.sawTx(outcome.tx, true);
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
          let error = toAppError(e);
          const bound = sent?.[index];
          if (bound && bound.replaced.length > 0 && error.details?.position) {
            // the database counted in the statement it got: back to the one that is written
            const position = writtenPosition(sql, bound, error.details.position);
            error = { ...error, details: { ...error.details, position } };
          }
          const elapsedMs = Date.now() - started;
          // the backend says whether the session survived; a lost one is opened again by the next run
          if (
            ![
              'invalid_query',
              'permission_denied',
              'confirmation_required',
              'cancelled',
              'timeout',
            ].includes(error.code)
          ) {
            connections.markClosed(connection);
          }
          const lost = ![
            'invalid_query',
            'permission_denied',
            'confirmation_required',
            'cancelled',
            'timeout',
          ].includes(error.code);
          if (lost && txOpen(this.tx())) {
            // the server rolled back what was open – or we cannot know
            this.sawTx('idle', false);
            this.services.notify?.(TABS_TEXTS.connectionLostInTx);
          } else if (!lost) {
            // a failed statement can poison the transaction (PostgreSQL): ask what the server says
            void this.services.api
              .txState(connection, this.id)
              .then((tx) => latest() && this.sawTx(tx, true))
              .catch(() => undefined);
          }
          // a statement that did not end well leaves no result behind (the backend freed it)
          set(index, { result: null, rows: null });
          if (error.code === 'cancelled') {
            set(index, { kind: 'cancelled', elapsedMs });
            stop = 'cancelled';
          } else {
            set(index, {
              kind: 'failed',
              message: describeError(error),
              details: error.details ?? null,
              elapsedMs,
            });
            // the place in the text: the first failure of a run takes the caret there
            if (latest()) {
              this.editor?.markError(
                statements,
                index,
                describeError(error),
                error.details ?? null,
                !jumped,
              );
              jumped = true;
            }
            if (options.stopOnError) stop = 'failed';
          }
        }
        if (latest()) this.note(index, started);
      }
    } finally {
      if (latest()) this.editor?.markRunning(statements, null);
      if (succeeded.length > 0) this.services.ran?.(connection, succeeded);
      if (latest()) {
        this.runningOn = null;
        this.stopTimer();
        this.showFirstOfInterest();
      }
    }
  }

  /**
   * Runs the statements of the last run that had parameters again, with the same values and without a
   * question (prompt 025). `false`: there is nothing to run again.
   */
  runAgain(): boolean {
    const statements = this.lastStatements;
    if (!statements) return false;
    void this.runAll(statements, 'user', true);
    return true;
  }

  /** The database of a connection, for the rules its statements are read by. */
  private dialectOf(connection: string): Dialect {
    const kind = this.services.connections.profiles().find((p) => p.id === connection)?.kind;
    return (kind ?? 'sqlite') as Dialect;
  }

  /** Asks the backend to stop the statement that runs. */
  cancel(): void {
    // a run that is still being checked has nothing on the server yet: it ends before it starts
    this.cancelledRun = this.runId;
    if (this.runningOn !== null) {
      void this.services.api.cancel(this.runningOn, this.id).catch(() => undefined);
    }
  }

  /** The connection was open in the store but the backend lost it: open it again, once. */
  private async runOnce(
    connection: string,
    sql: string,
    timeoutMs: number,
    onEvent: (event: RunEvent) => void,
    guard: RunGuard,
  ): Promise<RunOutcome> {
    const { api, connections } = this.services;
    try {
      return await api.run(connection, sql, timeoutMs, onEvent, guard);
    } catch (e) {
      if (toAppError(e).code !== 'not_connected') throw e;
      connections.markClosed(connection);
      if (!(await connections.connect(connection))) throw e;
      return api.run(connection, sql, timeoutMs, onEvent, guard);
    }
  }

  /** The tab goes: its statement is stopped and its results leave the store. */
  /** Takes note of what the server says about the transaction; `counted`: a statement ran in it. */
  private sawTx(tx: TxState, counted: boolean): void {
    const was = txOpen(this.tx());
    const now = txOpen(tx);
    if (now && !was) {
      this.txSince.set(Date.now());
      this.txStatements.set(counted ? 1 : 0);
    } else if (now && counted) {
      this.txStatements.update((n) => n + 1);
    } else if (!now) {
      this.txSince.set(null);
      this.txStatements.set(0);
    }
    this.tx.set(tx);
  }

  /**
   * Ends the transaction of this tab with `COMMIT` or `ROLLBACK`. Resolves with `null` when it worked,
   * else with what the server said.
   */
  async endTransaction(commit: boolean): Promise<string | null> {
    try {
      const tx = await this.services.api.endTransaction(this.connectionId(), this.id, commit);
      this.sawTx(tx, false);
      this.log.update((all) =>
        [
          ...all,
          {
            at: Date.now(),
            kind: 'info' as const,
            sql: commit ? 'COMMIT' : 'ROLLBACK',
            text: commit ? TABS_TEXTS.txCommitted : TABS_TEXTS.txRolledBack,
            elapsedMs: null,
          },
        ].slice(-MAX_LOG),
      );
      return null;
    } catch (e) {
      const error = toAppError(e);
      void this.services.api
        .txState(this.connectionId(), this.id)
        .then((tx) => this.sawTx(tx, false))
        .catch(() => undefined);
      return describeError(error);
    }
  }

  /** The tab moves to another connection: its session there starts without a transaction. */
  leaveSession(): void {
    void this.services.api.closeSession(this.connectionId(), this.id).catch(() => undefined);
    this.sawTx('idle', false);
  }

  dispose(): void {
    this.cancel();
    // the session of the tab goes; the server rolls back what was open on it
    void this.services.api.closeSession(this.connectionId(), this.id).catch(() => undefined);
    this.sawTx('idle', false);
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
      values: run.values ?? null,
    };
    this.log.update((all) => [...all, entry].slice(-MAX_LOG));
    if (run.kind === 'done' || run.kind === 'failed' || run.kind === 'cancelled') {
      this.services.record?.({
        at: started,
        connectionId: this.connectionId(),
        sql: run.sql,
        elapsedMs: run.elapsedMs ?? 0,
        rows: run.rowsAffected ?? run.rows,
        outcome: run.kind === 'done' ? 'ok' : run.kind,
        message: run.kind === 'failed' ? run.message : null,
        tab: this.id,
        origin: this.origin,
      });
    }
  }

  /** Replaces the text of the editor (recall from the history). */
  async setText(text: string): Promise<void> {
    await this.editor?.setText(text);
    this.editor?.focus();
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
