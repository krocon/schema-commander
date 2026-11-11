import { translatable } from '../../core/i18n/i18n';
import { SNIPPET_DE } from './snippet-texts.de';

/** Texts of the snippet editor (prompt 024). English is the source. */
export const SNIPPET_EN = {
  title: 'Snippets',
  intro:
    'Type a prefix in the editor and press Tab: it becomes its text. Tab jumps from placeholder to placeholder.',
  list: 'Snippets',
  builtin: 'built in',
  own: 'own',
  onlyFor: (databases: string) => `only ${databases}`,
  newSnippet: 'New',
  prefix: 'Prefix',
  prefixHint: 'Letters, digits, _ and -; what you type in the editor.',
  description: 'Description',
  body: 'Text',
  bodyHint:
    '${1:name} is a placeholder, the same number is typed together, $0 is where the caret ends. $TABLE and $SCHEMA are what is chosen in the schema tree, $SELECTION the selected text, $DATE today.',
  save: 'Save',
  delete: 'Delete',
  editCopy: 'Change as an own snippet',
  builtinNote: 'This snippet comes with the app. An own snippet with the same prefix replaces it.',
  prefixInvalid: 'A prefix has 1 to 32 letters, digits, _ or -.',
  prefixTaken: 'There is an own snippet with this prefix already.',
  bodyMissing: 'A snippet needs a text.',
  tooMany: 'There is no room for more snippets.',
};

export const SNIPPET_TEXTS = translatable('snippets', SNIPPET_EN, { de: SNIPPET_DE });
