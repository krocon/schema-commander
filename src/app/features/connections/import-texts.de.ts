import type { Translation } from '../../core/i18n/i18n';
import type { IMPORT_EN } from './import-texts';

export const IMPORT_DE: Translation<typeof IMPORT_EN> = {
  title: 'Verbindungen importieren',
  source: 'Quelle',
  chooseFile: 'Datei wählen …',
  read: 'Lesen',
  found: 'Gefundene Verbindungen',
  nameTaken: 'Name vergeben',
  nameTakenHint: 'Der Name ist vergeben; die neue Verbindung bekommt eine Nummer',
  takePassword: 'Passwort übernehmen',
  imported: (n) => (n === 1 ? '1 Verbindung übernommen.' : `${n} Verbindungen übernommen.`),
  exportOwn: 'Eigene Verbindungen exportieren …',
  run: 'Importieren',
  chooseFileTitle: 'Datei mit Verbindungen wählen',
  allFiles: 'Alle Dateien',
  exportTitle: 'Verbindungen exportieren',
  exportFileName: 'verbindungen.json',
  sources: {
    pgpass: {
      label: '~/.pgpass (PostgreSQL)',
      hint: 'Passwörter stehen dort im Klartext und lassen sich mitnehmen.',
    },
    'pg-service': { label: '~/.pg_service.conf (PostgreSQL)', hint: '' },
    'my-cnf': { label: '~/.my.cnf (MySQL, MariaDB)', hint: '' },
    dbeaver: {
      label: 'DBeaver (data-sources.json)',
      hint: 'Benutzer und Passwörter verschlüsselt DBeaver getrennt; sie werden nicht gelesen.',
    },
    datagrip: {
      label: 'DataGrip / JetBrains (dataSources.xml)',
      hint: 'Liegt im Ordner .idea eines Projekts; Passwörter hält die IDE im Schlüsselbund.',
    },
    environment: {
      label: 'Umgebungsvariablen (PG*, MYSQL_*)',
      hint: 'So, wie die App gestartet wurde.',
    },
    own: { label: 'Export von Schema Commander', hint: 'Enthält nie Passwörter.' },
  },
  nothingThere: 'Dort steht keine Verbindung, die sich übernehmen lässt.',
  selected: (n, total) => `${n} von ${total} ausgewählt`,
  withPassword: (n) => `${n} mit Passwort (in den Schlüsselbund)`,
  incomplete: (n) => `${n} unvollständig`,
  userMissing: 'Der Benutzer fehlt – nach dem Anlegen im Dialog ergänzen.',
  hostMissing: 'Der Host fehlt.',
  pathMissing: 'Der Pfad der Datei fehlt.',
};
