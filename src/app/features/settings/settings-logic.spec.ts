import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../../core/i18n/i18n';
import { DEFAULT_SETTINGS, Settings, mergeSettings } from '../../core/settings/settings.models';
import {
  GROUPS,
  SETTING_DEFS,
  choiceLabel,
  exportSettings,
  importSettings,
  isDefault,
  resetOf,
  searchSettings,
} from './settings-logic';
import { SETTINGS_EN } from './settings-texts';

describe('settings schema', () => {
  afterEach(() => setLanguage('de'));

  it('describes every setting once, in a known group, with a label and a help text', () => {
    const keys = SETTING_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of SETTING_DEFS) {
      expect(GROUPS).toContain(def.group);
      expect(def.key in DEFAULT_SETTINGS, def.key).toBe(true);
      expect(SETTINGS_EN.labels[def.key], def.key).toBeTruthy();
      expect(typeof SETTINGS_EN.help[def.key], def.key).toBe('string');
    }
    // every group has something to show
    for (const g of GROUPS) expect(SETTING_DEFS.some((d) => d.group === g)).toBe(true);
  });

  it('has bounds and choices that the stored settings accept', () => {
    for (const def of SETTING_DEFS) {
      if (def.kind === 'number') {
        for (const v of [def.min, def.max]) {
          expect(mergeSettings({ [def.key]: v })[def.key], `${def.key}=${v}`).toBe(v);
        }
        // beyond the bound: the default, or the bound itself
        expect([DEFAULT_SETTINGS[def.key], def.max]).toContain(
          mergeSettings({ [def.key]: def.max + 1 })[def.key],
        );
        expect(DEFAULT_SETTINGS[def.key]).toBeGreaterThanOrEqual(def.min);
      } else if (def.kind === 'choice') {
        expect(def.values).toContain(DEFAULT_SETTINGS[def.key]);
        for (const v of def.values) {
          expect(mergeSettings({ [def.key]: v })[def.key], `${def.key}=${v}`).toBe(v);
          // every choice has a name the user reads
          const names = SETTINGS_EN.choices as Record<string, Record<string, string>>;
          expect(names[def.key]?.[v], `${def.key}=${v}`).toBeTruthy();
        }
      }
    }
  });

  it('finds settings by words of the label, the help, the group or a choice, in the language on screen', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('sprache').map((d) => d.key)).toEqual(['language']);
    expect(searchSettings('SCHRIFTGRÖSSE').map((d) => d.key)).toEqual([]);
    expect(searchSettings('schriftgröße').map((d) => d.key)).toEqual([
      'editorFontSize',
      'resultFontSize',
    ]);
    // all words must match; the group counts
    expect(searchSettings('editor schriftgröße').map((d) => d.key)).toEqual(['editorFontSize']);
    expect(searchSettings('semikolon').map((d) => d.key)).toEqual(['csvDelimiter']);
    expect(searchSettings('font size')).toEqual([]);
    setLanguage('en');
    expect(searchSettings('font size').map((d) => d.key)).toEqual([
      'editorFontSize',
      'resultFontSize',
    ]);
    expect(choiceLabel('csvDelimiter', ';')).toBe('Semicolon');
  });

  it('resets one setting or all the dialog shows, and nothing else', () => {
    const changed: Settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      editorFontSize: 20,
      language: 'de',
      sidebarWidth: 400,
    });
    expect(isDefault(changed, 'editorFontSize')).toBe(false);
    const one = mergeSettings({ ...changed, ...resetOf(['editorFontSize']) });
    expect(one.editorFontSize).toBe(14);
    expect(one.language).toBe('de');
    const all = mergeSettings({ ...changed, ...resetOf(SETTING_DEFS.map((d) => d.key)) });
    expect(all.language).toBe('system');
    // the state of the window is no setting of the dialog
    expect(all.sidebarWidth).toBe(400);
  });
});

describe('settings as a file', () => {
  const mine: Settings = mergeSettings({
    ...DEFAULT_SETTINGS,
    language: 'de',
    editorFontSize: 18,
    activeConnection: 'prod',
    historyOff: ['prod'],
    recentActions: ['RUN_SCRIPT'],
  });

  it('exports without what belongs to this machine and reads its own export', () => {
    const text = exportSettings(mine);
    const file = JSON.parse(text);
    expect(file.format).toBe('schema-commander-settings');
    expect(file.settings.editorFontSize).toBe(18);
    for (const key of ['activeConnection', 'historyOff', 'recentActions']) {
      expect(key in file.settings, key).toBe(false);
    }
    const there = mergeSettings({ ...DEFAULT_SETTINGS, activeConnection: 'local' });
    const read = importSettings(text, there)!;
    expect(read.editorFontSize).toBe(18);
    expect(read.language).toBe('de');
    // the connections of the other machine do not come along
    expect(read.activeConnection).toBe('local');
  });

  it('keeps what is set for values that are broken, unknown or missing', () => {
    const text = JSON.stringify({
      format: 'schema-commander-settings',
      version: 99,
      settings: {
        editorFontSize: 4000,
        editorTabWidth: 8,
        language: 'fr',
        nullText: '<script>',
        activeConnection: 'theirs',
        somethingNew: true,
      },
    });
    const read = importSettings(text, mine)!;
    expect(read.editorFontSize).toBe(18);
    expect(read.editorTabWidth).toBe(8);
    expect(read.language).toBe('de');
    expect(read.nullText).toBe('NULL');
    expect(read.activeConnection).toBe('prod');
    expect('somethingNew' in read).toBe(false);
  });

  it('refuses what is not a settings file', () => {
    for (const text of [
      '',
      'not json',
      '[]',
      '{"settings":{}}',
      '{"format":"schema-commander-settings","settings":[]}',
      '{"format":"other","settings":{"language":"de"}}',
      `{"format":"schema-commander-settings","settings":{},"pad":"${'x'.repeat(1_000_001)}"}`,
    ]) {
      expect(importSettings(text, mine), text.slice(0, 40)).toBeNull();
    }
  });
});

describe('stored settings (migration)', () => {
  it('gives an older file the defaults of what it does not know', () => {
    // a file as prompt 016 wrote it
    const old = { sidebarVisible: false, resultHeight: 250, stopOnError: false };
    const merged = mergeSettings(old);
    expect(merged.sidebarVisible).toBe(false);
    expect(merged.stopOnError).toBe(false);
    expect(merged.language).toBe('system');
    expect(merged.editorFontSize).toBe(14);
    expect(merged.autoCommit).toBe(true);
  });

  it('falls back per value, not for the whole file', () => {
    const merged = mergeSettings({
      language: 7,
      editorFontFamily: 'Fira Code; } body { display: none',
      editorFontSize: 'big',
      editorTabWidth: 0,
      editorLineNumbers: 'sideways',
      resultRowHeight: 1,
      nullText: 'nil',
      autoCommit: 'no',
      editorWordWrap: true,
      resultFontSize: 16,
    });
    expect(merged).toMatchObject({
      language: 'system',
      editorFontFamily: '',
      editorFontSize: 14,
      editorTabWidth: 4,
      editorLineNumbers: 'absolute',
      resultRowHeight: 22,
      nullText: 'NULL',
      autoCommit: true,
      // the good ones are kept
      editorWordWrap: true,
      resultFontSize: 16,
    });
    expect(mergeSettings({ editorFontFamily: " 'JetBrains Mono', Menlo " }).editorFontFamily).toBe(
      "'JetBrains Mono', Menlo",
    );
  });
});
