import { QueryApi } from '../app/core/sql/query-api';
import { QueryResult } from '../app/core/sql/query.models';
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

/** Answers every statement with `result`, or rejects with `error` when set. */
export class FakeQueryApi extends QueryApi {
  readonly statements: string[] = [];
  error: unknown = null;
  result: QueryResult = {
    columns: [
      { name: 'id', declType: 'INTEGER' },
      { name: 'name', declType: 'TEXT' },
    ],
    rows: [
      [1, 'Ada'],
      [2, null],
    ],
    truncated: false,
    rowsAffected: null,
    elapsedMs: 3,
  };

  runDemoQuery(sql: string): Promise<QueryResult> {
    this.statements.push(sql);
    return this.error ? Promise.reject(this.error) : Promise.resolve(this.result);
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
