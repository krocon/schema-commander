import { computed, signal } from '@angular/core';

/**
 * Runtime i18n without a library (prompt 017, after files-and-folders-tauri). English is the source; a
 * catalog is a typed object of strings and functions. {@link translatable}
 * returns a proxy that reads the language signal on every access – templates and
 * `computed`s follow a language switch without a reload, and components keep
 * `readonly t = XX_TEXTS`.
 */
export type Language = 'en' | 'de';
export const LANGUAGES: readonly Language[] = ['en', 'de'];

/** Same keys and signatures as the English catalog, strings widened. */
export type Translation<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Translation<R>
  : T extends string
    ? string
    : T extends readonly (infer E)[]
      ? readonly Translation<E>[]
      : T extends object
        ? { readonly [K in keyof T]: Translation<T[K]> }
        : T;

const current = signal<Language>('en');

/** The UI language (reactive). */
export const language = current.asReadonly();

export function setLanguage(lang: Language): void {
  current.set(lang);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
  }
}

function systemLocales(): readonly string[] {
  if (typeof navigator === 'undefined') {
    return [];
  }
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

/** The language of the system: German if the first preferred language is German, else English. */
export function systemLanguage(locales: readonly string[] = systemLocales()): Language {
  const first = (locales[0] ?? '').toLowerCase();
  return first === 'de' || first.startsWith('de-') ? 'de' : 'en';
}

/**
 * Locale for `Intl` (dates, numbers, plurals): the system locale if it is in the UI
 * language (keeps the region: `de-AT`, `en-GB`), else the UI language with the
 * system's region (`en-DE`: English words, German date order), else the language.
 */
export function localeFor(lang: Language, locales: readonly string[] = systemLocales()): string {
  const sys = locales[0] ?? '';
  const [base, ...rest] = sys.split('-');
  if (base?.toLowerCase() === lang && supported(sys)) {
    return sys;
  }
  const region = rest.find((p) => /^[A-Za-z]{2}$/.test(p));
  const mixed = region ? `${lang}-${region.toUpperCase()}` : '';
  return mixed && supported(mixed) ? mixed : lang;
}

function supported(tag: string): boolean {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0;
  } catch {
    return false;
  }
}

/** The `Intl` locale of the current language (reactive). */
export const locale = computed(() => localeFor(current()));

/** All catalogs (completeness test). */
export const CATALOGS = new Map<
  string,
  { readonly en: object; readonly tr: Readonly<Record<string, object>> }
>();
/** Phrase books keyed by the English text (long label lists, e.g. colour tokens). */
export const PHRASEBOOKS = new Map<
  string,
  Readonly<Record<string, Readonly<Record<string, string>>>>
>();

/**
 * A catalog that follows the language. A key missing in a translation (never with
 * the types, but e.g. in a hot-reloaded partial file) falls back to English.
 */
export function translatable<T extends object>(
  name: string,
  en: T,
  tr: { readonly de: Translation<T> },
): Translation<T> {
  CATALOGS.set(name, { en, tr: tr as Record<string, object> });
  return new Proxy(en, {
    get(target, prop, receiver) {
      const lang = current();
      if (lang !== 'en') {
        const cat = (tr as Record<string, Record<PropertyKey, unknown>>)[lang];
        if (cat && prop in cat) {
          return cat[prop];
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as Translation<T>;
}

/** Translates an English text through a phrase book (reactive); unknown texts stay English. */
export function phrasebook(
  name: string,
  tr: { readonly de: Readonly<Record<string, string>> },
): (en: string) => string {
  PHRASEBOOKS.set(name, tr);
  return (en) => {
    const lang = current();
    return lang === 'en' ? en : (tr[lang]?.[en] ?? en);
  };
}

const pluralRules = computed(() => new Intl.PluralRules(locale()));

/** `one` / `other` (en, de) for `n` in the current language. */
export function plural(n: number): Intl.LDMLPluralRule {
  return pluralRules().select(n);
}
