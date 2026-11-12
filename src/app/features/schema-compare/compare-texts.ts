import { translatable } from '../../core/i18n/i18n';
import { COMPARE_DE } from './compare-texts.de';

const n = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count.toLocaleString('en')} ${many}`;

/** Texts of the schema comparison (prompt 038). English is the source. */
export const COMPARE_EN = {
  title: 'Compare schemas',
  left: 'Left',
  right: 'Right',
  connection: 'Connection',
  schema: 'Schema',
  chooseConnection: '– choose –',
  loadSnapshot: 'Load snapshot …',
  saveSnapshot: 'Save as snapshot …',
  snapshotFile: 'Snapshot of a schema',
  snapshotOf: (schema: string, tables: number, views: number) =>
    `Snapshot of ${schema}: ${n(tables, 'table', 'tables')}, ${n(views, 'view', 'views')}`,
  notASnapshot: 'This file is no snapshot of a schema.',
  compare: 'Compare',
  comparing: 'Reading both schemas …',
  failed: (why: string) => `The comparison failed: ${why}`,
  summary: (onlyLeft: number, onlyRight: number, different: number, same: number) =>
    `Only left: ${onlyLeft} · only right: ${onlyRight} · different: ${different} · the same: ${same}`,
  noDifferences: 'No differences.',
  onlyDifferences: 'Only differences',
  kind: 'Kind',
  allKinds: 'all',
  object: 'Object',
  stateHeading: 'State',
  find: 'Find an object',
  kinds: {
    table: 'Table',
    column: 'Column',
    primaryKey: 'Primary key',
    index: 'Index',
    key: 'Foreign key',
    check: 'Check',
    view: 'View',
    routine: 'Routine',
    trigger: 'Trigger',
  },
  states: {
    same: 'the same',
    onlyLeft: 'only left',
    onlyRight: 'only right',
    different: 'different',
  },
  pick: (label: string) => `Take ${label} into the script`,
  pickAll: 'all',
  pickNone: 'none',
  items: 'Objects',
  definitions: (label: string) => `Definitions of ${label}`,
  nothingThere: '(not there)',
  scriptRight: 'Script: make right like left',
  scriptLeft: 'Script: make left like right',
  scriptHint:
    'The script opens in a tab. Nothing runs by itself; steps that may lose data are comments.',
  scriptTitle: (schema: string) => `Migration of ${schema}`,
  markRename: 'These two are one (renamed)',
  renames: 'Renamed',
  renameLine: (table: string | null, from: string, to: string) =>
    table ? `${table}: ${from} → ${to}` : `${from} → ${to}`,
  removeRename: (from: string) => `No rename of ${from} after all`,
  report: 'Save report …',
  reportTitle: (left: string, right: string) => `Schemas compared: ${left} and ${right}`,
  saved: (file: string) => `Saved as ${file}.`,
  saveFailed: 'The file could not be written.',
  readFailed: 'The file could not be read.',
  close: 'Close',
  needBoth: 'Choose a schema or a snapshot on both sides.',
};

export const COMPARE_TEXTS = translatable('compare', COMPARE_EN, { de: COMPARE_DE });
