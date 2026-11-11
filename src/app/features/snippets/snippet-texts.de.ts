import type { Translation } from '../../core/i18n/i18n';
import type { SNIPPET_EN } from './snippet-texts';

export const SNIPPET_DE: Translation<typeof SNIPPET_EN> = {
  title: 'Textbausteine',
  intro:
    'Im Editor ein Kürzel tippen und Tab drücken: Es wird zu seinem Text. Tab springt von Platzhalter zu Platzhalter.',
  list: 'Textbausteine',
  builtin: 'mitgeliefert',
  own: 'eigener',
  onlyFor: (databases) => `nur ${databases}`,
  newSnippet: 'Neu',
  prefix: 'Kürzel',
  prefixHint: 'Buchstaben, Ziffern, _ und -; was im Editor getippt wird.',
  description: 'Beschreibung',
  body: 'Text',
  bodyHint:
    '${1:name} ist ein Platzhalter, gleiche Nummern werden gemeinsam getippt, $0 ist die Stelle, an der der Cursor endet. $TABLE und $SCHEMA sind das, was im Schema-Baum gewählt ist, $SELECTION der markierte Text, $DATE das Datum von heute.',
  save: 'Speichern',
  delete: 'Löschen',
  editCopy: 'Als eigenen Baustein ändern',
  builtinNote:
    'Dieser Baustein wird mitgeliefert. Ein eigener Baustein mit demselben Kürzel ersetzt ihn.',
  prefixInvalid: 'Ein Kürzel hat 1 bis 32 Buchstaben, Ziffern, _ oder -.',
  prefixTaken: 'Es gibt schon einen eigenen Baustein mit diesem Kürzel.',
  bodyMissing: 'Ein Baustein braucht einen Text.',
  tooMany: 'Für weitere Bausteine ist kein Platz.',
};
