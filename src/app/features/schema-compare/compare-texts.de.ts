import type { Translation } from '../../core/i18n/i18n';
import type { COMPARE_EN } from './compare-texts';

const n = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count.toLocaleString('de')} ${many}`;

export const COMPARE_DE: Translation<typeof COMPARE_EN> = {
  title: 'Schemata vergleichen',
  left: 'Links',
  right: 'Rechts',
  connection: 'Verbindung',
  schema: 'Schema',
  chooseConnection: '– wählen –',
  loadSnapshot: 'Schnappschuss laden …',
  saveSnapshot: 'Als Schnappschuss speichern …',
  snapshotFile: 'Schnappschuss eines Schemas',
  snapshotOf: (schema: string, tables: number, views: number) =>
    `Schnappschuss von ${schema}: ${n(tables, 'Tabelle', 'Tabellen')}, ${n(views, 'View', 'Views')}`,
  notASnapshot: 'Diese Datei ist kein Schnappschuss eines Schemas.',
  compare: 'Vergleichen',
  comparing: 'Beide Schemata werden gelesen …',
  failed: (why: string) => `Der Vergleich ist gescheitert: ${why}`,
  summary: (onlyLeft: number, onlyRight: number, different: number, same: number) =>
    `Nur links: ${onlyLeft} · nur rechts: ${onlyRight} · verschieden: ${different} · gleich: ${same}`,
  noDifferences: 'Keine Unterschiede.',
  onlyDifferences: 'Nur Unterschiede',
  kind: 'Art',
  allKinds: 'alle',
  object: 'Objekt',
  stateHeading: 'Zustand',
  find: 'Objekt finden',
  kinds: {
    table: 'Tabelle',
    column: 'Spalte',
    primaryKey: 'Primärschlüssel',
    index: 'Index',
    key: 'Fremdschlüssel',
    check: 'Check',
    view: 'View',
    routine: 'Routine',
    trigger: 'Trigger',
  },
  states: {
    same: 'gleich',
    onlyLeft: 'nur links',
    onlyRight: 'nur rechts',
    different: 'verschieden',
  },
  pick: (label: string) => `${label} ins Skript nehmen`,
  pickAll: 'alle',
  pickNone: 'keine',
  items: 'Objekte',
  definitions: (label: string) => `Definitionen von ${label}`,
  nothingThere: '(nicht vorhanden)',
  scriptRight: 'Skript: rechts wie links machen',
  scriptLeft: 'Skript: links wie rechts machen',
  scriptHint:
    'Das Skript öffnet sich in einem Tab. Nichts läuft von selbst; Schritte, die Daten kosten können, sind Kommentare.',
  scriptTitle: (schema: string) => `Migration von ${schema}`,
  markRename: 'Diese beiden sind eins (umbenannt)',
  renames: 'Umbenannt',
  renameLine: (table: string | null, from: string, to: string) =>
    table ? `${table}: ${from} → ${to}` : `${from} → ${to}`,
  removeRename: (from: string) => `Doch keine Umbenennung von ${from}`,
  report: 'Bericht speichern …',
  reportTitle: (left: string, right: string) => `Schemata verglichen: ${left} und ${right}`,
  saved: (file: string) => `Gespeichert als ${file}.`,
  saveFailed: 'Die Datei ließ sich nicht schreiben.',
  readFailed: 'Die Datei ließ sich nicht lesen.',
  close: 'Schließen',
  needBoth: 'Auf beiden Seiten ein Schema oder einen Schnappschuss wählen.',
};
