import type { McpTexts } from './mcp-texts';

export const MCP_DE: McpTexts = {
  title: 'KI-Steuerung (MCP)',
  intro:
    'Ein KI-Assistent auf diesem Rechner (Claude Code und andere) kann die Struktur Ihrer Datenbanken lesen, lesende Abfragen ausführen und Anweisungen vorschlagen – nur solange dies an ist, und nur so weit, wie Sie es unten erlauben.',
  leaves:
    'Was ein Assistent liest, geht an den Assistenten und damit an dessen Anbieter. Erlauben Sie nur, was diesen Rechner verlassen darf.',
  enabled: 'KI-Steuerung ist an',
  off: 'Aus: Kein Port lauscht, kein Assistent erreicht diese App.',
  running:
    'An. Verbinden können sich nur Programme auf diesem Rechner, die Ihre Dateien lesen können.',
  connected: (n) =>
    n === 0
      ? 'Kein Assistent verbunden'
      : n === 1
        ? '1 Assistent verbunden'
        : `${n} Assistenten verbunden`,
  disconnect: 'Trennen',
  badge: (n) => (n === 1 ? 'KI verbunden' : `KI verbunden (${n})`),
  badgeHint: 'Ein KI-Assistent ist verbunden. KI-Steuerung öffnen.',
  setup: 'Assistenten einrichten',
  sidecar: 'Programm des MCP-Servers',
  sidecarMissing:
    'Das Programm wurde neben der App nicht gefunden. In der Entwicklung: pnpm mcp:dev.',
  copyCommand: 'Befehl für Claude Code kopieren',
  copyConfig: 'Eintrag für eine Konfigurationsdatei kopieren',
  copied: 'Kopiert.',
  test: 'Verbindung testen',
  testing: 'Teste …',
  testOk: (server, version, tools) =>
    `Geht: ${server} ${version}, ${tools} Werkzeuge, und die App hat geantwortet.`,
  testFailed: (step, code) => `Gescheitert bei „${step}“: ${code}`,
  steps: {
    start: 'Start des Programms',
    initialize: 'Begrüßung',
    tools: 'Liste der Werkzeuge',
    app: 'Frage an die App',
  },
  limits: 'Was hinaus darf',
  structureOnly: 'Nur Struktur, nie Daten',
  maxRows: 'Zeilen je Antwort',
  maxChars: 'Zeichen je Antwort',
  exclude: 'Ergebnisspalten verstecken, deren Name enthält',
  excludeHint:
    'Eines je Zeile. Immer versteckt: password, passwd, pwd, secret, token, api_key, private_key, credential. Das geht nach dem Namen, den eine Spalte im Ergebnis hat: Eine Abfrage, die sie umbenennt, kommt daran vorbei. Für Daten, die nicht hinaus dürfen, erlauben Sie „nur Struktur“.',
  access: 'Was ein Assistent darf, je Verbindung',
  defaultAccess: 'Verbindungen ohne Schutz',
  connection: 'Verbindung',
  level: 'Zugriff',
  levels: {
    off: 'aus',
    schema: 'nur Struktur',
    read: 'lesende Abfragen',
    write: 'Schreiben als Vorschlag',
  },
  byDefault: (level) => `Vorgabe (${level})`,
  protectedHint: 'geschützt: aus, solange Sie nichts anderes sagen',
  log: 'Protokoll',
  logHint: 'Jeder Aufruf eines Assistenten seit dem Start der App. Nur im Speicher.',
  logEmpty: 'Noch keine Aufrufe.',
  clearLog: 'Protokoll leeren',
  columns: {
    time: 'Zeit',
    tool: 'Werkzeug',
    connection: 'Verbindung',
    statement: 'Anweisung',
    rows: 'Zeilen',
    outcome: 'Ausgang',
  },
  ok: 'ok',
  close: 'Schließen',
  proposalTitle: 'Ein KI-Assistent schlägt eine Anweisung vor',
  proposalWrites: 'Diese Anweisung ändert Daten oder Struktur.',
  proposalReads: 'Diese Anweisung liest nur.',
  proposalOn: (connection) => `Auf: ${connection}`,
  proposalReason: 'Seine Begründung, in seinen Worten',
  proposalNote:
    'Lesen Sie die Anweisung selbst: Die Begründung ist, was der Assistent sagt, nicht was die Anweisung tut. Sie läuft wie eine, die Sie getippt haben, mit dem Schutz der Verbindung.',
  proposalDangerous: 'Diese Anweisung zerstört oder gibt weg (DROP, TRUNCATE, GRANT …).',
  proposalLines: (n) => `${n} Zeilen – lesen Sie bis zum Ende.`,
  proposalExpired:
    'Der Assistent wartet nicht mehr auf diesen Vorschlag: Er wurde nicht ausgeführt.',
  run: 'Ausführen',
  toTab: 'Nur in einem Tab öffnen',
  decline: 'Ablehnen',
  unknownConnection: 'diese Verbindung ist nicht mehr bekannt',
};
