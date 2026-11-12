import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGS, PHRASEBOOKS, setLanguage } from './i18n';
import { ACTIONS, ACTION_GROUPS } from '../actions/action-catalog';
import { actionLabel, groupLabel } from '../actions/action-texts';
import '../../app-texts';
import '../actions/keymap-texts';
import '../connections/connection-model-texts';
import '../errors/error-texts';
import './common-texts';
import '../theme/theme-texts';
import '../../features/connections/connection-dialog-texts';
import '../../features/connections/connection-texts';
import '../../features/connections/import-texts';
import '../../features/details/details-texts';
import '../../features/editor/editor-texts';
import '../../features/about/about-texts';
import '../../features/data-import/data-import-texts';
import '../../features/diagram/diagram-texts';
import '../../features/export/export-texts';
import '../../features/filter/filter-texts';
import '../../features/format/format-texts';
import '../../features/guard/guard-texts';
import '../../features/history/history-texts';
import '../../features/menus/menu-texts';
import '../../features/palette/palette-texts';
import '../../features/params/param-texts';
import '../../features/results/results-texts';
import '../../features/plan/plan-texts';
import '../../features/access/access-texts';
import '../../features/mcp/mcp-texts';
import '../../features/monitor/monitor-texts';
import '../../features/testdata/testdata-texts';
import '../../features/transfer/transfer-texts';
import '../../features/backup/backup-texts';
import '../../features/structure/structure-texts';
import '../../features/chart/chart-texts';
import '../../features/result-compare/compare-texts';
import '../../features/row-form/row-form-texts';
import '../../features/saved/saved-texts';
import '../../features/schema-compare/compare-texts';
import '../../features/schema/schema-texts';
import '../../features/server-search/server-search-texts';
import '../../features/settings/settings-texts';
import '../../features/shortcuts/shortcut-dialog-texts';
import '../../features/snippets/snippet-texts';
import '../../features/tabs/tab-bar-texts';
import '../../features/tabs/tabs-texts';
import '../../features/themes/theme-editor-texts';
import '../../features/themes/theme-picker-texts';
import '../../features/edit/edit-texts';
import '../../features/find/find-texts';
import '../../features/relations/relation-texts';
import '../../features/stats/stats-texts';
import '../../features/value/value-texts';
import '../../shared/shared-texts';
import '../theme/tokens';

/** The same in both languages on purpose: names, symbols, technical terms. */
const SAME = new Set<string>([
  'Lorem ipsum',
  'NULL %',
  'UUID',
  'Superuser',
  'Id',
  'Client',
  'Checks',
  'NOT NULL',
  'Operation',
  'Index',
  'Check',
  'Trigger',
  'Build',
  'Linux',
  'MIT',
  'Tauri',
  'Version',
  'WebView',
  'Windows',
  'macOS',
  '(null)',
  '…',
  'Alt',
  'CSV',
  'CSV / TSV',
  'CSV, TSV, JSON, NDJSON',
  'Commit',
  'DEFAULT',
  'DBeaver (data-sources.json)',
  'Default',
  'DataGrip / JetBrains (dataSources.xml)',
  'Deutsch',
  'Editor',
  'English',
  'Esc',
  'Excel (.xlsx)',
  'Filter',
  'Format',
  'Host',
  'JSON',
  'Max',
  'Min',
  'MySQL / MariaDB',
  'NULL',
  'Name',
  'Navigation',
  'Passphrase',
  'Port',
  'PostgreSQL',
  'Rollback',
  'Cache',
  'Code',
  'Constraints',
  'DDL',
  'Definition',
  'Detail',
  'Engine',
  'Routine',
  'Start',
  'View',
  'SELECT',
  'SQL Server',
  'Schema Commander',
  'Schema',
  'TLS: ',
  'Hex',
  'IS NOT NULL',
  'IS NULL',
  'LIKE',
  'NOT LIKE',
  'Tab',
  'Text',
  'UTC',
  'XML',
  'Tabs',
  'Tx: auto',
  'Views',
  'gzip',
  'select',
  '~/.my.cnf (MySQL, MariaDB)',
  '~/.pg_service.conf (PostgreSQL)',
  '~/.pgpass (PostgreSQL)',
]);

const CATALOG_FILES = 52;
const SAMPLE_ARGS: unknown[] = [2, 'x', 3, 4];

function walk(path: string, en: unknown, de: unknown, problems: string[], same: string[]): void {
  if (typeof en === 'string') {
    if (typeof de !== 'string' || (de.trim() === '' && en.trim() !== '')) {
      problems.push(`${path}: missing or empty`);
    } else if (de === en && !SAME.has(en) && /[a-z]{3}/i.test(en)) {
      same.push(en);
    }
  } else if (typeof en === 'function') {
    if (typeof de !== 'function') {
      problems.push(`${path}: not a function`);
      return;
    }
    if (de.length !== (en as (...a: unknown[]) => unknown).length) {
      problems.push(`${path}: ${de.length} instead of ${en.length} parameters`);
    }
    let a: unknown;
    let b: unknown;
    try {
      a = (en as (...x: unknown[]) => unknown)(...SAMPLE_ARGS);
      b = (de as (...x: unknown[]) => unknown)(...SAMPLE_ARGS);
    } catch {
      return; // the sample arguments do not fit this function's types
    }
    if (typeof a === 'string' && (typeof b !== 'string' || b === '')) {
      problems.push(`${path}(): no text`);
    }
  } else if (en && typeof en === 'object') {
    if (!de || typeof de !== 'object') {
      problems.push(`${path}: missing object`);
      return;
    }
    const ek = Object.keys(en).sort();
    const dk = Object.keys(de).sort();
    for (const k of ek) {
      walk(
        `${path}.${k}`,
        (en as Record<string, unknown>)[k],
        (de as Record<string, unknown>)[k],
        problems,
        same,
      );
    }
    for (const k of dk.filter((k) => !ek.includes(k)))
      problems.push(`${path}.${k}: only in German`);
  }
}

describe('translation catalogs (prompt 017)', () => {
  beforeEach(() => setLanguage('en'));
  afterEach(() => setLanguage('de'));

  it('registers every catalog this spec imports', () => {
    expect(CATALOGS.size).toBeGreaterThanOrEqual(CATALOG_FILES);
    expect(PHRASEBOOKS.has('themeLabels')).toBe(true);
  });

  it('German has every key of English, with the same signatures', () => {
    const problems: string[] = [];
    for (const [name, { en, tr }] of CATALOGS) {
      if (name.startsWith('test.')) continue;
      walk(name, en, tr['de'], problems, []);
    }
    expect(problems).toEqual([]);
  });

  it('translates the texts: what is the same in both languages is on the list', () => {
    const same: string[] = [];
    for (const [name, { en, tr }] of CATALOGS) {
      if (name.startsWith('test.')) continue;
      walk(name, en, tr['de'], [], same);
    }
    expect([...new Set(same)].sort()).toEqual([]);
  });

  it('names every action and group in both languages', () => {
    for (const lang of ['en', 'de'] as const) {
      setLanguage(lang);
      for (const action of ACTIONS) expect(actionLabel(action.id), action.id).toBeTruthy();
      for (const group of ACTION_GROUPS) expect(groupLabel(group), group).toBeTruthy();
    }
  });
});
