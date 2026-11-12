import type { Translation } from '../../core/i18n/i18n';
import type { PLAN_EN } from './plan-texts';

export const PLAN_DE: Translation<typeof PLAN_EN> = {
  locale: 'de',
  title: 'Ausführungsplan',
  estimated: 'geschätzt – nichts wurde ausgeführt',
  analyzed: 'mit Ausführung – die Anweisung lief und wurde zurückgerollt',
  loading: 'Die Datenbank wird gefragt …',
  failed: (why: string) => `Kein Plan: ${why}`,
  noStatement: 'An der Schreibmarke steht keine Anweisung.',
  unknown:
    'Dieser Plan hat eine Form, die die App nicht kennt. Er wird gezeigt, wie die Datenbank ihn gab.',
  cut: 'Der Plan hat mehr Operationen, als gezeigt werden.',
  operation: 'Operation',
  object: 'Objekt',
  estRows: 'Zeilen gesch.',
  actRows: 'Zeilen',
  factor: 'Daneben',
  self: 'Eigene Zeit',
  total: 'Gesamtzeit',
  cost: 'Kosten',
  buffers: 'Seiten',
  loops: 'Schleifen',
  expand: (op: string) => `Zeigen, was unter ${op} liegt`,
  collapse: (op: string) => `Verbergen, was unter ${op} liegt`,
  details: 'Einzelheiten',
  noNode: 'Eine Operation wählen, um zu sehen, was die Datenbank über sie sagt.',
  hintsHeading: 'Einen Blick wert',
  hintNote: 'Hinweise, keine Urteile: Faustregeln, die deine Daten nicht kennen.',
  hints: {
    scanFilter:
      'Eine ganze Tabelle wird gelesen und die meisten Zeilen werden verworfen: Ein Index auf der Bedingung kann helfen.',
    sortOnDisk: 'Eine Sortierung passte nicht in den Speicher und ging auf die Platte.',
    misestimate:
      'Die Zeilen weichen um das Zehnfache oder mehr von der Schätzung ab: Die Statistik ist vielleicht alt.',
    manyLoops: 'Das lief tausendmal oder öfter (die innere Seite einer Schleife).',
  },
  raw: 'Plan, wie die Datenbank ihn gab',
  showRaw: 'Rohplan zeigen',
  hideRaw: 'Rohplan verbergen',
  runAnalyze: 'Plan mit Ausführung …',
  runEstimate: 'Erneut schätzen',
  copy: 'Als Text kopieren',
  copied: 'Kopiert.',
  save: 'Rohplan speichern …',
  saved: (file: string) => `Gespeichert als ${file}.`,
  saveFailed: 'Die Datei ließ sich nicht schreiben.',
  close: 'Schließen',
  analyzeTitle: 'Die Anweisung für ihren Plan ausführen?',
  analyzeQuestion:
    'Zum Messen führt die Datenbank die Anweisung aus. Die App rollt sie danach zurück – aber sie läuft, mit ihren Sperren, ihren Triggern und allem, was sie außerhalb der Datenbank tut.',
  analyzeYes: 'Ausführen und zurückrollen',
};
