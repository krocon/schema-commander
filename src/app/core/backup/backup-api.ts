import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';

/** Mirrors `Tool` in src-tauri/src/backup.rs (prompt 044): a program of a database. */
export type BackupTool = 'pgDump' | 'pgRestore' | 'psql' | 'mysqlDump' | 'mysql';

/** Mirrors `ToolInfo`: where a tool is and how old; `path: null` = not on this machine. */
export interface ToolInfo {
  readonly tool: BackupTool;
  readonly path: string | null;
  readonly version: string | null;
  readonly major: number | null;
}

/** Mirrors `BackupInfo`. */
export interface BackupInfo {
  readonly tools: readonly ToolInfo[];
  readonly serverMajor: number | null;
}

/** Where the user said the tools are, by tool. */
export type ToolPaths = Readonly<Partial<Record<BackupTool, string>>>;

export type DumpFormat = 'sql' | 'custom' | 'directory';
export type DumpContent = 'all' | 'structure' | 'data';

/** Mirrors `DumpSpec`. */
export interface DumpSpec {
  readonly format: DumpFormat;
  readonly gzip: boolean;
  readonly content: DumpContent;
  readonly noOwner: boolean;
  readonly inserts: boolean;
  readonly schemas: readonly string[];
  readonly tables: readonly { readonly schema: string; readonly table: string }[];
}

/** Mirrors `RestoreSpec`. */
export interface RestoreSpec {
  readonly clean: boolean;
  readonly singleTransaction: boolean;
  readonly stopOnError: boolean;
  readonly noOwner: boolean;
}

/** Mirrors `FileKind`: what a file to restore is. */
export type BackupFileKind = 'sql' | 'sqlGzip' | 'pgCustom' | 'pgDirectory';

/** Mirrors `Done`. */
export interface BackupDone {
  readonly bytes: number;
  /** The tool went on after errors it ignored. */
  readonly warnings: boolean;
}

/**
 * Backup and restore with the tools of the database (prompt 044). Paths come from the native dialogs.
 * The backend starts the programs without a shell and keeps the password out of arguments and output.
 */
export abstract class BackupApi {
  abstract tools(connectionId: string, paths: ToolPaths): Promise<BackupInfo>;
  /** A job: `cancel` ends the program and removes what it wrote. `onLine`: what the program says. */
  abstract dump(
    jobId: number,
    connectionId: string,
    spec: DumpSpec,
    path: string,
    paths: ToolPaths,
    onLine: (line: string) => void,
  ): Promise<BackupDone>;
  abstract fileKind(path: string): Promise<BackupFileKind>;
  /**
   * Rejects with `permission_denied` on a connection that only reads and with `confirmation_required`
   * when the connection asks and `typedName` is not its name.
   */
  abstract restore(
    jobId: number,
    connectionId: string,
    spec: RestoreSpec,
    path: string,
    paths: ToolPaths,
    typedName: string | null,
    onLine: (line: string) => void,
  ): Promise<BackupDone>;
  /** A copy of a SQLite database; resolves with its size. */
  abstract sqliteCopy(connectionId: string, path: string): Promise<number>;
  /** The simple export: tables of a schema as `CREATE` and `INSERT` statements. A job. */
  abstract simple(
    jobId: number,
    connectionId: string,
    schema: string,
    data: boolean,
    path: string,
    onLine: (line: string) => void,
  ): Promise<BackupDone>;
  abstract cancel(jobId: number): Promise<void>;
}

function lines(onLine: (line: string) => void): Channel<string> {
  const channel = new Channel<string>();
  channel.onmessage = onLine;
  return channel;
}

@Injectable()
export class TauriBackupApi extends BackupApi {
  tools(connectionId: string, paths: ToolPaths): Promise<BackupInfo> {
    return call('backup_tools', { id: connectionId, paths });
  }

  dump(
    jobId: number,
    connectionId: string,
    spec: DumpSpec,
    path: string,
    paths: ToolPaths,
    onLine: (line: string) => void,
  ): Promise<BackupDone> {
    return call('backup_dump', {
      jobId,
      id: connectionId,
      spec,
      path,
      paths,
      onLine: lines(onLine),
    });
  }

  fileKind(path: string): Promise<BackupFileKind> {
    return call('backup_file_kind', { path });
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
    return call('backup_restore', {
      jobId,
      id: connectionId,
      spec,
      path,
      paths,
      typedName,
      onLine: lines(onLine),
    });
  }

  sqliteCopy(connectionId: string, path: string): Promise<number> {
    return call('backup_sqlite', { id: connectionId, path });
  }

  simple(
    jobId: number,
    connectionId: string,
    schema: string,
    data: boolean,
    path: string,
    onLine: (line: string) => void,
  ): Promise<BackupDone> {
    return call('backup_simple', {
      jobId,
      id: connectionId,
      schema,
      data,
      path,
      onLine: lines(onLine),
    });
  }

  cancel(jobId: number): Promise<void> {
    return call('cancel_job', { jobId });
  }
}
