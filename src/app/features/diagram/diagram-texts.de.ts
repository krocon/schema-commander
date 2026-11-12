import type { Translation } from '../../core/i18n/i18n';
import type { DIAGRAM_EN } from './diagram-texts';

const n = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count.toLocaleString('de')} ${many}`;

export const DIAGRAM_DE: Translation<typeof DIAGRAM_EN> = {
  title: (schema: string) => `Diagramm von ${schema}`,
  titleTable: (table: string) => `Diagramm um ${table}`,
  loading: 'Schema wird gelesen …',
  failed: (why: string) => `Das Schema ließ sich nicht lesen: ${why}`,
  empty: 'Dieses Schema hat keine Tabellen.',
  search: 'Tabelle finden',
  detail: 'Zeigen',
  detailNames: 'nur Namen',
  detailKeys: 'Schlüssel',
  detailAll: 'alle Spalten',
  depth: 'Nachbarn bis',
  depthN: (depth: number) => (depth === 1 ? '1 Schlüssel entfernt' : `${depth} Schlüssel entfernt`),
  zoomIn: 'Vergrößern',
  zoomOut: 'Verkleinern',
  fit: 'Alles zeigen',
  arrange: 'Neu anordnen',
  tables: 'Tabellen',
  relations: 'Beziehungen',
  noRelations: 'Keine Beziehungen in diesem Diagramm.',
  openData: 'Daten öffnen',
  details: 'Einzelheiten',
  remove: 'Aus dem Diagramm nehmen',
  add: 'Tabelle hinzufügen',
  addChoose: '– wählen –',
  addNeighbours: 'Ihre Nachbarn hinzufügen',
  saveSvg: 'Als SVG speichern …',
  copyMermaid: 'Als Mermaid kopieren',
  copyDbml: 'Als DBML kopieren',
  copied: 'Kopiert.',
  saved: (file: string) => `Gespeichert als ${file}.`,
  saveFailed: 'Die Datei ließ sich nicht schreiben.',
  close: 'Schließen',
  drawing: (tables: number, relations: number) =>
    `${n(tables, 'Tabelle', 'Tabellen')}, ${n(relations, 'Beziehung', 'Beziehungen')}`,
  drawingLabel: (tables: number, relations: number) =>
    `Diagramm mit ${n(tables, 'Tabelle', 'Tabellen')} und ${n(relations, 'Beziehung', 'Beziehungen')}; die Liste daneben enthält dasselbe`,
  limited: (shown: number, all: number) =>
    `Das Schema hat ${all.toLocaleString('de')} Tabellen; gezeigt sind die ${shown} mit den meisten Beziehungen. Weitere aus der Liste hinzufügen.`,
  cut: 'Das Schema hat mehr Tabellen, als ein Diagramm liest.',
  outside: (count: number) =>
    count === 1
      ? '1 Beziehung führt aus diesem Schema hinaus und ist nicht gezeichnet.'
      : `${count} Beziehungen führen aus diesem Schema hinaus und sind nicht gezeichnet.`,
  pointsTo: (columns: string, table: string, refColumns: string) =>
    `${columns} → ${table} (${refColumns})`,
  pointedFrom: (table: string, columns: string, refColumns: string) =>
    `${table} (${columns}) → ${refColumns}`,
  one: 'genau eine',
  zeroOrOne: 'höchstens eine',
  many: 'viele',
  virtual: 'hier festgelegt, nicht in der Datenbank',
};
