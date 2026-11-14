import type { Translation } from '../../core/i18n/i18n';
import type { UPDATE_EN } from './update-texts';

export const UPDATE_DE: Translation<typeof UPDATE_EN> = {
  title: 'Nach Updates suchen',
  checking: 'Frage GitHub nach dem neuesten Release …',
  upToDate: (version: string) => `Schema Commander ${version} ist die neueste Version.`,
  newer: (latest: string, current: string) =>
    `Version ${latest} ist verfügbar. Installiert ist ${current}.`,
  published: (day: string) => `Veröffentlicht am ${day}`,
  notesLabel: 'Release-Notizen',
  notesCut: 'Die Notizen sind länger; der Rest steht auf der Seite des Release.',
  failed: 'Die Suche nach Updates ist nicht gelungen.',
  noRelease: 'Es ist noch kein Release veröffentlicht.',
  privacy:
    'Die Suche fragt GitHub nach dem neuesten Release. Nichts über Sie oder diesen Rechner wird gesendet, nichts wird geladen oder installiert.',
  openPage: 'Download-Seite öffnen',
  openFailed: 'Die Seite ließ sich nicht öffnen.',
  skip: 'Diese Version überspringen',
  again: 'Erneut suchen',
  close: 'Schließen',
  available: (version: string) => `Version ${version} verfügbar`,
  availableHint: 'Eine neuere Version von Schema Commander ist erschienen',
};
