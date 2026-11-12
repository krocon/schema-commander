import { translatable } from '../../core/i18n/i18n';
import { DIAGRAM_DE } from './diagram-texts.de';

const n = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count.toLocaleString('en')} ${many}`;

/** Texts of the ER diagram (prompt 037). English is the source. */
export const DIAGRAM_EN = {
  title: (schema: string) => `Diagram of ${schema}`,
  titleTable: (table: string) => `Diagram around ${table}`,
  loading: 'Reading the schema …',
  failed: (why: string) => `The schema could not be read: ${why}`,
  empty: 'This schema has no tables.',
  search: 'Find a table',
  detail: 'Show',
  detailNames: 'names only',
  detailKeys: 'keys',
  detailAll: 'all columns',
  depth: 'Neighbours up to',
  depthN: (depth: number) => (depth === 1 ? '1 key away' : `${depth} keys away`),
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Show all',
  arrange: 'Arrange again',
  tables: 'Tables',
  relations: 'Relations',
  noRelations: 'No relations in this diagram.',
  openData: 'Open data',
  details: 'Details',
  remove: 'Remove from the diagram',
  add: 'Add a table',
  addChoose: '– choose –',
  addNeighbours: 'Add its neighbours',
  saveSvg: 'Save as SVG …',
  copyMermaid: 'Copy as Mermaid',
  copyDbml: 'Copy as DBML',
  copied: 'Copied.',
  saved: (file: string) => `Saved as ${file}.`,
  saveFailed: 'The file could not be written.',
  close: 'Close',
  drawing: (tables: number, relations: number) =>
    `${n(tables, 'table', 'tables')}, ${n(relations, 'relation', 'relations')}`,
  drawingLabel: (tables: number, relations: number) =>
    `Diagram with ${n(tables, 'table', 'tables')} and ${n(relations, 'relation', 'relations')}; the list beside it holds the same`,
  limited: (shown: number, all: number) =>
    `The schema has ${all.toLocaleString('en')} tables; the ${shown} with the most relations are shown. Add others from the list.`,
  cut: 'The schema has more tables than a diagram reads.',
  outside: (count: number) =>
    count === 1
      ? '1 relation leads out of this schema and is not drawn.'
      : `${count} relations lead out of this schema and are not drawn.`,
  pointsTo: (columns: string, table: string, refColumns: string) =>
    `${columns} → ${table} (${refColumns})`,
  pointedFrom: (table: string, columns: string, refColumns: string) =>
    `${table} (${columns}) → ${refColumns}`,
  one: 'exactly one',
  zeroOrOne: 'at most one',
  many: 'many',
  virtual: 'defined here, not in the database',
};

export const DIAGRAM_TEXTS = translatable('diagram', DIAGRAM_EN, { de: DIAGRAM_DE });
