import { translatable } from '../../core/i18n/i18n';
import { SCHEMA_DE } from './schema-texts.de';

/** Texts of the schema tree (prompt 008). English is the source. */
export const SCHEMA_EN = {
  title: 'Schema',
  showSystem: 'Show system schemas',
  refresh: 'Refresh',
  refreshSchema: 'Refresh schema',
  filterPlaceholder: 'Filter …',
  filterLabel: 'Filter objects',
  notConnected: 'Not connected.',
  menuLabel: 'Actions for the object',
  openData: 'Open data',
  exportTable: 'Export …',
  importTable: 'Import a file …',
  insertName: 'Insert name into the editor',
  copyName: 'Copy name',
  copyQualified: 'Copy qualified name',
  selectTemplate: 'Insert SELECT template',
  insertTemplate: 'Insert INSERT template',
  updateTemplate: 'Insert UPDATE template',
  /** The sorts of objects, by `ObjectKind`. */
  groups: {
    table: 'Tables',
    view: 'Views',
    matview: 'Materialized views',
    routine: 'Routines',
    sequence: 'Sequences',
    type: 'Types',
  },
  indexes: 'Indexes',
  keys: 'Keys',
  triggers: 'Triggers',
  loading: 'Loading …',
  current: 'current',
  empty: 'empty',
  nothingFound: 'Nothing found.',
  /** Estimated rows; `n` is the formatted number. */
  thousands: (n: string) => `~${n}k`,
  millions: (n: string) => `~${n}M`,
  /** The placeholder of the condition in an UPDATE template without a key. */
  condition: 'condition',
};

export const SCHEMA_TEXTS = translatable('schema', SCHEMA_EN, { de: SCHEMA_DE });
