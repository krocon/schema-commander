import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  language,
  localeFor,
  phrasebook,
  plural,
  setLanguage,
  systemLanguage,
  translatable,
} from './i18n';
import { computed } from '@angular/core';

describe('i18n', () => {
  // the tests of the app run in German (src/testing/setup.ts); these start from the source language
  beforeEach(() => setLanguage('en'));
  afterEach(() => setLanguage('en'));

  it('follows the language signal, functions included', () => {
    const t = translatable(
      'test.a',
      { hi: 'Hello', n: (k: number) => `${k} files`, sub: { x: 'X' } },
      { de: { hi: 'Hallo', n: (k: number) => `${k} Dateien`, sub: { x: 'Ix' } } },
    );
    const c = computed(() => t.hi);
    expect(c()).toBe('Hello');
    setLanguage('de');
    expect(language()).toBe('de');
    expect(c()).toBe('Hallo');
    expect(t.n(3)).toBe('3 Dateien');
    expect(t.sub.x).toBe('Ix');
  });

  it('falls back to English for a missing key', () => {
    const t = translatable('test.b', { a: 'A', b: 'B' }, { de: { a: 'Ä' } as never });
    setLanguage('de');
    expect(t.a).toBe('Ä');
    expect(t.b).toBe('B');
  });

  it('phrase books translate by the English text', () => {
    const tr = phrasebook('test.c', { de: { Red: 'Rot' } });
    setLanguage('de');
    expect(tr('Red')).toBe('Rot');
    expect(tr('Blue')).toBe('Blue');
  });

  it('system language and locale', () => {
    expect(systemLanguage(['de-AT', 'en'])).toBe('de');
    expect(systemLanguage(['en-GB'])).toBe('en');
    expect(systemLanguage(['fr-FR'])).toBe('en');
    expect(systemLanguage([])).toBe('en');
    expect(localeFor('de', ['de-AT'])).toBe('de-AT');
    expect(localeFor('en', ['de-DE'])).toBe('en-DE');
    expect(localeFor('de', ['en-US'])).toBe('de-US');
    expect(localeFor('de', [])).toBe('de');
  });

  it('plural rules', () => {
    expect(plural(1)).toBe('one');
    expect(plural(2)).toBe('other');
  });
});
