import { translatable } from '../../core/i18n/i18n';
import { HISTORY_DE } from './history-texts.de';

/** Texts of the history: dialog and sidebar view (prompts 010, 016). English is the source. */
export const HISTORY_EN = {
  title: 'History',
  entries: (n: number) => (n === 1 ? '1 entry' : `${n} entries`),
  searchPlaceholder: 'Search …',
  searchLabel: 'Search the history',
  connection: 'Connection',
  allConnections: 'All connections',
  failedOnly: 'errors only',
  ownOnly: 'my own only',
  listLabel: 'Statements that were run',
  loading: 'Loading …',
  nothingFound: 'Nothing found.',
  loadMore: 'Load more',
  previewLabel: 'Statement from the history',
  deleteEntry: 'Delete entry',
  clear: 'Clear history …',
  copy: 'Copy',
  inNewTab: 'In a new tab',
  runAgain: 'Run again',
  insert: 'Insert',
  clearTitle: 'Clear history',
  clearConnection: (name: string) =>
    `All entries of the connection “${name}” will be deleted for good.`,
  clearAll: 'The whole history will be deleted for good.',
  // the view of the sidebar
  panelSearch: 'Search the history',
  reading: 'Reading the history …',
  noEntries: 'No entries.',
  recent: 'Recently run',
  whole: 'Whole history …',
  // how an entry ended
  failed: 'Error',
  cancelled: 'cancelled',
  rows: (n: number) => (n === 1 ? '1 row' : `${n} rows`),
};

export const HISTORY_TEXTS = translatable('history', HISTORY_EN, { de: HISTORY_DE });
