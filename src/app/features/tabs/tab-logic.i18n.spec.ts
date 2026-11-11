import { onTestFinished } from 'vitest';
import { setLanguage } from '../../core/i18n/i18n';
import { byteSize } from '../results/cell-format';
import { COPY_FORMATS } from '../results/copy-logic';
import { pending, runStatus } from './run-state';
import { isUntitled, untitled } from './tab-logic';

describe('texts follow the language', () => {
  it('names a new tab in the current language and knows the names of both', () => {
    setLanguage('en');
    expect(untitled(new Set())).toBe('Query');
    expect(untitled(new Set(['Query']))).toBe('Query 2');
    // a tab that was named in German stays an untitled one
    expect(isUntitled('Abfrage 3')).toBe(true);
    expect(isUntitled('Query')).toBe(true);
    expect(isUntitled('orders')).toBe(false);
    setLanguage('de');
    expect(untitled(new Set())).toBe('Abfrage');
    expect(isUntitled('Query 2')).toBe(true);
  });

  it('reads labels and numbers when they are asked for, not when the module loads', () => {
    // numbers follow the region of the system (`en-DE` writes a comma): here the system is English
    const system = navigator.languages;
    Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true });
    onTestFinished(() => {
      Object.defineProperty(navigator, 'languages', { value: system, configurable: true });
    });
    setLanguage('en');
    expect(COPY_FORMATS[0].label).toBe('TSV (for spreadsheets)');
    expect(runStatus([{ ...pending('a'), kind: 'running' }], 1234)).toBe('Running … 1.23 s');
    expect(byteSize(1536)).toBe('1.5 kB');
    setLanguage('de');
    expect(COPY_FORMATS[0].label).toBe('TSV (für Tabellenkalkulationen)');
    expect(byteSize(1536)).toBe('1,5 kB');
  });
});
