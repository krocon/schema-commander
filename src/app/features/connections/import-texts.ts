import { translatable } from '../../core/i18n/i18n';
import { IMPORT_DE } from './import-texts.de';

/** Texts of the import of connections (prompt 015). English is the source. */
export const IMPORT_EN = {
  title: 'Import connections',
  source: 'Source',
  chooseFile: 'Choose file …',
  read: 'Read',
  found: 'Connections found',
  nameTaken: 'Name taken',
  nameTakenHint: 'The name is taken; the new connection gets a number',
  takePassword: 'Take the password',
  imported: (n: number) => (n === 1 ? '1 connection imported.' : `${n} connections imported.`),
  exportOwn: 'Export own connections …',
  run: 'Import',
  chooseFileTitle: 'Choose a file with connections',
  allFiles: 'All files',
  exportTitle: 'Export connections',
  /** The file name the export suggests. */
  exportFileName: 'connections.json',
  /** Label and hint of each source, by `ImportSource` (`''` = no hint). */
  sources: {
    pgpass: {
      label: '~/.pgpass (PostgreSQL)',
      hint: 'Passwords stand there in clear text and can be taken along.',
    },
    'pg-service': { label: '~/.pg_service.conf (PostgreSQL)', hint: '' },
    'my-cnf': { label: '~/.my.cnf (MySQL, MariaDB)', hint: '' },
    dbeaver: {
      label: 'DBeaver (data-sources.json)',
      hint: 'DBeaver encrypts users and passwords separately; they are not read.',
    },
    datagrip: {
      label: 'DataGrip / JetBrains (dataSources.xml)',
      hint: 'Lives in the .idea folder of a project; the IDE keeps passwords in the keychain.',
    },
    environment: {
      label: 'Environment variables (PG*, MYSQL_*)',
      hint: 'As they were when the app was started.',
    },
    own: { label: 'Export of Schema Commander', hint: 'Never contains passwords.' },
  },
  nothingThere: 'There is no connection there that can be imported.',
  selected: (n: number, total: number) => `${n} of ${total} selected`,
  withPassword: (n: number) => `${n} with password (into the keychain)`,
  incomplete: (n: number) => `${n} incomplete`,
  userMissing: 'The user is missing – add it in the dialog after the import.',
  hostMissing: 'The host is missing.',
  pathMissing: 'The path of the file is missing.',
};

export const IMPORT_TEXTS = translatable('connectionImport', IMPORT_EN, { de: IMPORT_DE });
