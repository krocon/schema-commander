import {
  BuiltQuery,
  CompareSpec,
  QueryColumn,
  ResultRef,
  ViewSpec,
} from '../../core/sql/query.models';
import { EMPTY_BUFFER, EditBuffer, editCount } from '../edit/edit-buffer';
import { ResultFind } from '../find/result-find';
import { EMPTY_NAV, NavState, navReplace } from '../relations/relation-logic';
import { ColumnLayout, EMPTY_LAYOUT, ResultGridHandle } from '../results/column-layout';
import {
  EMPTY_VIEW,
  QuickFilter,
  TableSpec,
  TableView,
  isLocal,
  queryOf,
  quickCondition,
  withCondition,
} from '../filter/filter-logic';
import { Dialect } from '../editor/sql-split';
import {
  BoundStatement,
  ParamValue,
  bind,
  describeValue,
  findParams,
  formsOf,
  inPlace,
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
import { Signal, computed, signal } from '@angular/core';
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
import { ChartSpec } from '../../core/chart/chart-api';
import { ChartOptions, DEFAULT_OPTIONS } from '../chart/chart-logic';
import {
  KeptKey,
  KeptResult,
  Shown,
  afterClose,
  compareRun,
  isKept,
  keptOverRun,
  nextKey,
  storeIds,
  subTabs,
} from './result-tabs-logic';

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
  /** The selection, else the statement under the caret (prompt 039); `''`: none. */
  currentStatement?(): Promise<string>;
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
  /**
   * The rows of the tab are about to be read anew while it has changes that are not written (prompt 031):
   * asks whether they may go. `false`: the run does not happen. Without it, changes are dropped silently.
   */
  readonly dropEdits?: (tab: QueryTab) => Promise<boolean>;
  /** A table view was applied on a connection (its filter is remembered for the table). */
  readonly tableApplied?: (connection: string, view: TableView) => void;
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
  /** The results of a run stay when the next one starts, each in a tab of its own (prompt 041). */
  readonly keepResults?: boolean;
}

/** A result of a tab that can be compared with another one. */
export interface Comparable {
  readonly target: Shown;
  readonly title: string;
  readonly result: ResultRef;
  readonly rows: number;
}

/** Ids of the jobs that work out local views: far from those of exports and of the formatter. */
let nextViewJob = 2_000_000_000;
/** Ids of the jobs that compare results (prompt 041). */
let nextCompareJob = 7_000_000_000;

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
  /** Changes to cells of the table view that are not written yet (prompt 031). */
  readonly edits = signal<EditBuffer>(EMPTY_BUFFER);
  /** The table views the user came along in this tab, following foreign keys (prompt 030). */
  readonly nav = signal<NavState>(EMPTY_NAV);
  /** Searching in the result of this tab (prompt 029). */
  readonly find: ResultFind;
  /** How the columns of the results of this tab are laid out; a table view has a layout of its table. */
  readonly columnLayout = signal<ColumnLayout>(EMPTY_LAYOUT);
  /** The grid that shows the result of this tab, while there is one: to move its cursor from outside. */
  grid: ResultGridHandle | null = null;
  /** The table this tab shows as a table (prompt 027); `null` = an ordinary query tab. */
  private readonly ownTable = signal<TableView | null>(null);
  /**
   * Read: `null` also while a kept result is on screen (prompt 041) – that is a plain result, and nothing
   * that belongs to the table (editing, keys, its filter) may touch it.
   */
  readonly tableView: Signal<TableView | null> & { set(view: TableView | null): void } =
    Object.assign(
      computed(() => (isKept(this.shown()) ? null : this.ownTable())),
      { set: (view: TableView | null) => this.ownTable.set(view) },
    );
  /** How the result on screen is looked at locally, and the view of the store that shows it. */
  readonly localSpec = signal<ViewSpec>(EMPTY_VIEW);
  readonly localView = signal<{ base: number; resultId: number; rows: number } | null>(null);
  readonly viewBusy = signal(false);
  readonly viewProblem = signal<string | null>(null);
  private viewJob: number | null = null;
  readonly encoding = signal<string | null>(null);

  /** The statements of the last run (one statement, a selection or a script) and how they went. */
  readonly runs = signal<readonly StatementRun[]>([]);
  /** The result area shows a chart of the result instead of its table (prompt 042). */
  readonly chartOpen = signal(false);
  /** What of the result the chart shows; `null`: the backend suggests it from the columns. */
  readonly chartSpec = signal<ChartSpec | null>(null);
  readonly chartOptions = signal<ChartOptions>(DEFAULT_OPTIONS);
  /** Results that outlive a run (prompt 041): pinned ones and the outcomes of comparisons. */
  readonly kept = signal<readonly KeptResult[]>([]);
  private lastKey = 0;
  /** What the result area shows: a statement of the run, a kept result, or the messages. */
  readonly shown = signal<Shown>(0);
  /** The statement whose outcome is on screen; `undefined` for the messages or when there is none. */
  readonly shownRun = computed<StatementRun | undefined>(() => {
    const shown = this.shown();
    if (shown === 'messages') return this.runs()[0];
    if (isKept(shown)) return this.kept().find((k) => k.key === shown)?.run;
    return this.runs()[shown];
  });
  /** The kept result on screen, if it is one. */
  readonly shownKept = computed<KeptResult | null>(() => {
    const shown = this.shown();
    return isKept(shown) ? (this.kept().find((k) => k.key === shown) ?? null) : null;
  });
  /** The sub-tabs of the result area, without the messages. */
  readonly subTabs = computed(() => subTabs(this.runs(), this.kept(), TABS_TEXTS.compareTitle));
  /** How far the comparison is that runs; `null` = none runs. */
  readonly comparing = signal<{ readonly done: number; readonly of: number } | null>(null);
  readonly compareProblem = signal<string | null>(null);
  private compareJob: number | null = null;
  /** What the tab ran so far, the newest last. */
  readonly log = signal<readonly LogEntry[]>([]);
  /** How long the run takes so far (ticks while it runs). */
  readonly elapsedMs = signal(0);
  /** The outcome of the statement shown. */
  readonly state = computed<RunState>(() => stateOf(this.shownRun()));
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
    this.find = new ResultFind(services.api);
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

  /** The selection, else the statement under the caret; `''` without an editor or a statement. */
  currentStatement(): Promise<string> {
    return this.editor?.currentStatement?.() ?? Promise.resolve('');
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
    /**
     * What the driver gets instead of the statements as written: the statement of a table view with its
     * placeholders and values (prompt 027). The statements themselves are then only what is shown.
     */
    prebuilt: readonly BoundStatement[] | null = null,
  ): Promise<void> {
    // no extra turn where there is nothing to lose: a run starts at once, as ever
    if (this.hasEdits() && !(await this.mayDropEdits())) return;
    this.origin = origin;
    // any other run ends the table view: the text in the editor is the user's again
    if (!prebuilt) this.tableView.set(null);
    this.dropLocal();
    const sqls = statements.filter((s) => s.trim() !== '');
    if (sqls.length === 0) return;
    const { connections } = this.services;
    if (this.running()) this.cancel();
    const id = ++this.runId;
    const latest = () => id === this.runId;
    const connection = this.connectionId();
    const options = this.services.options();
    this.clearForRun(options.keepResults ?? false);
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
    let sent: readonly BoundStatement[] | null = prebuilt;
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
        const usesNow = (sql: string) => {
          const first = new Map<string, boolean>();
          for (const u of findParams(sql, dialect, formsNow())) {
            if (!first.has(u.key)) first.set(u.key, u.list);
          }
          return [...first];
        };
        this.runs.update((all) =>
          all.map((r, i) => {
            const described = usesNow(sqls[i]).map(([k, list]) =>
              describeValue(k, inPlace(values[k], list)),
            );
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
   * Shows a table as a table (prompt 027): the app writes its `SELECT`. `built` is the statement for
   * `view`, if the caller has it already (the text of a new tab is its readable form).
   */
  async openTable(view: TableView, built?: BuiltQuery): Promise<void> {
    // asked before the tab shows anything else: a no leaves it exactly where it is
    // no extra turn where there is nothing to lose: a run starts at once, as ever
    if (this.hasEdits() && !(await this.mayDropEdits())) return;
    this.tableView.set(view);
    await this.runTable(view, built ?? null);
  }

  /**
   * Rows read anew would leave changes that are not written without their rows (prompt 031): the user
   * says whether they may go. `true`: there are none (any more). Asked before anything of the tab changes.
   */
  /** Whether the tab holds anything of a change buffer (changes, or only steps of undo). */
  private hasEdits(): boolean {
    return this.edits() !== EMPTY_BUFFER;
  }

  private async mayDropEdits(): Promise<boolean> {
    if (editCount(this.edits()).total === 0) {
      // nothing to lose; steps of undo that lead to no change go with the rows
      if (this.edits() !== EMPTY_BUFFER) this.edits.set(EMPTY_BUFFER);
      return true;
    }
    if (this.services.dropEdits && !(await this.services.dropEdits(this))) return false;
    this.edits.set(EMPTY_BUFFER);
    return true;
  }

  /** Filters, orders or limits the table view anew and reads it again. */
  async applyTable(spec: TableSpec): Promise<void> {
    const view = this.tableView();
    if (!view) return;
    await this.runTable({ ...view, spec }, null);
  }

  private async runTable(view: TableView, known: BuiltQuery | null): Promise<void> {
    // no extra turn where there is nothing to lose: a run starts at once, as ever
    if (this.hasEdits() && !(await this.mayDropEdits())) return;
    const connection = this.connectionId();
    let built = known;
    if (!built) {
      try {
        built = await this.services.api.tableQuery(connection, queryOf(view));
      } catch (e) {
        // a condition the backend refuses: nothing runs, the view stays as it was
        this.services.notify?.(describeError(e));
        return;
      }
      // the statement is shown where statements are: in the editor, to read and to go on with
      await this.editor?.setText(built.display);
    }
    this.services.tableApplied?.(connection, view);
    const run = this.runAll([built.display], 'app', false, [
      { sql: built.sql, params: built.params, replaced: [] },
    ]);
    // the run has started: from here on the tab shows this view
    this.tableView.set(view);
    // the place on the path shows this filter now (another table without the path ends the path)
    this.nav.update((nav) => navReplace(nav, view));
    await run;
  }

  /**
   * Adds a condition from a cell of the table view (prompt 027). `false`: there is no table view, the
   * cell is not one of it, or its value is none to filter by (too long, binary).
   */
  async quickFilter(
    quick: QuickFilter,
    cell: { resultId: number; row: number; col: number; column: QueryColumn },
  ): Promise<boolean> {
    const view = this.tableView();
    if (!view) return false;
    let value: string | null = null;
    if (quick !== 'null') {
      const part = await this.services.api.cellValue(cell.resultId, cell.row, cell.col, 0, 4096);
      if (part.kind === 'null') value = null;
      else if (part.kind !== 'text' || part.to < part.total) return false;
      else value = part.text ?? '';
    }
    const condition = quickCondition(quick, cell.column, value);
    if (!condition) return false;
    await this.applyTable(withCondition(view.spec, condition));
    return true;
  }

  /**
   * Looks at the result on screen through a text filter and in an order (prompt 027) – in the store of
   * the backend; the query is not run again. An empty spec shows the result as it is.
   */
  async setLocal(spec: ViewSpec): Promise<void> {
    const state = this.state();
    const base =
      state.kind === 'done' || state.kind === 'running' ? (state.result?.resultId ?? null) : null;
    this.localSpec.set(spec);
    this.viewProblem.set(null);
    const before = this.localView();
    // what is still being worked out for an older spec is not wanted any more
    if (this.viewJob !== null)
      void this.services.api.cancelView(this.viewJob).catch(() => undefined);
    this.viewJob = null;
    if (base === null || !isLocal(spec)) {
      this.localView.set(null);
      this.viewBusy.set(false);
      if (before) this.free([before.resultId]);
      return;
    }
    const job = nextViewJob++;
    this.viewJob = job;
    this.viewBusy.set(true);
    try {
      const viewed = await this.services.api.resultView(job, base, spec);
      if (this.viewJob !== job) {
        this.free([viewed.resultId]);
        return;
      }
      this.localView.set({ base, resultId: viewed.resultId, rows: viewed.rows });
      if (before) this.free([before.resultId]);
    } catch (e) {
      if (this.viewJob !== job) return;
      if (toAppError(e).code !== 'cancelled') this.viewProblem.set(describeError(e));
    } finally {
      if (this.viewJob === job) {
        this.viewJob = null;
        this.viewBusy.set(false);
      }
    }
  }

  /** Shows the result as it is again (another result, another run). */
  dropLocal(): void {
    if (this.viewJob !== null)
      void this.services.api.cancelView(this.viewJob).catch(() => undefined);
    this.viewJob = null;
    const before = this.localView();
    if (before) this.free([before.resultId]);
    this.localView.set(null);
    this.localSpec.set(EMPTY_VIEW);
    this.viewBusy.set(false);
    this.viewProblem.set(null);
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
    this.cancelCompare();
    this.freeAll();
    this.free(this.kept().flatMap(storeIds));
    this.kept.set([]);
    this.runs.set([]);
  }

  /** Shows a sub-tab; what was looked at locally (filter, order) belongs to the result that goes. */
  show(target: Shown): void {
    if (this.shown() === target) return;
    this.dropLocal();
    this.shown.set(target);
  }

  /**
   * Before a run: the results of the last one go – unless every run gets new tabs, then they are kept
   * (not pinned, the oldest beyond the limit go). Kept results that are not pinned go with them.
   */
  private clearForRun(keepAll: boolean): void {
    let kept = this.kept();
    if (keepAll && !this.ownTable()) {
      this.runs().forEach((run) => {
        if (run.kind !== 'done' || !run.result) return;
        const key = nextKey(kept, this.lastKey++);
        kept = [...kept, { key, title: run.title ?? null, pinned: false, run }];
      });
    } else {
      this.freeAll();
    }
    const over = keptOverRun(kept, keepAll);
    this.free(over.dropped.flatMap(storeIds));
    this.kept.set(over.kept);
  }

  /** Whether the result of a sub-tab can be pinned: a finished statement with rows, not a table view. */
  canPin(target: Shown = this.shown()): boolean {
    if (isKept(target)) return this.kept().some((k) => k.key === target);
    if (target === 'messages' || this.ownTable()) return false;
    const run = this.runs()[target];
    return run?.kind === 'done' && !!run.result;
  }

  isPinned(target: Shown = this.shown()): boolean {
    return isKept(target) && (this.kept().find((k) => k.key === target)?.pinned ?? false);
  }

  /**
   * Keeps the result of a statement of the last run beyond the run: it gets a tab of its own, and the
   * statement of the run none any more. Answers with the key of the kept result.
   */
  keep(index: number, pinned = true): KeptKey | null {
    if (!this.canPin(index)) return null;
    const run = this.runs()[index];
    const key = nextKey(this.kept(), this.lastKey++);
    const wasShown = this.shown() === index;
    this.kept.update((all) => [...all, { key, title: run.title ?? null, pinned, run }]);
    this.runs.update((all) =>
      all.map((r, i) => (i === index ? { ...r, result: null, moved: true } : r)),
    );
    // the same result stays on screen: nothing local is dropped
    if (wasShown) this.shown.set(key);
    return key;
  }

  /** Pins the result of a sub-tab, or lets it go again with the next run. */
  togglePin(target: Shown = this.shown()): void {
    if (isKept(target)) {
      this.kept.update((all) =>
        all.map((k) => (k.key === target ? { ...k, pinned: !k.pinned } : k)),
      );
    } else if (target !== 'messages') {
      this.keep(target);
    }
  }

  /** Closes a kept result: it leaves the store. */
  closeKept(key: KeptKey): void {
    const gone = this.kept().find((k) => k.key === key);
    if (!gone) return;
    const next = afterClose(this.subTabs(), key);
    if (this.shown() === key) this.show(next);
    this.kept.update((all) => all.filter((k) => k.key !== key));
    this.free(storeIds(gone));
  }

  /** Closes every kept result that is not pinned (`all`: the pinned ones too). */
  closeKeptAll(all = false): void {
    for (const k of this.kept()) if (all || !k.pinned) this.closeKept(k.key);
  }

  /** Takes a kept result out of the tab without freeing it (it goes to another tab). */
  release(key: KeptKey): KeptResult | null {
    const gone = this.kept().find((k) => k.key === key);
    if (!gone) return null;
    const next = afterClose(this.subTabs(), key);
    if (this.shown() === key) this.show(next);
    this.kept.update((all) => all.filter((k) => k.key !== key));
    return gone;
  }

  /** Takes a kept result of another tab over and shows it. */
  adopt(kept: KeptResult): void {
    const key = nextKey(this.kept(), this.lastKey++);
    this.kept.update((all) => [...all, { ...kept, key, pinned: true }]);
    this.show(key);
  }

  /** Names the result of a sub-tab; an empty name gives it the one of its statement back. */
  renameResult(target: Shown, raw: string): void {
    const title = raw.trim().slice(0, 80) || null;
    if (isKept(target)) {
      this.kept.update((all) => all.map((k) => (k.key === target ? { ...k, title } : k)));
    } else if (target !== 'messages') {
      this.runs.update((all) => all.map((r, i) => (i === target ? { ...r, title } : r)));
    }
  }

  /** The results of this tab that can be compared: of finished statements and kept ones, no comparisons. */
  comparable(): Comparable[] {
    const out: Comparable[] = [];
    const titles = new Map(this.subTabs().map((t) => [t.target, t.title]));
    for (const k of this.kept()) {
      if (k.compare || !k.run.result) continue;
      out.push({
        target: k.key,
        title: titles.get(k.key) ?? '',
        result: k.run.result,
        rows: k.run.rows ?? 0,
      });
    }
    this.runs().forEach((run, index) => {
      if (run.kind !== 'done' || !run.result || this.ownTable()) return;
      out.push({
        target: index,
        title: `${index + 1}: ${titles.get(index) ?? ''}`,
        result: run.result,
        rows: run.rows ?? 0,
      });
    });
    return out;
  }

  /**
   * Compares two results of this tab in the store of the backend (prompt 041); the outcome becomes a kept
   * result of its own and is shown. `false`: it failed (`compareProblem` says why) or was stopped.
   */
  async compare(spec: CompareSpec, leftTitle: string, rightTitle: string): Promise<boolean> {
    this.cancelCompare();
    const job = nextCompareJob++;
    this.compareJob = job;
    this.compareProblem.set(null);
    this.comparing.set({ done: 0, of: 0 });
    try {
      const report = await this.services.api.resultCompare(job, spec, (done, of) => {
        if (this.compareJob === job) this.comparing.set({ done, of });
      });
      if (this.compareJob !== job) {
        // stopped meanwhile, or the tab is gone: nobody looks at it
        this.free([report.resultId]);
        return false;
      }
      const view = { report, onlyDifferences: report.diffRows > 0, leftTitle, rightTitle };
      const key = nextKey(this.kept(), this.lastKey++);
      this.kept.update((all) => [
        ...all,
        { key, title: null, pinned: true, run: compareRun('', view), compare: view },
      ]);
      this.show(key);
      return true;
    } catch (e) {
      if (this.compareJob === job && toAppError(e).code !== 'cancelled') {
        this.compareProblem.set(describeError(e));
      }
      return false;
    } finally {
      if (this.compareJob === job) {
        this.compareJob = null;
        this.comparing.set(null);
      }
    }
  }

  cancelCompare(): void {
    const job = this.compareJob;
    if (job === null) return;
    this.compareJob = null;
    this.comparing.set(null);
    void this.services.api.cancelCompare(job).catch(() => undefined);
  }

  /** A comparison shows all rows, or only those that differ. */
  setOnlyDifferences(key: KeptKey, only: boolean): void {
    this.dropLocal();
    this.kept.update((all) =>
      all.map((k) => {
        if (k.key !== key || !k.compare) return k;
        const compare = { ...k.compare, onlyDifferences: only };
        return { ...k, compare, run: compareRun(k.run.sql, compare) };
      }),
    );
  }

  /** The cursor of the grid goes to the next (or the one before) row of a comparison that differs. */
  async nextDifference(forward: boolean): Promise<boolean> {
    const compare = this.shownKept()?.compare;
    const grid = this.grid;
    if (!compare || !grid) return false;
    const at = grid.cursor()?.[0] ?? (forward ? -1 : compare.report.rows);
    if (this.localView()) return false;
    if (compare.onlyDifferences) {
      // every row differs: the next one is the next one
      const next = at + (forward ? 1 : -1);
      if (next < 0 || next >= compare.report.diffRows) return false;
      grid.goTo(next, null);
      return true;
    }
    const { diffId } = compare.report;
    const ask = (row: number, onward: boolean) =>
      this.services.api.resultNeighbour(diffId, row, onward);
    // without a cursor the search starts at the top: row 0 itself may differ
    const found = at < 0 ? ((await ask(1, false)) ?? (await ask(0, true))) : await ask(at, forward);
    if (!found) return false;
    grid.goTo(found[1], null);
    return true;
  }

  /**
   * Keeps the result on screen and runs its statement again (prompt 041): answers with the two results
   * to compare – the old one and the new one. `null`: there is nothing to run again, or the run failed.
   */
  async runAgainToCompare(): Promise<{ left: Comparable; right: Comparable } | null> {
    if (this.ownTable() || this.running()) return null;
    const shown = this.shown();
    let oldKey: KeptKey | null;
    let index: number;
    let statements: string[];
    if (isKept(shown)) {
      const kept = this.shownKept();
      if (!kept || kept.compare || !kept.run.sql.trim()) return null;
      oldKey = shown;
      index = 0;
      statements = [kept.run.sql];
      // the old result must outlive the run
      if (!kept.pinned) this.togglePin(shown);
    } else if (shown !== 'messages' && this.canPin(shown)) {
      index = shown;
      statements = this.runs().map((r) => r.sql);
      oldKey = this.keep(shown);
    } else {
      return null;
    }
    if (!oldKey) return null;
    await this.runAll(statements, 'user', true);
    const all = this.comparable();
    const left = all.find((c) => c.target === oldKey);
    const right = all.find((c) => c.target === index);
    if (!left || !right) return null;
    this.show(index);
    return { left, right };
  }

  /** Rows `from..from + count` of a result of this tab. */
  window(resultId: number, from: number, count: number): Promise<RowWindow> {
    return this.services.api.window(resultId, from, count);
  }

  /** The results of the last run leave the store of the backend. */
  private freeAll(): void {
    this.free(this.runs().flatMap((r) => (r.result ? [r.result.resultId] : [])));
  }

  /** What the kept results of this tab take in the store, in bytes. */
  async keptBytes(): Promise<number> {
    const ids = this.kept().flatMap(storeIds);
    if (ids.length === 0) return 0;
    const usage = await this.services.api.resultUsage(ids).catch(() => []);
    return usage.reduce((sum, u) => sum + u.bytes, 0);
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
