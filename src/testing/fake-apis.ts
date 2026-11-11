import { ExportApi, ExportSpec, Exported } from '../app/core/backend/export-api';
import {
  ConnectionInfo,
  LoadedProfiles as LoadedConnections,
  Profile,
  ImportItem,
  ImportPick,
  ImportPreview,
  ImportSource,
  SshCredentials,
  UrlDraft,
  SshHost,
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
  Found,
  NameContext,
  NameHit,
  NameHits,
  ObjectDetails,
  ObjectInfo,
  SchemaInfo,
  TableInfo,
} from '../app/core/schema/schema.models';
import {
  Cell,
  QueryColumn,
  RowWindow,
  RunEvent,
  RunOutcome,
  TxState,
  Verdict,
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
    return this.check(id, password).then(() => ({ id, serverVersion: 'Fake 1.0' }));
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
  return { kind, schema, name, parent: null, detail, quoted: `${schema}.${name}`, marks: [0] };
}
