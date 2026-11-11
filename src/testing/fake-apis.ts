import {
  ConnectionInfo,
  LoadedProfiles as LoadedConnections,
  Profile,
} from '../app/core/connections/connection.models';
import { ConnectionsApi } from '../app/core/connections/connections-api';
import { LoadedSession, SessionApi, SessionFile, TextFile } from '../app/core/session/session-api';
import { QueryApi } from '../app/core/sql/query-api';
import { Cell, QueryColumn, RowWindow, RunEvent, RunOutcome } from '../app/core/sql/query.models';
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

  run(
    connection: string,
    sql: string,
    timeoutMs = 0,
    onEvent?: (event: RunEvent) => void,
  ): Promise<RunOutcome> {
    this.statements.push({ connection, sql });
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
    });
  }

  cancel(connection: string): Promise<void> {
    this.cancelled.push(connection);
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

  test(profile: Profile, password: string | null): Promise<string> {
    return this.check(profile.id, password).then(() => 'Fake 1.0');
  }

  open(id: string, password: string | null): Promise<ConnectionInfo> {
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
