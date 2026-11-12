import { translatable } from '../../core/i18n/i18n';
import { BACKUP_DE } from './backup-texts.de';

/** Texts of backup and restore (prompt 044). English is the source. */
export const BACKUP_EN = {
  backupTitle: (connection: string) => `Back up ${connection}`,
  restoreTitle: (connection: string) => `Restore into ${connection}`,
  checking: 'Looking for the tools of the database …',
  tool: 'Tool',
  found: (version: string) => `found: ${version}`,
  notFound: (name: string) => `${name} is not on this machine.`,
  whereToGet: {
    postgres:
      'It comes with PostgreSQL and with its client tools (packages „postgresql-client“ or „libpq“). Nothing is downloaded by this app.',
    mysql:
      'It comes with MySQL or MariaDB and with their client tools (packages „mysql-client“ or „mariadb-client“). Nothing is downloaded by this app.',
  },
  path: (name: string) => `Full path to ${name}`,
  pathHint: 'Leave empty to look in the usual places.',
  checkAgain: 'Look again',
  older: (tool: number, server: number) =>
    `The tool is version ${tool}, the server ${server}: an older tool may not write everything the server has.`,
  noTool: {
    sqlserver:
      'SQL Server has no tool this app starts: the simple export below writes tables and rows as SQL.',
    sqlite: 'A SQLite database is one file: it is copied, consistently, while it is in use.',
  },
  scope: 'What',
  wholeDatabase: 'The whole database',
  onlySchemas: (names: string) => `Only the schema ${names}`,
  onlyTables: (names: string) => `Only the table ${names}`,
  content: 'Content',
  contents: { all: 'Structure and rows', structure: 'Structure only', data: 'Rows only' },
  format: 'Format',
  formats: {
    sql: 'SQL (text)',
    custom: 'Archive of pg_dump (compressed)',
    directory: 'Folder of pg_dump',
  },
  gzip: 'Compress (.gz)',
  noOwner: 'Without owners and rights',
  inserts: 'INSERT statements instead of COPY (slower, more portable)',
  start: 'Back up …',
  saveTitle: 'Save the backup as',
  simple: 'Simple export',
  simpleHint:
    'Written by this app, without the tools of the database: the tables of one schema as CREATE and INSERT statements. Not in it: rights, sequences, identity, comments, routines.',
  simpleSchema: 'Schema',
  simpleData: 'With the rows',
  simpleStart: 'Simple export …',
  sqliteCopy: 'Copy the database file …',
  copied: (size: string) => `Copied: ${size}.`,
  file: 'File',
  chooseFile: 'Choose a file …',
  chooseFolder: 'Choose a folder (pg_dump) …',
  openTitle: 'Backup to restore',
  kinds: {
    sql: 'SQL (text)',
    sqlGzip: 'SQL (text), compressed',
    pgCustom: 'archive of pg_dump',
    pgDirectory: 'folder of pg_dump',
  },
  notForThis: 'This file is not a backup this database can be restored from with its tools.',
  options: 'Options',
  clean: 'Drop what the backup holds before creating it',
  singleTransaction: 'In one transaction: all or nothing',
  stopOnError: 'Stop at the first error',
  writesInto: (database: string, connection: string) =>
    `This writes into the database „${database}“ of ${connection}: whatever the file says is run.`,
  trustFile:
    'Restore only files you trust: a backup as text can hold commands of the tool that run programs on this machine.',
  readOnly: 'This connection is read-only: nothing is restored into it.',
  typeName: (name: string) => `Type the name of the connection to go on: ${name}`,
  typedName: 'Name of the connection',
  understood: 'I know that this changes the database.',
  restore: 'Restore',
  output: 'What the tool says',
  running: 'Running …',
  cancel: 'Cancel',
  stop: 'Stop',
  close: 'Close',
  done: (size: string) => `Done: ${size}.`,
  doneWarnings: 'Done – with errors the tool ignored: read what it said.',
  stopped: 'Stopped: nothing was left behind.',
  failed: 'Failed:',
};

export type BackupTexts = typeof BACKUP_EN;
export const BACKUP_TEXTS = translatable('backup', BACKUP_EN, { de: BACKUP_DE });
