/** Backup and restore (prompt 044): what the dialog offers and asks for. Pure. */
import {
  BackupFileKind,
  BackupInfo,
  BackupTool,
  DumpFormat,
  DumpSpec,
  RestoreSpec,
  ToolInfo,
} from '../../core/backup/backup-api';
import { DbKind, Protection } from '../../core/connections/connection.models';

/** The name of a tool as its program is called. */
export const TOOL_NAMES: Readonly<Record<BackupTool, string>> = {
  pgDump: 'pg_dump',
  pgRestore: 'pg_restore',
  psql: 'psql',
  mysqlDump: 'mysqldump',
  mysql: 'mysql',
};

/** The tool a backup is written with; `null`: this database has none we start. */
export function dumpTool(kind: DbKind): BackupTool | null {
  return kind === 'postgres' ? 'pgDump' : kind === 'mysql' ? 'mysqlDump' : null;
}

/** The tool a file is restored with; `null`: none (the file is not for this database). */
export function restoreTool(kind: DbKind, file: BackupFileKind): BackupTool | null {
  const text = file === 'sql' || file === 'sqlGzip';
  if (kind === 'postgres') return text ? 'psql' : 'pgRestore';
  if (kind === 'mysql') return text ? 'mysql' : null;
  return null;
}

/** The formats a backup of a database can have. */
export function formatsOf(kind: DbKind): readonly DumpFormat[] {
  return kind === 'postgres' ? ['sql', 'custom', 'directory'] : ['sql'];
}

export const tool = (info: BackupInfo | null, which: BackupTool | null): ToolInfo | null =>
  (which && info?.tools.find((t) => t.tool === which)) || null;

/** A tool that is older than the server may not know everything the server has. */
export function olderThanServer(info: BackupInfo | null, which: BackupTool | null): boolean {
  const found = tool(info, which);
  return (
    !!found &&
    found.major !== null &&
    info?.serverMajor !== null &&
    info?.serverMajor !== undefined &&
    found.major < info.serverMajor
  );
}

export const DEFAULT_DUMP: DumpSpec = {
  format: 'sql',
  gzip: false,
  content: 'all',
  noOwner: false,
  inserts: false,
  schemas: [],
  tables: [],
};

export const DEFAULT_RESTORE: RestoreSpec = {
  clean: false,
  singleTransaction: true,
  stopOnError: true,
  noOwner: false,
};

/** A spec as the tool of a database can take it: what it does not know is switched off. */
export function fitted(kind: DbKind, spec: DumpSpec): DumpSpec {
  const format = formatsOf(kind).includes(spec.format) ? spec.format : 'sql';
  return {
    ...spec,
    format,
    gzip: format === 'sql' && spec.gzip,
    // MySQL knows no schemas inside a database, and nothing of owners
    schemas: kind === 'postgres' ? spec.schemas : [],
    noOwner: kind === 'postgres' && spec.noOwner,
  };
}

const two = (n: number) => String(n).padStart(2, '0');

/** A name for the file: `shop-2026-11-12.sql.gz`. Only letters, digits, `_` and `-` of the name stay. */
export function fileName(base: string, spec: Pick<DumpSpec, 'format' | 'gzip'>, now: Date): string {
  const safe = base.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'backup';
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const extension = spec.format === 'custom' ? '.dump' : spec.format === 'directory' ? '' : '.sql';
  return `${safe}-${date}${extension}${spec.format === 'sql' && spec.gzip ? '.gz' : ''}`;
}

/** The filters of the save dialog for a format. */
export function saveFilters(
  spec: Pick<DumpSpec, 'format' | 'gzip'>,
): { name: string; extensions: string[] }[] {
  if (spec.format === 'custom') return [{ name: 'pg_dump', extensions: ['dump'] }];
  if (spec.format === 'directory') return [];
  return spec.gzip
    ? [{ name: 'SQL (gzip)', extensions: ['gz'] }]
    : [{ name: 'SQL', extensions: ['sql'] }];
}

/** What a restore needs of the user before it may start, by the protection of the connection. */
export function restoreGate(
  protection: Protection,
  connectionName: string,
  typedName: string,
  understood: boolean,
): 'readOnly' | 'typeName' | 'confirm' | null {
  if (protection === 'readonly') return 'readOnly';
  if (protection === 'ask') return typedName.trim() === connectionName.trim() ? null : 'typeName';
  return understood ? null : 'confirm';
}

/** `1.5 MB`. */
export function sizeText(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unit]}`;
}

/** Lines of output kept for the dialog: the newest. */
export const MAX_LINES = 500;

export function withLine(lines: readonly string[], line: string): string[] {
  const next = [...lines, line];
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}
