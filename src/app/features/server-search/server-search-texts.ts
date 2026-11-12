import { translatable } from '../../core/i18n/i18n';
import { SERVER_SEARCH_DE } from './server-search-texts.de';

const n = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count.toLocaleString('en')} ${many}`;

/** Texts of the search on the server (prompt 036). English is the source. */
export const SERVER_SEARCH_EN = {
  title: 'Search on the server',
  titleTable: (table: string) => `Search in ${table}`,
  text: 'Text',
  mode: 'Match',
  contains: 'contains',
  exact: 'is exactly',
  regex: 'regular expression',
  caseSensitive: 'Match case',
  where: 'Search in',
  data: 'Rows of tables',
  sources: 'Definitions (views, routines, triggers, checks, defaults, comments)',
  names: 'Names of objects',
  columns: 'Columns',
  columnsText: 'texts',
  columnsNumbers: 'texts and numbers',
  columnsAll: 'everything but binary data',
  schemas: 'Schemas',
  allSchemas: 'none ticked: all',
  maxHits: 'Hits per table',
  timeout: 'Seconds per table (0: no limit)',
  skipOver: 'Leave out tables with more rows than (0: none)',
  readOnly: 'The search only reads – one table after the other.',
  guarded: 'This connection is protected: the search reads every table it may.',
  start: 'Search',
  stop: 'Stop',
  close: 'Close',
  copy: 'Copy hits',
  copied: 'Hits copied.',
  preparing: 'Reading the tables …',
  progress: (done: number, total: number, table: string) =>
    `Table ${done.toLocaleString('en')} of ${total.toLocaleString('en')}: ${table}`,
  found: (rows: number, sources: number) =>
    `${n(rows, 'row', 'rows')}, ${n(sources, 'definition', 'definitions')} found.`,
  stopped: 'Stopped.',
  lost: 'The connection was lost.',
  moreSources: 'More definitions hold the text than are shown.',
  leftOut: (count: number) => `${n(count, 'table', 'tables')} left out.`,
  failed: (why: string) => `The search failed: ${why}`,
  rowsHeading: 'Rows',
  sourcesHeading: 'Definitions',
  skippedHeading: 'Left out',
  more: 'more rows',
  openRows: 'Show rows',
  openRowsOf: (table: string, column: string) =>
    `Show the rows of ${table} where ${column} holds the text`,
  openDefinition: 'Show definition',
  openDefinitionOf: (name: string) => `Show the definition of ${name}`,
  line: (line: number) => `line ${line}`,
  anyColumn: '(column unknown)',
  kinds: {
    view: 'View',
    matview: 'Materialized view',
    routine: 'Routine',
    trigger: 'Trigger',
    check: 'Check',
    default: 'Default',
    comment: 'Comment',
    table: 'Table',
    name: 'Name',
  } as Record<string, string>,
  skipLarge: (rows: string) => `about ${rows} rows`,
  skipNoColumns: 'no column of a kind that is searched',
  skipTimeout: 'took too long',
  nothing: 'Nothing found.',
  notConnected: 'Open a connection first.',
};

export const SERVER_SEARCH_TEXTS = translatable('server-search', SERVER_SEARCH_EN, {
  de: SERVER_SEARCH_DE,
});
