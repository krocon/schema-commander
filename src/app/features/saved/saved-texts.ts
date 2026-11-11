import { translatable } from '../../core/i18n/i18n';
import { SAVED_DE } from './saved-texts.de';

/** Texts of the saved queries (prompt 024). English is the source. */
export const SAVED_EN = {
  search: 'Search saved queries',
  tree: 'Saved queries',
  empty: 'No saved queries yet. “Save as query …” keeps the text of a tab here.',
  nothingFound: 'No saved query matches.',
  reading: 'Reading …',
  truncated: 'There are more files in this folder than are shown.',
  folderCount: (n: number) => (n === 1 ? '1 query' : `${n} queries`),
  open: 'Open',
  openHint: 'Open in a new tab (Enter)',
  insert: 'Insert',
  insertHint: 'Insert into the editor (Alt+Enter)',
  run: 'Run',
  runHint: 'Open in a new tab and run (Ctrl/Cmd+Enter)',
  edit: 'Properties …',
  delete: 'Delete',
  deleteTitle: 'Delete saved query',
  deleteQuestion: (name: string) =>
    `“${name}” goes to the trash of the system. It can be brought back from there.`,
  folder: 'Folder of the saved queries',
  chooseFolder: 'Choose folder …',
  defaultFolder: 'Use the default folder',
  folderGone: 'The folder of the saved queries is gone; the default folder is used.',
  saved: (name: string) => `“${name}” was saved.`,
  nothingToSave: 'There is no text to save.',
  // the dialog
  saveTitle: 'Save as query',
  editTitle: 'Properties of the saved query',
  name: 'Name',
  folderField: 'Folder',
  folderHint: 'Empty = the top folder; a/b = folder b in folder a. New folders are created.',
  description: 'Description',
  tags: 'Tags',
  tagsHint: 'Separated by commas.',
  bind: (connection: string) => `Belongs to the connection “${connection}”`,
  bindNone: 'Belongs to a connection',
  bindHint: 'Opened from here, the query starts on that connection.',
  save: 'Save',
  nameMissing: 'A saved query needs a name.',
  folderInvalid: 'This is not a folder name.',
  preview: 'Preview',
  boundTo: (connection: string) => `Connection: ${connection}`,
};

export const SAVED_TEXTS = translatable('saved', SAVED_EN, { de: SAVED_DE });
