import {
  Access,
  AccessApi,
  AccessChange,
  AccessPlan,
  GrantList,
  Who,
} from '../app/core/access/access-api';
import { MonitorApi, ServerActivity } from '../app/core/monitor/monitor-api';
import {
  TransferApi,
  TransferEvent,
  TransferPlan,
  TransferReport,
  TransferRequest,
} from '../app/core/transfer/transfer-api';
import {
  BackupApi,
  BackupDone,
  BackupFileKind,
  BackupInfo,
  DumpSpec,
  RestoreSpec,
  ToolPaths,
} from '../app/core/backup/backup-api';
import {
  StructPlan,
  StructRan,
  StructRequest,
  StructureApi,
  TableDef,
} from '../app/core/structure/structure-api';
import { ChartApi, ChartData, ChartSpec } from '../app/core/chart/chart-api';
import {
  SavedApi,
  SavedEntry,
  SavedListing,
  SavedMeta,
  SavedQuery,
} from '../app/core/saved/saved-api';
import { FormatApi, FormatDialect, FormatMode, FormatStyle } from '../app/core/format/format-api';
import { AboutApi, AppInfo } from '../app/core/about/about-api';
import { ExportApi, ExportSpec, Exported } from '../app/core/backend/export-api';
import { Plan, PlanApi } from '../app/core/plan/plan-api';
import {
  CompareApi,
  CompareItem,
  SchemaRename,
  SchemaSnapshot,
} from '../app/core/compare/compare-api';
import { FindApi, FindEvent, FindReport, FindSpec } from '../app/core/find/find-api';
import {
  DataImportApi,
  Guess,
  FilePreview,
  LoadPlan,
  Loaded,
  SourceOptions,
} from '../app/core/import/data-import-api';
import {
  Capabilities,
  ConnectionInfo,
  ImportItem,
  ImportPick,
  ImportPreview,
  ImportSource,
  LoadedProfiles as LoadedConnections,
  Profile,
  SshCredentials,
  SshHost,
  UrlDraft,
} from '../app/core/connections/connection.models';
import {
  ClipboardApi,
  Copied,
  CopyFormat,
  CopyOptions,
  CopySelection,
} from '../app/core/backend/clipboard-api';
import {
  HistoryApi,
  HistoryEntry,
  HistoryFilter,
  HistoryKeep,
  HistoryPage,
  HistoryScope,
  NewHistoryEntry,
} from '../app/core/history/history-api';
import { ConnectionsApi } from '../app/core/connections/connections-api';
import { LoadedSession, SessionApi, SessionFile, TextFile } from '../app/core/session/session-api';
import { QueryApi, RunGuard } from '../app/core/sql/query-api';
import { SchemaApi } from '../app/core/schema/schema-api';
import {
  DiagramData,
  Found,
  NameContext,
  NameHit,
  NameHits,
  ObjectDetails,
  ObjectInfo,
  SchemaInfo,
  TableInfo,
  TableRelations,
} from '../app/core/schema/schema.models';
import {
  BoundValue,
  BuiltQuery,
  Cell,
  CellValuePart,
  ImageInfo,
  QueryColumn,
  RowWindow,
  RunEvent,
  RunOutcome,
  TableQuery,
  TxState,
  Verdict,
  ViewSpec,
  Applied,
  EditCell,
  EditSet,
  EditStep,
  ResultStats,
  UpdatePlan,
  SearchFound,
  SearchSpec,
  SeekKind,
  ViewedResult,
  ColumnPairing,
  CompareReport,
  CompareSpec,
  ResultUsage,
} from '../app/core/sql/query.models';
import { FileDialogApi } from '../app/core/backend/file-dialog-api';
import { WindowApi } from '../app/core/backend/window-api';
import { LoadedThemes, ThemeApi } from '../app/core/theme/theme-api';
import { Theme } from '../app/core/theme/theme.models';

/** Records the frames it was asked for. */
export class FakeWindowApi extends WindowApi {
  readonly calls: { color: string; dark: boolean | null }[] = [];

  setWindowChrome(color: string, dark: boolean | null): Promise<void> {
    this.calls.push({ color, dark });
    return Promise.resolve();
  }
}

/**
 * Answers every statement with `rows` of `columns` (kept as a result that windows can be read of), or rejects
 * with `error` when set.
 */
export class FakeQueryApi extends QueryApi {
  readonly statements: { connection: string; sql: string }[] = [];
  readonly cancelled: string[] = [];
  /** Outcomes of the next calls, the first one first (`null` = success); then `error`, then the rows. */
  readonly errors: unknown[] = [];
  error: unknown = null;
  columns: QueryColumn[] = [
    { name: 'id', kind: 'int', typeName: 'INTEGER' },
    { name: 'name', kind: 'text', typeName: 'TEXT' },
  ];
  rows: Cell[][] = [
    [1, 'Ada'],
    [2, null],
  ];
  /** Set for a statement without a result. */
  rowsAffected: number | null = null;
  truncated = false;
  /** The time limits the statements were sent with. */
  readonly timeouts: number[] = [];
  /** The results in the store by id. */
  readonly results = new Map<number, Cell[][]>();
  readonly freed: number[] = [];
  readonly windows: { resultId: number; from: number; count: number }[] = [];
  private nextId = 1;

  /** What `check` says about a statement; the default lets everything run. */
  verdict: (sql: string) => Verdict = () => ({ class: 'read', need: 'nothing' });
  /** The name `confirm` wants typed for `type_name`. */
  connectionName = 'Demo';
  readonly confirmed: { sqls: readonly string[]; typedName: string | null }[] = [];
  /** The confirmation each statement ran with. */
  readonly tokens: (string | null)[] = [];

  check(_connection: string, sqls: readonly string[]): Promise<Verdict[]> {
    return Promise.resolve(sqls.map((sql) => this.verdict(sql)));
  }

  confirm(
    _connection: string,
    sqls: readonly string[],
    typedName: string | null,
  ): Promise<(string | null)[]> {
    this.confirmed.push({ sqls, typedName });
    const verdicts = sqls.map((sql) => this.verdict(sql));
    if (verdicts.some((v) => v.need === 'type_name') && typedName !== this.connectionName) {
      return Promise.reject({ code: 'confirmation_required', message: 'name not typed' });
    }
    return Promise.resolve(
      verdicts.map((v, i) => (v.need === 'nothing' ? null : `token-${i}-${sqls[i].length}`)),
    );
  }

  run(
    connection: string,
    sql: string,
    timeoutMs = 0,
    onEvent?: (event: RunEvent) => void,
    guard: RunGuard = {},
  ): Promise<RunOutcome> {
    this.statements.push({ connection, sql });
    this.tokens.push(guard.confirmation ?? null);
    this.sessions.push({ session: guard.session ?? null, manual: guard.manual ?? false });
    this.params.push(guard.params ?? []);
    const need = this.verdict(sql).need;
    if (need === 'refused') {
      return Promise.reject({ code: 'permission_denied', message: 'this connection is read only' });
    }
    if (need !== 'nothing' && !guard.confirmation) {
      return Promise.reject({ code: 'confirmation_required', message: 'needs a confirmation' });
    }
    this.timeouts.push(timeoutMs);
    // `null` in `errors` = this call succeeds
    const next = this.errors.length > 0 ? this.errors.shift() : this.error;
    if (next) return Promise.reject(next);
    if (this.rowsAffected !== null) {
      return Promise.resolve({
        resultId: null,
        columns: [],
        rows: 0,
        truncated: false,
        rowsAffected: this.rowsAffected,
        elapsedMs: 3,
        tx: this.tx,
      });
    }
    const resultId = this.nextId++;
    this.results.set(resultId, this.rows);
    onEvent?.({ kind: 'started', resultId, columns: this.columns });
    onEvent?.({ kind: 'rows', rows: this.rows.length });
    return Promise.resolve({
      resultId,
      columns: this.columns,
      rows: this.rows.length,
      truncated: this.truncated,
      rowsAffected: null,
      elapsedMs: 3,
      tx: this.tx,
    });
  }

  cancel(connection: string): Promise<void> {
    this.cancelled.push(connection);
    return Promise.resolve();
  }

  /** What the "server" says about the transaction after the next statements. */
  tx: TxState = 'idle';
  readonly ended: { connection: string; session: string; commit: boolean }[] = [];
  readonly closedSessions: string[] = [];
  /** The session and mode each statement ran with. */
  readonly sessions: { session: string | null; manual: boolean }[] = [];
  /** The values bound to each statement that ran (prompt 025). */
  readonly params: (readonly BoundValue[])[] = [];

  endTransaction(connection: string, session: string, commit: boolean): Promise<TxState> {
    this.ended.push({ connection, session, commit });
    if (this.error) return Promise.reject(this.error);
    this.tx = 'idle';
    return Promise.resolve(this.tx);
  }

  txState(): Promise<TxState> {
    return Promise.resolve(this.tx);
  }

  closeSession(_connection: string, session: string): Promise<void> {
    this.closedSessions.push(session);
    return Promise.resolve();
  }

  window(resultId: number, from: number, count: number): Promise<RowWindow> {
    this.windows.push({ resultId, from, count });
    const rows = this.results.get(resultId);
    return rows
      ? Promise.resolve(rows.slice(from, from + count))
      : Promise.reject({ code: 'unknown_result', message: `no result ${resultId}` });
  }

  free(resultIds: readonly number[]): Promise<void> {
    for (const id of resultIds) {
      this.results.delete(id);
      this.freed.push(id);
    }
    return Promise.resolve();
  }

  /**
   * Whole values of cells by `resultId:row:col` (prompt 026). Texts here are counted in characters, not
   * bytes – fine for texts of one byte per character. A cell without an entry is NULL.
   */
  readonly values = new Map<
    string,
    { text?: string; bytes?: Uint8Array; image?: ImageInfo; unreadable?: string }
  >();
  readonly valueCalls: { resultId: number; row: number; col: number; from: number; max: number }[] =
    [];
  /** Answers to `cellValue` wait for this (to let a later question overtake an earlier one). */
  valueGate: Promise<void> | null = null;
  readonly savedValues: string[] = [];
  readonly copiedValues: string[] = [];

  async cellValue(
    resultId: number,
    row: number,
    col: number,
    from: number,
    max: number,
  ): Promise<CellValuePart> {
    this.valueCalls.push({ resultId, row, col, from, max });
    if (this.valueGate) await this.valueGate;
    if (this.error) throw this.error;
    const value = this.values.get(`${resultId}:${row}:${col}`);
    if (!value) return { kind: 'null', total: 0, from: 0, to: 0 };
    if (value.unreadable) {
      return { kind: 'unreadable', total: 0, from: 0, to: 0, text: value.unreadable };
    }
    if (value.bytes) {
      const part = value.bytes.slice(from, from + max);
      return {
        kind: 'bytes',
        total: value.bytes.length,
        from,
        to: from + part.length,
        base64: btoa(String.fromCharCode(...part)),
        ...(from === 0 && value.image ? { image: value.image } : {}),
      };
    }
    const text = value.text ?? '';
    const part = text.slice(from, from + max);
    return { kind: 'text', total: text.length, from, to: from + part.length, text: part };
  }

  saveCellValue(resultId: number, row: number, col: number, path: string): Promise<number> {
    this.savedValues.push(`${resultId}:${row}:${col} → ${path}`);
    return Promise.resolve(1);
  }

  copyCellValue(resultId: number, row: number, col: number): Promise<number> {
    this.copiedValues.push(`${resultId}:${row}:${col}`);
    return Promise.resolve(1);
  }

  /** The table queries asked for (prompt 027). The fake answers with a statement that names them. */
  readonly tableQueries: { connection: string; query: TableQuery }[] = [];
  /** The views asked for; a view gets the id `1000 + n` and as many rows as `viewRows` says. */
  readonly views: { jobId: number; resultId: number; spec: ViewSpec }[] = [];
  readonly cancelledViews: number[] = [];
  viewRows = 2;
  viewError: unknown = null;

  tableQuery(connection: string, query: TableQuery): Promise<BuiltQuery> {
    this.tableQueries.push({ connection, query });
    if (this.error) return Promise.reject(this.error);
    const where = query.conditions
      .map((c) => `${c.column} ${c.op}${c.values.map(() => ' ?').join('')}`)
      .join(query.any ? ' OR ' : ' AND ');
    const order = query.order.map((o) => `${o.column}${o.desc ? ' DESC' : ''}`).join(', ');
    const tail =
      (where ? ` WHERE ${where}` : '') +
      (query.whereSql ? ` AND (${query.whereSql})` : '') +
      (order ? ` ORDER BY ${order}` : '');
    // the values of a key come first, as in the statement of the backend
    const values = [
      ...(query.keys?.rows.flat() ?? []),
      ...query.conditions.flatMap((c) => c.values),
    ];
    const table = `${query.schema ? `${query.schema}.` : ''}${query.table}`;
    let n = 0;
    return Promise.resolve({
      sql: `SELECT * FROM ${table}${tail}`,
      params: values.map((value) => ({ kind: 'text' as const, value })),
      display: `SELECT * FROM ${table}${tail.replace(/\?/g, () => `'${values[n++]}'`)}`,
    });
  }

  resultView(jobId: number, resultId: number, spec: ViewSpec): Promise<ViewedResult> {
    this.views.push({ jobId, resultId, spec });
    if (this.viewError) return Promise.reject(this.viewError);
    const id = 1000 + this.views.length;
    this.results.set(id, (this.results.get(resultId) ?? []).slice(0, this.viewRows));
    return Promise.resolve({ resultId: id, rows: this.viewRows });
  }

  cancelView(jobId: number): Promise<void> {
    this.cancelledViews.push(jobId);
    return Promise.resolve();
  }

  compareColumns(left: number, right: number): Promise<ColumnPairing> {
    void left;
    void right;
    return Promise.resolve({
      pairs: this.columns.map((_, i) => [i, i] as const),
      leftOnly: [],
      rightOnly: [],
      byPosition: false,
    });
  }

  /** Every comparison asked for; `compareGate` holds the answer back, `compareError` fails it. */
  readonly compares: { jobId: number; spec: CompareSpec }[] = [];
  readonly cancelledCompares: number[] = [];
  compareGate: Promise<void> | null = null;
  compareError: unknown = null;
  compareReport: Partial<CompareReport> = {};

  async resultCompare(
    jobId: number,
    spec: CompareSpec,
    onProgress?: (done: number, of: number) => void,
  ): Promise<CompareReport> {
    this.compares.push({ jobId, spec });
    onProgress?.(1, 2);
    if (this.compareGate) await this.compareGate;
    if (this.compareError) throw this.compareError;
    const resultId = 5000 + this.compares.length * 2;
    const rows: Cell[][] = [
      ['≡', null, 1, 'a'],
      ['≠←', 'name', 2, 'b'],
      ['≠→', 'name', 2, 'B'],
      ['→', null, 3, 'c'],
    ];
    this.results.set(resultId, rows);
    this.results.set(resultId + 1, rows.slice(1));
    return {
      resultId,
      columns: [
        { name: 'Δ', kind: 'text', typeName: '' },
        { name: '≠', kind: 'text', typeName: '' },
        ...this.columns,
      ],
      rows: 4,
      diffId: resultId + 1,
      diffRows: 3,
      leftRows: 2,
      rightRows: 3,
      same: 1,
      changed: 1,
      leftOnly: 0,
      rightOnly: 1,
      duplicateLeft: 0,
      duplicateRight: 0,
      duplicateKeys: [],
      changedByColumn: [{ name: 'name', rows: 1 }],
      leftColumnsOnly: [],
      rightColumnsOnly: [],
      byPosition: false,
      cut: false,
      ...this.compareReport,
    };
  }

  cancelCompare(jobId: number): Promise<void> {
    this.cancelledCompares.push(jobId);
    return Promise.resolve();
  }

  /** What `resultNeighbour` answers. */
  neighbour: readonly [number, number] | null = null;
  resultNeighbour(): Promise<readonly [number, number] | null> {
    return Promise.resolve(this.neighbour);
  }

  resultUsage(resultIds: readonly number[]): Promise<ResultUsage[]> {
    return Promise.resolve(
      resultIds.map((id) => ({ bytes: this.results.has(id) ? 1024 : 0, onDisk: false })),
    );
  }

  /** Every question for figures, and how it is answered (a gate holds the answer back). */
  readonly statsCalls: {
    jobId: number;
    resultId: number;
    selection: CopySelection;
    top: boolean;
  }[] = [];
  readonly cancelledStats: number[] = [];
  statsAnswer: ResultStats = EMPTY_STATS;
  statsError: { code: string; message: string } | null = null;
  statsGate: Promise<void> | null = null;

  async resultStats(
    jobId: number,
    resultId: number,
    selection: CopySelection,
    top: boolean,
  ): Promise<ResultStats> {
    this.statsCalls.push({ jobId, resultId, selection, top });
    const answer = this.statsAnswer;
    if (this.statsGate) await this.statsGate;
    if (this.statsError) throw this.statsError;
    if (this.cancelledStats.includes(jobId)) throw { code: 'cancelled', message: '' };
    return answer;
  }

  cancelStats(jobId: number): Promise<void> {
    this.cancelledStats.push(jobId);
    return Promise.resolve();
  }

  /**
   * Searching (prompt 029): the fake looks through `results` like the backend – texts and numbers as
   * written, without case unless asked; a „regex“ is a JavaScript one here.
   */
  readonly searches: {
    jobId: number;
    resultId: number;
    spec: SearchSpec;
    from: number;
    maxRows: number;
  }[] = [];
  readonly cancelledSearches: number[] = [];
  searchError: { code: string; message: string } | null = null;
  searchGate: Promise<void> | null = null;

  async resultSearch(
    jobId: number,
    resultId: number,
    spec: SearchSpec,
    from: number,
    maxRows: number,
    maxHits: number,
  ): Promise<SearchFound> {
    this.searches.push({ jobId, resultId, spec, from, maxRows });
    if (this.searchGate) await this.searchGate;
    if (this.searchError) throw this.searchError;
    if (this.cancelledSearches.includes(jobId)) throw { code: 'cancelled', message: '' };
    const rows = this.results.get(resultId);
    if (!rows) throw { code: 'unknown_result', message: '' };
    const source = spec.regex ? spec.text : spec.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      spec.wholeWord ? `\\b(?:${source})\\b` : source,
      spec.caseSensitive ? 'u' : 'iu',
    );
    const hits: [number, number][] = [];
    let row = from;
    const to = Math.min(rows.length, from + maxRows);
    for (; row < to && hits.length < maxHits; row++) {
      rows[row].forEach((cell, c) => {
        if (spec.columns.length > 0 && !spec.columns.includes(c)) return;
        if ((typeof cell === 'string' || typeof cell === 'number') && re.test(String(cell)))
          hits.push([row, c]);
      });
    }
    return { hits, next: row, done: row >= rows.length };
  }

  readonly seeks: { resultId: number; col: number; from: number; seek: SeekKind }[] = [];

  resultSeek(
    _jobId: number,
    resultId: number,
    col: number,
    from: number,
    seek: SeekKind,
  ): Promise<number | null> {
    this.seeks.push({ resultId, col, from, seek });
    const rows = this.results.get(resultId) ?? [];
    for (let row = from + 1; row < rows.length; row++) {
      const cell = rows[row][col] ?? null;
      if (seek === 'null' ? cell === null : cell !== (rows[from][col] ?? null))
        return Promise.resolve(row);
    }
    return Promise.resolve(null);
  }

  cancelSearch(jobId: number): Promise<void> {
    this.cancelledSearches.push(jobId);
    return Promise.resolve();
  }

  /** Writing changed cells (prompt 031): what was asked, and how the "backend" answers. */
  readonly previews: UpdatePlan[] = [];
  readonly applied: {
    connection: string;
    session: string;
    plan: UpdatePlan;
    confirmations: readonly (string | null)[];
  }[] = [];
  /** `null` = every statement is written. */
  applyAnswer: Partial<Applied> | null = null;
  applyError: { code: string; message: string } | null = null;

  /** One statement per row, in the order of the backend; its text names the cells, never their values. */
  editPreview(_connection: string, plan: UpdatePlan): Promise<EditStep[]> {
    this.previews.push(plan);
    const table = `${plan.schema ? `${plan.schema}.` : ''}${plan.table}`;
    const text = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);
    const where = (key: readonly EditCell[]) =>
      key.map((c) => `${c.column} = ${text(c.value)}`).join(' AND ');
    const bound = (cells: readonly (EditCell | EditSet)[]) =>
      cells
        .filter((c) => c.value !== null && !('default' in c && c.default))
        .map((c) => ({ kind: 'text' as const, value: c.value as string }));
    const step = (
      kind: EditStep['kind'],
      first: number,
      sql: string,
      display: string,
      cells: readonly (EditCell | EditSet)[],
    ): EditStep => ({
      kind,
      first,
      rows: 1,
      returns: false,
      sql,
      params: bound(cells),
      display,
    });
    return Promise.resolve([
      ...(plan.deletes ?? []).map((row, i) =>
        step(
          'delete',
          i,
          `DELETE FROM ${table} WHERE ${[...row.key, ...row.expect].map((c) => c.column).join(', ')}`,
          `DELETE FROM ${table} WHERE ${where(row.key)}`,
          [...row.key, ...row.expect],
        ),
      ),
      ...plan.rows.map((row, i) =>
        step(
          'update',
          i,
          `UPDATE ${table} SET ${row.set.map((c) => c.column).join(', ')} WHERE ${[...row.key, ...row.expect].map((c) => c.column).join(', ')}`,
          `UPDATE ${table} SET ${row.set
            .map((c) => `${c.column} = ${c.default ? 'DEFAULT' : text(c.value)}`)
            .join(', ')} WHERE ${where(row.key)}`,
          [...row.set, ...row.key, ...row.expect],
        ),
      ),
      ...(plan.inserts ?? []).map((row, i) =>
        step(
          'insert',
          i,
          `INSERT INTO ${table} (${row.set.map((c) => c.column).join(', ')})`,
          `INSERT INTO ${table} (${row.set.map((c) => c.column).join(', ')}) VALUES (${row.set
            .map((c) => text(c.value))
            .join(', ')})`,
          row.set,
        ),
      ),
    ]);
  }

  editApply(
    connection: string,
    session: string,
    plan: UpdatePlan,
    confirmations: readonly (string | null)[],
  ): Promise<Applied> {
    this.applied.push({ connection, session, plan, confirmations });
    if (this.applyError) return Promise.reject(this.applyError);
    return Promise.resolve({
      done: plan.rows.length + (plan.deletes?.length ?? 0) + (plan.inserts?.length ?? 0),
      failed: null,
      failedKind: null,
      failedSpan: 1,
      inserted: [],
      conflict: false,
      error: null,
      blocked: false,
      unknown: false,
      tx: 'idle',
      ...this.applyAnswer,
    });
  }
}

export const DEMO_PROFILE: Profile = {
  id: 'demo',
  name: 'Demo (SQLite im Speicher)',
  kind: 'sqlite',
  host: '',
  port: 0,
  database: ':demo:',
  user: '',
  tls: 'off',
  folder: '',
  color: 3,
  savePassword: false,
  protection: 'free',
  label: '',
  caFile: '',
  clientCert: '',
  clientKey: '',
  ssh: null,
};

/**
 * Profiles in memory. `passwords` are what the server accepts per profile id (none = no password needed);
 * `keychain` holds what was stored.
 */
export class FakeConnectionsApi extends ConnectionsApi {
  /** What an opened connection says it can do; `undefined`: nothing said (an older backend). */
  capabilities: Capabilities | undefined = undefined;
  profiles: Profile[] = [DEMO_PROFILE];
  notice: string | null = null;
  readonly passwords = new Map<string, string>();
  readonly keychain = new Map<string, string>();
  readonly opened: { id: string; password: string | null }[] = [];
  readonly closed: string[] = [];
  /** Rejects the next `open` with this (unreachable server …). */
  failOpen: unknown = null;
  failSave: unknown = null;

  list(): Promise<LoadedConnections> {
    return Promise.resolve({ profiles: this.profiles, notice: this.notice });
  }

  save(profile: Profile, password: string | null): Promise<Profile> {
    if (this.failSave) return Promise.reject(this.failSave);
    const stored = profile.id ? profile : { ...profile, id: `p${this.profiles.length}` };
    this.profiles = [...this.profiles.filter((p) => p.id !== stored.id), stored];
    if (password && stored.savePassword) this.keychain.set(stored.id, password);
    if (!stored.savePassword) this.keychain.delete(stored.id);
    return Promise.resolve(stored);
  }

  delete(id: string): Promise<void> {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.keychain.delete(id);
    return Promise.resolve();
  }

  /**
   * The SSH server in front of the profiles that have a jump host: its host key is unknown until its
   * fingerprint is named (`changedHostKey`: it differs from the record, no way past); `sshSecret` is the
   * password or passphrase it wants (`null` = none).
   */
  hostKey = 'ssh-ed25519 SHA256:FakeFingerprintOfTheJumpHost';
  trustedHostKeys = new Set<string>();
  changedHostKey = false;
  sshSecret: string | null = null;
  readonly sshTried: SshCredentials[] = [];
  hosts: SshHost[] = [];

  private tunnel(profile: Profile | undefined, ssh?: SshCredentials): Promise<void> {
    if (!profile?.ssh) return Promise.resolve();
    this.sshTried.push(ssh ?? { secret: null, trustFingerprint: null });
    const fingerprint = this.hostKey.split(' ')[1];
    if (this.changedHostKey) {
      return Promise.reject({
        code: 'host_key_changed',
        message: `the host key of ${profile.ssh.host} differs from the one in known_hosts:3 (server shows ${this.hostKey})`,
      });
    }
    if (!this.trustedHostKeys.has(fingerprint)) {
      if (ssh?.trustFingerprint !== fingerprint) {
        return Promise.reject({
          code: 'host_key_unknown',
          message: `unknown host key of ${profile.ssh.host}: ${this.hostKey}`,
        });
      }
      this.trustedHostKeys.add(fingerprint);
    }
    if (this.sshSecret !== null && ssh?.secret !== this.sshSecret) {
      return Promise.reject({
        code: 'ssh_secret_required',
        message: ssh?.secret ? 'password not accepted for jump' : 'password needed for jump',
      });
    }
    return Promise.resolve();
  }

  sshHosts(): Promise<SshHost[]> {
    return Promise.resolve(this.hosts);
  }

  /** What `parseUrl` answers per text; anything else is refused. */
  urls = new Map<string, UrlDraft>();
  /** What a source holds. */
  importable: ImportItem[] = [];
  readonly imports: { source: ImportSource; path: string | null; picks: readonly ImportPick[] }[] =
    [];
  readonly exported: string[] = [];
  failImport: { code: string; message: string } | null = null;

  parseUrl(text: string): Promise<UrlDraft> {
    const found = this.urls.get(text.trim());
    return found
      ? Promise.resolve(found)
      : Promise.reject({ code: 'invalid_profile', message: 'this is no connection URL' });
  }

  importPreview(_source: ImportSource, path: string | null): Promise<ImportPreview> {
    if (this.failImport) return Promise.reject(this.failImport);
    return Promise.resolve({ path: path ?? '/home/me/.pgpass', items: this.importable });
  }

  importConnections(
    source: ImportSource,
    path: string | null,
    picks: readonly ImportPick[],
  ): Promise<Profile[]> {
    this.imports.push({ source, path, picks });
    const stored = picks
      .map((pick) => this.importable.find((i) => i.index === pick.index))
      .filter((i): i is ImportItem => !!i && i.problem === null)
      .map((i, n) => ({ ...i.profile, id: `imported-${this.profiles.length + n}` }));
    this.profiles = [...this.profiles, ...stored];
    return Promise.resolve(stored);
  }

  exportConnections(path: string): Promise<void> {
    this.exported.push(path);
    return Promise.resolve();
  }

  test(profile: Profile, password: string | null, ssh?: SshCredentials): Promise<string> {
    return this.tunnel(profile, ssh)
      .then(() => this.check(profile.id, password))
      .then(() => 'Fake 1.0');
  }

  async open(id: string, password: string | null, ssh?: SshCredentials): Promise<ConnectionInfo> {
    await this.tunnel(
      this.profiles.find((p) => p.id === id),
      ssh,
    );
    this.opened.push({ id, password });
    if (this.failOpen) {
      const e = this.failOpen;
      this.failOpen = null;
      return Promise.reject(e);
    }
    return this.check(id, password).then(() => ({
      id,
      serverVersion: 'Fake 1.0',
      capabilities: this.capabilities,
    }));
  }

  close(id: string): Promise<void> {
    this.closed.push(id);
    return Promise.resolve();
  }

  private check(id: string, given: string | null): Promise<void> {
    const wanted = this.passwords.get(id);
    if (wanted === undefined) return Promise.resolve();
    const password = given ?? this.keychain.get(id) ?? null;
    if (password === null) {
      return Promise.reject({ code: 'secret_required', message: 'a password is needed' });
    }
    if (password !== wanted) {
      return Promise.reject({ code: 'auth_failed', message: 'password authentication failed' });
    }
    return Promise.resolve();
  }
}

/** Keeps the own schemes in memory; `failSave` makes the next save reject. */
export class FakeThemeApi extends ThemeApi {
  stored: Theme[] = [];
  notice: string | null = null;
  failSave: unknown = null;
  /** What `importFile` answers per path. */
  readonly files = new Map<string, unknown>();
  readonly exported: { path: string; theme: Theme }[] = [];

  load(): Promise<LoadedThemes> {
    return Promise.resolve({ themes: this.stored, notice: this.notice });
  }

  save(themes: readonly Theme[]): Promise<void> {
    if (this.failSave) return Promise.reject(this.failSave);
    this.stored = [...themes];
    return Promise.resolve();
  }

  importFile(path: string): Promise<unknown> {
    return this.files.has(path)
      ? Promise.resolve(this.files.get(path))
      : Promise.reject({ code: 'not_found', message: 'no such file' });
  }

  exportFile(path: string, theme: Theme): Promise<void> {
    this.exported.push({ path, theme });
    return Promise.resolve();
  }
}

/** Answers every dialog with `path` (`null` = cancelled). */
export class FakeFileDialogApi extends FileDialogApi {
  path: string | null = null;
  readonly asked: string[] = [];

  openFile(title: string): Promise<string | null> {
    this.asked.push(title);
    return Promise.resolve(this.path);
  }

  saveFile(title: string, defaultName: string): Promise<string | null> {
    this.asked.push(`${title}: ${defaultName}`);
    return Promise.resolve(this.path);
  }

  openFolder(title: string): Promise<string | null> {
    this.asked.push(title);
    return Promise.resolve(this.path);
  }
}

/** The session and the texts of the tabs in memory; `disk` are the files of the user by path. */
export class FakeSessionApi extends SessionApi {
  session: SessionFile = { version: 1, tabs: [], active: null };
  notice: string | null = null;
  readonly texts = new Map<string, string>();
  readonly disk = new Map<string, TextFile>();
  readonly saves: SessionFile[] = [];
  /** Encodings that refuse a text (`encoding_failed`). */
  readonly refuses = new Set<string>();

  load(): Promise<LoadedSession> {
    return Promise.resolve({ session: this.session, notice: this.notice });
  }
  save(session: SessionFile): Promise<void> {
    this.session = session;
    this.saves.push(session);
    return Promise.resolve();
  }
  loadText(id: string): Promise<string> {
    return Promise.resolve(this.texts.get(id) ?? '');
  }
  saveText(id: string, text: string): Promise<void> {
    this.texts.set(id, text);
    return Promise.resolve();
  }
  deleteText(id: string): Promise<void> {
    this.texts.delete(id);
    return Promise.resolve();
  }
  readFile(path: string): Promise<TextFile> {
    const file = this.disk.get(path);
    return file ? Promise.resolve(file) : Promise.reject({ code: 'not_found', message: path });
  }
  writeFile(path: string, text: string, encoding: string): Promise<void> {
    if (this.refuses.has(encoding)) {
      return Promise.reject({ code: 'encoding_failed', message: 'cannot hold the text' });
    }
    this.disk.set(path, { text, encoding });
    return Promise.resolve();
  }
}

/**
 * A database of two schemas: `public` (current: `customer`, `orders`, a view, a routine) and
 * `pg_catalog` (system). Calls are counted; `fail` makes the next calls reject; `hold()` keeps answers back
 * until `release()`.
 */
export class FakeSchemaApi extends SchemaApi {
  readonly calls: string[] = [];
  fail: { code: string; message: string } | null = null;
  schemaList: SchemaInfo[] = [
    { name: 'archive', quoted: 'archive', system: false, current: false },
    { name: 'pg_catalog', quoted: 'pg_catalog', system: true, current: false },
    { name: 'public', quoted: 'public', system: false, current: true },
  ];
  objectList: Record<string, ObjectInfo[]> = {
    public: [
      { kind: 'table', name: 'customer', quoted: 'customer', detail: '', rows: 1200 },
      { kind: 'table', name: 'orders', quoted: 'orders', detail: '', rows: 2_500_000 },
      { kind: 'view', name: 'big_orders', quoted: 'big_orders', detail: '', rows: null },
      { kind: 'routine', name: 'twice', quoted: 'twice', detail: 'n integer', rows: null },
    ],
    archive: [{ kind: 'table', name: 'Old Orders', quoted: '"Old Orders"', detail: '', rows: 7 }],
    pg_catalog: [{ kind: 'table', name: 'pg_class', quoted: 'pg_class', detail: '', rows: 400 }],
  };
  tableInfo: TableInfo = {
    columns: [
      { name: 'id', quoted: 'id', typeName: 'integer', nullable: false, default: null, key: 'pk' },
      {
        name: 'customer_id',
        quoted: 'customer_id',
        typeName: 'integer',
        nullable: false,
        default: null,
        key: 'fk',
      },
      { name: 'note', quoted: 'note', typeName: 'text', nullable: true, default: null, key: '' },
    ],
    indexes: [{ name: 'orders_pkey', detail: 'primary btree (id)' }],
    keys: [{ name: 'orders_pkey', detail: 'PRIMARY KEY (id)' }],
    triggers: [],
  };
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise((resolve) => (this.open = resolve));
  }

  release(): void {
    this.open?.();
    this.gate = null;
  }

  private async answer<T>(call: string, value: T): Promise<T> {
    this.calls.push(call);
    const fail = this.fail;
    if (this.gate) await this.gate;
    if (fail) throw fail;
    return value;
  }

  schemas(): Promise<SchemaInfo[]> {
    return this.answer('schemas', this.schemaList);
  }

  objects(_id: string, schema: string): Promise<ObjectInfo[]> {
    return this.answer(`objects ${schema}`, this.objectList[schema] ?? []);
  }

  table(_id: string, schema: string, table: string): Promise<TableInfo> {
    return this.answer(`table ${schema}.${table}`, this.tableInfo);
  }

  /** The keys of tables by `schema.table` (prompt 030). */
  relationsOf: Record<string, TableRelations> = {};

  relations(_connectionId: string, schema: string, table: string): Promise<TableRelations> {
    this.calls.push(`relations ${schema}.${table}`);
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve(
      this.relationsOf[`${schema}.${table}`] ?? { outgoing: [], incoming: [] },
    );
  }

  /** What `diagram` answers (prompt 037). */
  diagramData: DiagramData = { tables: [], keys: [], unique: [], cut: false };

  diagram(_id: string, schema: string): Promise<DiagramData> {
    return this.answer(`diagram ${schema}`, this.diagramData);
  }

  search(_id: string, text: string): Promise<Found[]> {
    const found: Found[] = [];
    for (const [schema, list] of Object.entries(this.objectList)) {
      for (const o of list) {
        if (o.kind !== 'routine' && o.name.toLowerCase().includes(text.toLowerCase())) {
          found.push({ schema, kind: o.kind, name: o.name, quoted: o.quoted });
        }
      }
    }
    return this.answer(`search ${text}`, found);
  }

  /** What `details` answers, by object name; any other object has the first one's. */
  detailList: Record<string, ObjectDetails> = {
    orders: {
      sections: [
        {
          id: 'columns',
          columns: ['name', 'type', 'nullable', 'default', 'key', 'extra', 'comment'],
          rows: [
            ['id', 'integer', 'no', null, 'pk', 'identity always', null],
            ['customer_id', 'integer', 'no', null, 'fk', '', 'who ordered'],
            ['note', 'text', 'yes', "'none'", '', '', null],
          ],
          cut: false,
        },
        {
          id: 'references',
          columns: [
            'name',
            'columns',
            'refSchema',
            'refName',
            'refColumns',
            'onUpdate',
            'onDelete',
          ],
          rows: [
            ['orders_customer', 'customer_id', 'public', 'customer', 'id', 'no action', 'cascade'],
          ],
          cut: false,
        },
        {
          id: 'stats',
          columns: ['property', 'value'],
          rows: [
            ['rows', '2500000'],
            ['totalSize', '312 MB'],
          ],
          cut: false,
        },
      ],
      ddl: 'CREATE TABLE public.orders (\n    id integer NOT NULL\n);\n',
      notes: ['privileges'],
    },
    customer: {
      sections: [
        {
          id: 'referencedBy',
          columns: ['name', 'refSchema', 'refName', 'columns'],
          rows: [['orders_customer', 'public', 'orders', 'customer_id']],
          cut: false,
        },
      ],
      ddl: null,
      notes: ['ddl'],
    },
  };

  /** The names `names` searches (by a part of the name; the real ranking is tested in Rust). */
  nameList: NameHit[] = [
    hit('table', 'public', 'orders'),
    hit('table', 'public', 'order_items'),
    hit('view', 'public', 'big_orders'),
    hit('routine', 'public', 'twice', 'n integer'),
    {
      ...hit('column', 'public', 'customer_id', 'integer'),
      parent: 'orders',
      quoted: 'customer_id',
    },
  ];
  /** Answers of `names` wait for these to be resolved, in order (for tests of overtaken answers). */
  readonly nameGates: Promise<void>[] = [];
  readonly nameQueries: { query: string; context: NameContext }[] = [];
  refreshed = 0;

  async names(_id: string, query: string, context: NameContext): Promise<NameHits> {
    this.nameQueries.push({ query, context });
    const gate = this.nameGates.shift();
    if (gate) await gate;
    if (this.fail) throw this.fail;
    const columns = /^c:/i.test(query.trim());
    const text = query
      .replace(/^[a-z]:/i, '')
      .trim()
      .toLowerCase();
    const hits = this.nameList.filter(
      (h) => (h.kind === 'column') === columns && h.name.toLowerCase().includes(text),
    );
    return { hits, total: hits.length, indexed: this.nameList.length, cut: false };
  }

  refreshNames(): Promise<number> {
    this.refreshed++;
    return Promise.resolve(this.nameList.length);
  }

  details(_id: string, schema: string, name: string, kind: string): Promise<ObjectDetails> {
    return this.answer(
      `details ${schema}.${name} ${kind}`,
      this.detailList[name] ?? this.detailList['orders'],
    );
  }
}

/** A clipboard that remembers what was asked of it. `fail` makes the next copy reject. */
export class FakeClipboardApi extends ClipboardApi {
  readonly texts: string[] = [];
  readonly copies: {
    resultId: number;
    selection: CopySelection;
    format: CopyFormat;
    options: CopyOptions;
  }[] = [];
  cancelled = 0;
  fail: { code: string; message: string } | null = null;

  copyText(text: string): Promise<void> {
    if (this.fail) return Promise.reject(this.fail);
    this.texts.push(text);
    return Promise.resolve();
  }

  /** What is „on the clipboard“ for a paste. */
  pasteText = '';

  readText(): Promise<string> {
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve(this.pasteText);
  }

  copyResult(
    resultId: number,
    selection: CopySelection,
    format: CopyFormat,
    options: CopyOptions,
  ): Promise<Copied> {
    this.copies.push({ resultId, selection, format, options });
    if (this.fail) return Promise.reject(this.fail);
    const rows = selection.rows.reduce((n, [a, b]) => n + b - a + 1, 0) || 3;
    return Promise.resolve({ rows, columns: selection.columns.length || 2, chars: 10 });
  }

  cancelCopy(): Promise<void> {
    this.cancelled++;
    return Promise.resolve();
  }
}

/** A history in memory that filters like the real one (no merging of repeats, no pruning). */
export class FakeHistoryApi extends HistoryApi {
  entries: (HistoryEntry & { sql: string })[] = [];
  readonly added: { entry: NewHistoryEntry; keep: HistoryKeep }[] = [];
  readonly filters: HistoryFilter[] = [];
  readonly deleted: HistoryScope[] = [];
  notice: string | null = null;
  private nextId = 1;

  add(entry: NewHistoryEntry, keep: HistoryKeep): Promise<number> {
    this.added.push({ entry, keep });
    const id = this.nextId++;
    this.entries.unshift({
      ...entry,
      id,
      preview: entry.sql.slice(0, 300),
      length: entry.sql.length,
      count: 1,
    });
    return Promise.resolve(id);
  }

  list(filter: HistoryFilter): Promise<HistoryPage> {
    this.filters.push(filter);
    const words = (filter.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const all = this.entries.filter(
      (e) =>
        words.every((w) => e.sql.toLowerCase().includes(w)) &&
        (!filter.connectionId || e.connectionId === filter.connectionId) &&
        (!filter.failedOnly || e.outcome === 'failed') &&
        (!filter.userOnly || e.origin === 'user'),
    );
    const from = filter.offset ?? 0;
    const notice = this.notice;
    this.notice = null;
    return Promise.resolve({
      entries: all.slice(from, from + (filter.limit ?? 200)),
      total: all.length,
      notice,
    });
  }

  text(id: number): Promise<string> {
    const entry = this.entries.find((e) => e.id === id);
    return entry
      ? Promise.resolve(entry.sql)
      : Promise.reject({ code: 'not_found', message: 'this entry is gone' });
  }

  delete(scope: HistoryScope): Promise<number> {
    this.deleted.push(scope);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) =>
      scope.kind === 'all'
        ? false
        : scope.kind === 'connection'
          ? e.connectionId !== scope.id
          : e.id !== scope.id,
    );
    return Promise.resolve(before - this.entries.length);
  }
}

/**
 * An export that writes nothing: it remembers what was asked, reports progress once and resolves when
 * `finish()` is called (or at once, unless `hold` is set). `fail` makes it reject.
 */
export class FakeExportApi extends ExportApi {
  readonly results: {
    jobId: number;
    resultId: number;
    rows: unknown;
    path: string;
    spec: ExportSpec;
  }[] = [];
  readonly queries: {
    jobId: number;
    connectionId: string;
    sql: string;
    path: string;
    spec: ExportSpec;
  }[] = [];
  readonly cancelled: number[] = [];
  readonly revealed: string[] = [];
  readonly previews: ExportSpec[] = [];
  fail: { code: string; message: string } | null = null;
  hold = false;
  done: Exported = { rows: 5, bytes: 120, truncated: false, cutCells: 0 };
  private settle: (() => void) | null = null;

  /** Lets a held export end. */
  finish(): void {
    this.settle?.();
  }

  private async run(onProgress: (rows: number) => void): Promise<Exported> {
    onProgress(1024);
    if (this.hold) await new Promise<void>((resolve) => (this.settle = resolve));
    if (this.fail) throw this.fail;
    return this.done;
  }

  exportResult(
    jobId: number,
    resultId: number,
    rows: readonly (readonly [number, number])[],
    path: string,
    spec: ExportSpec,
    onProgress: (rows: number) => void,
  ): Promise<Exported> {
    this.results.push({ jobId, resultId, rows, path, spec });
    return this.run(onProgress);
  }

  exportQuery(
    jobId: number,
    connectionId: string,
    sql: string,
    path: string,
    spec: ExportSpec,
    onProgress: (rows: number) => void,
  ): Promise<Exported> {
    this.queries.push({ jobId, connectionId, sql, path, spec });
    return this.run(onProgress);
  }

  cancel(jobId: number): Promise<void> {
    this.cancelled.push(jobId);
    this.fail = { code: 'cancelled', message: 'cancelled' };
    this.finish();
    return Promise.resolve();
  }

  preview(_resultId: number, spec: ExportSpec): Promise<string> {
    this.previews.push(spec);
    return Promise.resolve(`preview as ${spec.format}`);
  }

  reveal(path: string): Promise<void> {
    this.revealed.push(path);
    return Promise.resolve();
  }
}

function hit(kind: NameHit['kind'], schema: string, name: string, detail = ''): NameHit {
  return {
    kind,
    schema,
    name,
    parent: null,
    detail,
    quoted: `${schema}.${name}`,
    quotedName: name,
    marks: [0],
  };
}

/**
 * A formatter that does not format: it remembers what was asked and answers with `answer(sql)` (default:
 * the text in upper case). `fail` makes it reject; with `hold` it waits for `finish()`.
 */
export class FakeFormatApi extends FormatApi {
  readonly calls: {
    jobId: number;
    sql: string;
    dialect: FormatDialect;
    mode: FormatMode;
    style: FormatStyle;
    crlf: boolean;
  }[] = [];
  readonly cancelled: number[] = [];
  fail: { code: string; message: string } | null = null;
  hold = false;
  answer: (sql: string) => string = (sql) => sql.toUpperCase();
  private settle: (() => void) | null = null;

  finish(): void {
    this.settle?.();
  }

  async format(
    jobId: number,
    sql: string,
    dialect: FormatDialect,
    mode: FormatMode,
    style: FormatStyle,
    crlf: boolean,
  ): Promise<string> {
    this.calls.push({ jobId, sql, dialect, mode, style, crlf });
    if (this.hold) await new Promise<void>((resolve) => (this.settle = resolve));
    if (this.fail) throw this.fail;
    return this.answer(sql);
  }

  async cancel(jobId: number): Promise<void> {
    this.cancelled.push(jobId);
  }
}

/**
 * Saved queries in memory: `files` is the folder (id → what the file holds). Ids are made like the backend
 * makes them (`folder/Name.sql`, a taken name gets a number); `outside()` changes the folder as another
 * program would.
 */
export class FakeSavedApi extends SavedApi {
  readonly files = new Map<string, { meta: SavedMeta; text: string; modified: number }>();
  readonly folders = new Set<string>();
  readonly deleted: string[] = [];
  readonly searched: string[] = [];
  root = '/queries';
  /** A folder `useFolder` refuses. */
  gone: string | null = null;
  fail: { code: string; message: string } | null = null;
  stamps = 0;
  private clock = 1;

  /** Writes a file as another program would. */
  outside(id: string, name: string, text: string): void {
    this.files.set(id, {
      meta: { name, description: '', tags: [], connection: null, dialect: null },
      text,
      modified: this.clock++,
    });
  }

  private entry(id: string): SavedEntry {
    const file = this.files.get(id)!;
    return {
      id,
      path: `${this.root}/${id}`,
      folder: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
      ...file.meta,
      modified: file.modified,
      size: file.text.length,
    };
  }

  private listing(): SavedListing {
    const ids = [...this.files.keys()].sort();
    const folders = new Set(this.folders);
    for (const id of ids) {
      const parts = id.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
    return {
      root: this.root,
      entries: ids.map((id) => this.entry(id)),
      folders: [...folders].sort(),
      stamp: this.currentStamp(),
      truncated: false,
    };
  }

  private currentStamp(): string {
    return [...this.files.entries()].map(([id, f]) => `${id}:${f.modified}`).join('|');
  }

  private freeId(folder: string, name: string, keep: string | null): string {
    for (let n = 1; ; n++) {
      const id = `${folder ? `${folder}/` : ''}${name}${n === 1 ? '' : ` ${n}`}.sql`;
      if (!this.files.has(id) || id === keep) return id;
    }
  }

  async useFolder(path: string | null): Promise<SavedListing> {
    if (path !== null && path === this.gone) throw { code: 'not_found', message: 'gone' };
    this.root = path ?? '/queries';
    return this.listing();
  }

  async list(): Promise<SavedListing> {
    if (this.fail) throw this.fail;
    return this.listing();
  }

  async stamp(): Promise<string> {
    this.stamps++;
    return this.currentStamp();
  }

  async read(id: string): Promise<SavedQuery> {
    const file = this.files.get(id);
    if (!file) throw { code: 'not_found', message: id };
    return { entry: this.entry(id), text: file.text };
  }

  async save(id: string | null, folder: string, meta: SavedMeta, text: string): Promise<string> {
    if (this.fail) throw this.fail;
    const target = id ?? this.freeId(folder, meta.name, null);
    this.files.set(target, { meta, text, modified: this.clock++ });
    return target;
  }

  async rename(id: string, folder: string, name: string): Promise<string> {
    const file = this.files.get(id);
    if (!file) throw { code: 'not_found', message: id };
    const target = this.freeId(folder, name, id);
    this.files.delete(id);
    this.files.set(target, { ...file, meta: { ...file.meta, name }, modified: this.clock++ });
    return target;
  }

  async createFolder(folder: string): Promise<void> {
    this.folders.add(folder);
  }

  async delete(id: string): Promise<void> {
    if (this.fail) throw this.fail;
    this.deleted.push(id);
    this.files.delete(id);
  }

  async search(query: string): Promise<readonly string[]> {
    this.searched.push(query);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.files.entries()]
      .filter(([id, f]) => {
        const hay = `${id}\n${f.meta.name}\n${f.text}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .map(([id]) => id);
  }
}

/** Figures of nothing: what a test changes a field of. */
export const EMPTY_STATS: ResultStats = {
  cells: 0,
  nonNull: 0,
  distinct: 0,
  distinctCapped: false,
  numbers: 0,
  ignored: 0,
  sum: null,
  mean: null,
  min: null,
  max: null,
  first: null,
  last: null,
  spanMs: null,
  shortest: null,
  longest: null,
  top: [],
  topPartial: false,
};

/**
 * An import that reads and writes nothing: it remembers what was asked, reports progress once and
 * resolves when `finish()` is called (or at once, unless `hold` is set). `fail` makes it reject.
 */
export class FakeDataImportApi extends DataImportApi {
  readonly previews: { path: string; options: SourceOptions; nulls: readonly string[] }[] = [];
  readonly runs: {
    jobId: number;
    connectionId: string;
    path: string;
    options: SourceOptions;
    plan: LoadPlan;
    errorPath: string | null;
    confirmations: readonly (string | null)[];
  }[] = [];
  readonly created: { sql: string; confirmation: string | null }[] = [];
  readonly cancelled: number[] = [];
  readonly revealed: string[] = [];
  fail: { code: string; message: string } | null = null;
  hold = false;
  start: FilePreview = {
    detected: { format: 'csv', delimiter: ';', encoding: 'utf-8', header: true, gzip: false },
    columns: ['ID', 'Note', 'extra'],
    rows: [
      ['1', '<b>bold</b>', 'x'],
      ['2', null, 'y'],
    ],
    types: [
      { kind: 'int', maxLen: 1, nullable: false },
      { kind: 'text', maxLen: 11, nullable: true },
      { kind: 'text', maxLen: 1, nullable: false },
    ],
    broken: 0,
  };
  done: Loaded = {
    read: 2,
    written: 2,
    skipped: 0,
    errors: [],
    cancelled: false,
    failed: false,
    rolledBack: false,
    errorFile: false,
    cleared: false,
  };
  /** Makes the next previews wait for `releasePreview()`. */
  holdPreview = false;
  private settle: (() => void) | null = null;
  private waiting: (() => void)[] = [];

  finish(): void {
    this.settle?.();
  }

  releasePreview(): void {
    this.holdPreview = false;
    this.waiting.splice(0).forEach((go) => go());
  }

  async preview(
    path: string,
    options: SourceOptions,
    nulls: readonly string[],
  ): Promise<FilePreview> {
    this.previews.push({ path, options, nulls });
    if (this.holdPreview) await new Promise<void>((resolve) => this.waiting.push(resolve));
    if (this.fail) throw this.fail;
    return this.start;
  }

  tableDdl(
    _connectionId: string,
    schema: string | null,
    table: string,
    columns: readonly (readonly [string, Guess])[],
  ): Promise<string> {
    return Promise.resolve(
      `CREATE TABLE ${schema ? `${schema}.` : ''}${table} (${columns.map(([n, g]) => `${n} ${g.kind}`).join(', ')})`,
    );
  }

  createTable(_connectionId: string, sql: string, confirmation: string | null): Promise<void> {
    // (the time limit is not looked at here)
    this.created.push({ sql, confirmation });
    return this.fail ? Promise.reject(this.fail) : Promise.resolve();
  }

  statements(_connectionId: string, plan: LoadPlan): Promise<string[]> {
    const insert = `INSERT INTO ${plan.table} VALUES (?)`;
    return Promise.resolve(plan.clearFirst ? [`DELETE FROM ${plan.table}`, insert] : [insert]);
  }

  async run(
    jobId: number,
    connectionId: string,
    path: string,
    options: SourceOptions,
    plan: LoadPlan,
    errorPath: string | null,
    confirmations: readonly (string | null)[],
    _allowDangerous: boolean,
    _timeoutMs: number,
    onProgress: (records: number) => void,
  ): Promise<Loaded> {
    this.runs.push({ jobId, connectionId, path, options, plan, errorPath, confirmations });
    onProgress(1);
    if (this.hold) await new Promise<void>((resolve) => (this.settle = resolve));
    if (this.fail) throw this.fail;
    return this.done;
  }

  cancel(jobId: number): Promise<void> {
    this.cancelled.push(jobId);
    this.done = { ...this.done, cancelled: true, rolledBack: true, written: 0 };
    this.finish();
    return Promise.resolve();
  }

  reveal(path: string): Promise<void> {
    this.revealed.push(path);
    return Promise.resolve();
  }
}

/** What the app is, without a backend. `fail` makes both calls reject. */
export class FakeAboutApi extends AboutApi {
  fail = false;
  info: AppInfo = {
    name: 'Schema Commander',
    version: '1.2.3',
    crateVersion: '1.2.3',
    tauriVersion: '2.9.0',
    os: 'macos',
    arch: 'aarch64',
    debug: false,
  };
  text = 'THIRD-PARTY NOTICES\n<b>not markup</b>';

  appInfo(): Promise<AppInfo> {
    return this.fail
      ? Promise.reject({ code: 'no_backend', message: '' })
      : Promise.resolve(this.info);
  }

  notices(): Promise<string> {
    return this.fail
      ? Promise.reject({ code: 'not_found', message: '' })
      : Promise.resolve(this.text);
  }
}

/**
 * A search on the server that searches nothing: it tells the events it was given, then resolves – at
 * once, or (with `hold`) when `finish()` is called. `cancel` ends it as cancelled.
 */
export class FakeFindApi extends FindApi {
  readonly runs: { jobId: number; connectionId: string; spec: FindSpec }[] = [];
  readonly cancelled: number[] = [];
  events: FindEvent[] = [];
  report: FindReport = {
    tables: 0,
    searched: 0,
    skipped: 0,
    rows: 0,
    sources: 0,
    cancelled: false,
    lost: false,
    resume: null,
    moreSources: false,
  };
  fail: { code: string; message: string } | null = null;
  hold = false;
  private settle: (() => void) | null = null;

  finish(): void {
    this.settle?.();
  }

  async run(
    jobId: number,
    connectionId: string,
    spec: FindSpec,
    onEvent: (event: FindEvent) => void,
  ): Promise<FindReport> {
    this.runs.push({ jobId, connectionId, spec });
    this.events.forEach(onEvent);
    if (this.hold) await new Promise<void>((resolve) => (this.settle = resolve));
    if (this.fail) throw this.fail;
    return this.report;
  }

  cancel(jobId: number): Promise<void> {
    this.cancelled.push(jobId);
    this.report = { ...this.report, cancelled: true };
    this.finish();
    return Promise.resolve();
  }
}

/**
 * A comparison without a backend: snapshots by `connection/schema`, and the items it is told to answer
 * with. It remembers what was compared and scripted.
 */
export class FakeCompareApi extends CompareApi {
  snapshots: Record<string, SchemaSnapshot> = {};
  items: CompareItem[] = [];
  /** The items after a rename was told (`null`: the same). */
  itemsWithRenames: CompareItem[] | null = null;
  fail: { code: string; message: string } | null = null;
  readonly compared: {
    left: SchemaSnapshot;
    right: SchemaSnapshot;
    renames: readonly SchemaRename[];
  }[] = [];
  readonly scripted: {
    source: SchemaSnapshot;
    target: SchemaSnapshot;
    picks: readonly string[] | null;
    renames: readonly SchemaRename[];
  }[] = [];

  snapshot(connectionId: string, schema: string): Promise<SchemaSnapshot> {
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve(
      this.snapshots[`${connectionId}/${schema}`] ?? {
        kind: 'postgres',
        schema,
        tables: [],
        views: [],
        routines: [],
        triggers: [],
      },
    );
  }

  compare(
    left: SchemaSnapshot,
    right: SchemaSnapshot,
    renames: readonly SchemaRename[],
  ): Promise<CompareItem[]> {
    this.compared.push({ left, right, renames });
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve(
      renames.length > 0 && this.itemsWithRenames ? this.itemsWithRenames : this.items,
    );
  }

  script(
    source: SchemaSnapshot,
    target: SchemaSnapshot,
    picks: readonly string[] | null,
    renames: readonly SchemaRename[],
  ): Promise<string> {
    this.scripted.push({ source, target, picks, renames });
    return Promise.resolve(`-- makes ${target.schema} like ${source.schema}\n`);
  }
}

/** Plans without a database: the plan it was given, and what was asked. */
export class FakePlanApi extends PlanApi {
  plan: Plan = {
    nodes: [],
    raw: '',
    format: 'json',
    analyzed: false,
    totalMs: null,
    known: true,
    cut: false,
  };
  fail: { code: string; message: string } | null = null;
  readonly asked: {
    connectionId: string;
    sql: string;
    analyze: boolean;
    confirmation: string | null;
  }[] = [];

  explain(
    connectionId: string,
    sql: string,
    analyze: boolean,
    confirmation: string | null,
  ): Promise<Plan> {
    this.asked.push({ connectionId, sql, analyze, confirmation });
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve({ ...this.plan, analyzed: analyze });
  }
}

/** Charts (prompt 042): answers with a line of three points, or what a test sets. */
export class FakeChartApi extends ChartApi {
  suggestion: ChartSpec | null = {
    kind: 'line',
    x: 0,
    ys: [1],
    group: null,
    agg: 'sum',
    sort: 'none',
  };
  data: Omit<ChartData, 'chartId'> = {
    kind: 'line',
    xKind: 'number',
    categories: [],
    series: [{ name: 'name', x: [1, 2, 3], y: [10, null, 30], points: 3 }],
    xMin: 1,
    xMax: 3,
    rows: 3,
    nulls: 1,
    skipped: 0,
    cutGroups: 0,
    cutCategories: 0,
    thinned: false,
  };
  error: unknown = null;
  /** `zoom` rejects with this (a chart that is no longer kept). */
  zoomError: unknown = null;
  readonly prepared: { jobId: number; resultId: number; spec: ChartSpec; width: number }[] = [];
  readonly zooms: { chartId: number; range: readonly [number, number] | null; width: number }[] =
    [];
  readonly freed: number[] = [];
  readonly cancelled: number[] = [];
  private nextChart = 1;

  suggest(): Promise<ChartSpec | null> {
    return Promise.resolve(this.suggestion);
  }

  prepare(jobId: number, resultId: number, spec: ChartSpec, width: number): Promise<ChartData> {
    this.prepared.push({ jobId, resultId, spec, width });
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve({ ...this.data, kind: spec.kind, chartId: this.nextChart++ });
  }

  cancel(jobId: number): Promise<void> {
    this.cancelled.push(jobId);
    return Promise.resolve();
  }

  zoom(
    chartId: number,
    range: readonly [number, number] | null,
    width: number,
  ): Promise<ChartData> {
    this.zooms.push({ chartId, range, width });
    if (this.zoomError) return Promise.reject(this.zoomError);
    return Promise.resolve({ ...this.data, chartId });
  }

  free(chartId: number): Promise<void> {
    this.freed.push(chartId);
    return Promise.resolve();
  }
}

/** The structure of tables (prompt 043): one table, a plan that a test sets, and what was applied. */
export class FakeStructureApi extends StructureApi {
  table: TableDef = {
    name: 'orders',
    columns: [
      { name: 'id', typeName: 'integer', nullable: false, default: null },
      { name: 'note', typeName: 'varchar(40)', nullable: true, default: "'none'" },
    ],
    pk: ['id'],
    indexes: [
      {
        name: 'orders_note',
        unique: false,
        columns: ['note'],
        definition: 'CREATE INDEX orders_note ON shop.orders USING btree (note)',
      },
    ],
    keys: [],
    checks: [],
    comment: null,
    definition: null,
  };
  loadError: unknown = null;
  planError: unknown = null;
  nextPlan: StructPlan = {
    steps: [{ sql: 'ALTER TABLE shop.orders ADD COLUMN x integer;', danger: null, note: null }],
    transactional: true,
    incomplete: false,
  };
  ran: StructRan = { done: 1, failed: null, error: null, transactional: true, rolledBack: false };
  applyError: unknown = null;
  readonly loads: string[] = [];
  readonly plans: StructRequest[] = [];
  readonly applied: {
    request: StructRequest;
    confirmations: readonly (string | null)[];
    allowDangerous: boolean;
  }[] = [];

  load(connectionId: string, schema: string, table: string): Promise<TableDef> {
    this.loads.push(`${connectionId}/${schema}.${table}`);
    return this.loadError ? Promise.reject(this.loadError) : Promise.resolve(this.table);
  }

  plan(connectionId: string, request: StructRequest): Promise<StructPlan> {
    void connectionId;
    this.plans.push(request);
    return this.planError ? Promise.reject(this.planError) : Promise.resolve(this.nextPlan);
  }

  apply(
    connectionId: string,
    request: StructRequest,
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
  ): Promise<StructRan> {
    void connectionId;
    this.applied.push({ request, confirmations, allowDangerous });
    return this.applyError ? Promise.reject(this.applyError) : Promise.resolve(this.ran);
  }
}

/** Backup and restore (prompt 044): tools a test sets, and what was asked for. */
export class FakeBackupApi extends BackupApi {
  info: BackupInfo = {
    tools: [
      { tool: 'pgDump', path: '/usr/bin/pg_dump', version: 'pg_dump (PostgreSQL) 16.3', major: 16 },
      { tool: 'pgRestore', path: '/usr/bin/pg_restore', version: 'pg_restore 16.3', major: 16 },
      { tool: 'psql', path: '/usr/bin/psql', version: 'psql (PostgreSQL) 16.3', major: 16 },
    ],
    serverMajor: 16,
  };
  kind: BackupFileKind = 'pgCustom';
  error: unknown = null;
  /** Holds a job back until a test lets it end. */
  gate: Promise<void> | null = null;
  readonly asked: ToolPaths[] = [];
  readonly dumps: { connectionId: string; spec: DumpSpec; path: string }[] = [];
  readonly restores: {
    connectionId: string;
    spec: RestoreSpec;
    path: string;
    typedName: string | null;
  }[] = [];
  readonly simples: { schema: string; data: boolean; path: string }[] = [];
  readonly copies: string[] = [];
  readonly cancelled: number[] = [];

  tools(connectionId: string, paths: ToolPaths): Promise<BackupInfo> {
    void connectionId;
    this.asked.push(paths);
    return Promise.resolve(this.info);
  }

  private async job(onLine: (line: string) => void): Promise<BackupDone> {
    onLine('pg_dump: dumping contents of table "public.orders"');
    if (this.gate) await this.gate;
    if (this.error) throw this.error;
    return { bytes: 2048, warnings: false };
  }

  dump(
    jobId: number,
    connectionId: string,
    spec: DumpSpec,
    path: string,
    paths: ToolPaths,
    onLine: (line: string) => void,
  ): Promise<BackupDone> {
    void jobId;
    void paths;
    this.dumps.push({ connectionId, spec, path });
    return this.job(onLine);
  }

  fileKind(): Promise<BackupFileKind> {
    return this.error ? Promise.reject(this.error) : Promise.resolve(this.kind);
  }

  restore(
    jobId: number,
    connectionId: string,
    spec: RestoreSpec,
    path: string,
    paths: ToolPaths,
    typedName: string | null,
    onLine: (line: string) => void,
  ): Promise<BackupDone> {
    void jobId;
    void paths;
    this.restores.push({ connectionId, spec, path, typedName });
    return this.job(onLine);
  }

  sqliteCopy(connectionId: string, path: string): Promise<number> {
    void connectionId;
    this.copies.push(path);
    return Promise.resolve(4096);
  }

  simple(
    jobId: number,
    connectionId: string,
    schema: string,
    data: boolean,
    path: string,
    onLine: (line: string) => void,
  ): Promise<BackupDone> {
    void jobId;
    void connectionId;
    this.simples.push({ schema, data, path });
    return this.job(onLine);
  }

  cancel(jobId: number): Promise<void> {
    this.cancelled.push(jobId);
    return Promise.resolve();
  }
}

/** Copying tables between connections (prompt 045): a plan and a report a test sets. */
export class FakeTransferApi extends TransferApi {
  nextPlan: TransferPlan = {
    tables: [
      {
        table: 'orders',
        exists: false,
        columns: [
          { name: 'id', sourceType: 'integer', target: 'id', targetType: 'int', loss: null },
          {
            name: 'at',
            sourceType: 'timestamptz',
            target: 'at',
            targetType: 'datetime(6)',
            loss: 'the time zone is lost: the instant is stored as UTC',
          },
        ],
        notes: [],
        before: ['CREATE TABLE copy.orders (id int NOT NULL, at datetime(6));'],
        after: [],
      },
    ],
    statements: [
      'CREATE TABLE copy.orders (id int NOT NULL, at datetime(6));',
      'INSERT INTO copy.orders (id, at) VALUES (?, ?)',
    ],
    cycle: [],
  };
  planError: unknown = null;
  report: TransferReport = {
    tables: [
      {
        table: 'orders',
        skipped: false,
        loaded: {
          read: 1200,
          written: 1200,
          skipped: 0,
          errors: [],
          cancelled: false,
          failed: false,
          rolledBack: false,
          errorFile: false,
          cleared: false,
        },
        created: true,
        elapsedMs: 1500,
        error: null,
      },
    ],
    afterErrors: [],
    cancelled: false,
  };
  runError: unknown = null;
  gate: Promise<void> | null = null;
  readonly plans: { source: string; target: string; request: TransferRequest }[] = [];
  readonly runs: {
    source: string;
    target: string;
    request: TransferRequest;
    confirmations: readonly (string | null)[];
    errorPath: string | null;
  }[] = [];
  readonly cancelled: number[] = [];

  plan(source: string, target: string, request: TransferRequest): Promise<TransferPlan> {
    this.plans.push({ source, target, request });
    return this.planError ? Promise.reject(this.planError) : Promise.resolve(this.nextPlan);
  }

  async run(
    jobId: number,
    source: string,
    target: string,
    request: TransferRequest,
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
    errorPath: string | null,
    timeoutMs: number,
    onEvent: (event: TransferEvent) => void,
  ): Promise<TransferReport> {
    void jobId;
    void allowDangerous;
    void timeoutMs;
    this.runs.push({ source, target, request, confirmations, errorPath });
    onEvent({ kind: 'table', table: 'orders', index: 0, of: 1 });
    onEvent({ kind: 'rows', table: 'orders', read: 800 });
    if (this.gate) await this.gate;
    if (this.runError) throw this.runError;
    return this.report;
  }

  cancel(jobId: number): Promise<void> {
    this.cancelled.push(jobId);
    return Promise.resolve();
  }
}

/** The server monitor (prompt 046): readings a test sets, and what was ended. */
export class FakeMonitorApi extends MonitorApi {
  next: ServerActivity = {
    sessions: [],
    figures: {
      version: 'PostgreSQL 17.0',
      connections: 3,
      maxConnections: 100,
      transactions: 1000,
      databaseBytes: 8_000_000,
      uptimeS: 3600,
    },
    cut: false,
    missing: [],
    canCancel: true,
  };
  failWith: unknown = null;
  killResult = true;
  readonly readings: string[] = [];
  readonly kills: { connectionId: string; sessionId: string; terminate: boolean }[] = [];
  readonly closes: string[] = [];

  activity(connectionId: string): Promise<ServerActivity> {
    this.readings.push(connectionId);
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(this.next);
  }

  kill(connectionId: string, sessionId: string, terminate: boolean): Promise<boolean> {
    this.kills.push({ connectionId, sessionId, terminate });
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(this.killResult);
  }

  close(connectionId: string): Promise<void> {
    this.closes.push(connectionId);
    return Promise.resolve();
  }
}

/** Users, roles and rights (prompt 047): a list and grants a test sets; plans are written like PostgreSQL. */
export class FakeAccessApi extends AccessApi {
  access: Access = {
    principals: [
      {
        who: { name: 'admin', host: '' },
        label: 'admin',
        login: true,
        attributes: ['superuser'],
        memberOf: [],
        superuser: true,
        me: true,
      },
      {
        who: { name: 'ann', host: '' },
        label: 'ann',
        login: true,
        attributes: [],
        memberOf: ['readers'],
        superuser: false,
        me: false,
      },
      {
        who: { name: 'readers', host: '' },
        label: 'readers',
        login: false,
        attributes: [],
        memberOf: [],
        superuser: false,
        me: false,
      },
    ],
    me: 'admin',
    canManage: true,
    missing: [],
  };
  grantsOf: Record<string, GrantList> = {};
  failPlan: unknown = null;
  ran: StructRan = { done: 0, failed: null, error: null, transactional: true, rolledBack: false };
  hidesPassword = true;
  readonly plans: AccessChange[][] = [];
  readonly applied: {
    changes: readonly AccessChange[];
    passwords: readonly (string | null)[];
    confirmations: readonly (string | null)[];
  }[] = [];
  readonly scripts: Who[] = [];

  list(): Promise<Access> {
    return Promise.resolve(this.access);
  }

  grants(_connectionId: string, who: Who): Promise<GrantList> {
    return Promise.resolve(this.grantsOf[who.name] ?? { grants: [], cut: false, missing: [] });
  }

  plan(_connectionId: string, changes: readonly AccessChange[]): Promise<AccessPlan> {
    this.plans.push([...changes]);
    if (this.failPlan) return Promise.reject(this.failPlan);
    return Promise.resolve({
      steps: changes.map((c, change) => ({
        sql: fakeAccessSql(c),
        dangers:
          c.op === 'drop' ? ['drop'] : c.op === 'grant' && c.privilege === 'ALL' ? ['all'] : [],
        change,
        secret: c.op === 'password' || (c.op === 'create' && c.password),
      })),
      transactional: true,
      hidesPassword: this.hidesPassword,
    });
  }

  script(_connectionId: string, who: Who): Promise<string> {
    this.scripts.push(who);
    return Promise.resolve(`GRANT SELECT ON TABLE "public"."orders" TO "${who.name}";\n`);
  }

  apply(
    _connectionId: string,
    changes: readonly AccessChange[],
    passwords: readonly (string | null)[],
    confirmations: readonly (string | null)[],
  ): Promise<StructRan> {
    this.applied.push({ changes, passwords, confirmations });
    return Promise.resolve(
      this.ran.failed === null ? { ...this.ran, done: changes.length } : this.ran,
    );
  }
}

function fakeAccessSql(c: AccessChange): string {
  switch (c.op) {
    case 'create':
      return `CREATE ROLE "${c.who.name}"${c.login ? ' LOGIN' : ''}${c.password ? " PASSWORD '***'" : ''}`;
    case 'drop':
      return `DROP ROLE "${c.who.name}"`;
    case 'password':
      return `ALTER ROLE "${c.who.name}" PASSWORD '***'`;
    case 'attribute':
      return `ALTER ROLE "${c.who.name}" ${c.on ? '' : 'NO'}${c.attribute.toUpperCase()}`;
    case 'member':
      return c.add
        ? `GRANT "${c.role.name}" TO "${c.member.name}"`
        : `REVOKE "${c.role.name}" FROM "${c.member.name}"`;
    case 'grant':
      return c.add
        ? `GRANT ${c.privilege} ON TABLE "${c.schema}"."${c.object}" TO "${c.who.name}"`
        : `REVOKE ${c.privilege} ON TABLE "${c.schema}"."${c.object}" FROM "${c.who.name}"`;
  }
}
