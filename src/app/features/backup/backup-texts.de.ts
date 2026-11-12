import type { BackupTexts } from './backup-texts';

export const BACKUP_DE: BackupTexts = {
  backupTitle: (connection) => `${connection} sichern`,
  restoreTitle: (connection) => `In ${connection} wiederherstellen`,
  checking: 'Suche die Werkzeuge der Datenbank …',
  tool: 'Werkzeug',
  found: (version) => `gefunden: ${version}`,
  notFound: (name) => `${name} ist auf diesem Rechner nicht vorhanden.`,
  whereToGet: {
    postgres:
      'Es kommt mit PostgreSQL und mit dessen Client-Werkzeugen (Pakete „postgresql-client“ oder „libpq“). Diese App lädt nichts herunter.',
    mysql:
      'Es kommt mit MySQL oder MariaDB und mit deren Client-Werkzeugen (Pakete „mysql-client“ oder „mariadb-client“). Diese App lädt nichts herunter.',
  },
  path: (name) => `Vollständiger Pfad zu ${name}`,
  pathHint: 'Leer lassen, um an den üblichen Orten zu suchen.',
  checkAgain: 'Erneut suchen',
  older: (tool, server) =>
    `Das Werkzeug hat Version ${tool}, der Server ${server}: Ein älteres Werkzeug schreibt womöglich nicht alles, was der Server hat.`,
  noTool: {
    sqlserver:
      'SQL Server hat kein Werkzeug, das diese App startet: Der einfache Export unten schreibt Tabellen und Zeilen als SQL.',
    sqlite:
      'Eine SQLite-Datenbank ist eine Datei: Sie wird kopiert – konsistent, auch während sie benutzt wird.',
  },
  scope: 'Was',
  wholeDatabase: 'Die ganze Datenbank',
  onlySchemas: (names) => `Nur das Schema ${names}`,
  onlyTables: (names) => `Nur die Tabelle ${names}`,
  content: 'Inhalt',
  contents: { all: 'Struktur und Zeilen', structure: 'Nur Struktur', data: 'Nur Zeilen' },
  format: 'Format',
  formats: {
    sql: 'SQL (Text)',
    custom: 'Archiv von pg_dump (komprimiert)',
    directory: 'Verzeichnis von pg_dump',
  },
  gzip: 'Komprimieren (.gz)',
  noOwner: 'Ohne Besitzer und Rechte',
  inserts: 'INSERT-Anweisungen statt COPY (langsamer, portabler)',
  start: 'Sichern …',
  saveTitle: 'Sicherung speichern unter',
  simple: 'Einfacher Export',
  simpleHint:
    'Von dieser App geschrieben, ohne die Werkzeuge der Datenbank: die Tabellen eines Schemas als CREATE- und INSERT-Anweisungen. Nicht darin: Rechte, Sequenzen, Identity, Kommentare, Routinen.',
  simpleSchema: 'Schema',
  simpleData: 'Mit den Zeilen',
  simpleStart: 'Einfacher Export …',
  sqliteCopy: 'Datenbankdatei kopieren …',
  copied: (size) => `Kopiert: ${size}.`,
  file: 'Datei',
  chooseFile: 'Datei wählen …',
  chooseFolder: 'Verzeichnis wählen (pg_dump) …',
  openTitle: 'Sicherung zum Wiederherstellen',
  kinds: {
    sql: 'SQL (Text)',
    sqlGzip: 'SQL (Text), komprimiert',
    pgCustom: 'Archiv von pg_dump',
    pgDirectory: 'Verzeichnis von pg_dump',
  },
  notForThis:
    'Diese Datei ist keine Sicherung, aus der sich diese Datenbank mit ihren Werkzeugen wiederherstellen lässt.',
  options: 'Optionen',
  clean: 'Vorher löschen, was die Sicherung enthält',
  singleTransaction: 'In einer Transaktion: alles oder nichts',
  stopOnError: 'Beim ersten Fehler anhalten',
  writesInto: (database, connection) =>
    `Das schreibt in die Datenbank „${database}“ von ${connection}: Ausgeführt wird, was in der Datei steht.`,
  trustFile:
    'Nur Dateien wiederherstellen, denen du traust: Eine Sicherung als Text kann Befehle des Werkzeugs enthalten, die Programme auf diesem Rechner starten.',
  readOnly: 'Diese Verbindung ist nur lesend: In sie wird nichts wiederhergestellt.',
  typeName: (name) => `Zum Fortfahren den Namen der Verbindung eingeben: ${name}`,
  typedName: 'Name der Verbindung',
  understood: 'Mir ist klar, dass das die Datenbank ändert.',
  restore: 'Wiederherstellen',
  output: 'Was das Werkzeug sagt',
  running: 'Läuft …',
  cancel: 'Abbrechen',
  stop: 'Anhalten',
  close: 'Schließen',
  done: (size) => `Erledigt: ${size}.`,
  doneWarnings:
    'Erledigt – mit Fehlern, die das Werkzeug übergangen hat: Lesen, was es gesagt hat.',
  stopped: 'Angehalten: Nichts ist zurückgeblieben.',
  failed: 'Fehlgeschlagen:',
};
