import { translatable } from '../../core/i18n/i18n';
import { UPDATE_DE } from './update-texts.de';

/** Texts of the update check. English is the source. */
export const UPDATE_EN = {
  title: 'Check for updates',
  checking: 'Asking GitHub for the latest release …',
  upToDate: (version: string) => `Schema Commander ${version} is the latest version.`,
  newer: (latest: string, current: string) =>
    `Version ${latest} is available. You have ${current}.`,
  published: (day: string) => `Published on ${day}`,
  notesLabel: 'Release notes',
  notesCut: 'The notes are longer; the rest is on the page of the release.',
  failed: 'Could not check for updates.',
  noRelease: 'No release has been published yet.',
  privacy:
    'The check asks GitHub for the latest release. Nothing about you or this computer is sent, nothing is downloaded or installed.',
  openPage: 'Open download page',
  openFailed: 'The page could not be opened.',
  skip: 'Skip this version',
  again: 'Check again',
  close: 'Close',
  available: (version: string) => `Version ${version} available`,
  availableHint: 'A newer version of Schema Commander has been released',
};

export const UPDATE_TEXTS = translatable('update', UPDATE_EN, { de: UPDATE_DE });
