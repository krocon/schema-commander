import { SavedEntry } from '../../core/saved/saved-api';
import {
  cleanFolder,
  formProblem,
  metaOf,
  nameFromText,
  previewOf,
  savedRows,
} from './saved-logic';

const entry = (id: string, name: string): SavedEntry => ({
  id,
  path: `/q/${id}`,
  folder: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
  name,
  description: '',
  tags: [],
  connection: null,
  dialect: null,
  modified: 0,
  size: 1,
});

describe('savedRows', () => {
  const entries = [
    entry('b.sql', 'beta'),
    entry('reports/month/rev.sql', 'Revenue'),
    entry('a.sql', 'Alpha'),
    entry('reports/all.sql', 'All'),
  ];
  const folders = ['reports', 'reports/month', 'empty'];
  const show = (rows: ReturnType<typeof savedRows>) =>
    rows.map((r) =>
      r.kind === 'folder'
        ? `${'  '.repeat(r.level)}[${r.label} ${r.count}${r.open ? '' : ' closed'}]`
        : `${'  '.repeat(r.level)}${r.entry.name}`,
    );

  it('lists folders first, each with its queries, sorted without regard to case', () => {
    expect(show(savedRows(entries, folders, new Set()))).toEqual([
      '[empty 0]',
      '[reports 2]',
      '  [month 1]',
      '    Revenue',
      '  All',
      'Alpha',
      'beta',
    ]);
  });

  it('hides what is in a closed folder', () => {
    expect(show(savedRows(entries, folders, new Set(['reports'])))).toEqual([
      '[empty 0]',
      '[reports 2 closed]',
      'Alpha',
      'beta',
    ]);
  });

  it('shows what a search found with its folders, all open', () => {
    const only = new Set(['reports/month/rev.sql', 'a.sql']);
    expect(show(savedRows(entries, folders, new Set(['reports']), only))).toEqual([
      '[reports 1]',
      '  [month 1]',
      '    Revenue',
      'Alpha',
    ]);
    expect(savedRows(entries, folders, new Set(), new Set())).toEqual([]);
  });
});

describe('the form of a saved query', () => {
  const form = { name: ' Umsatz ', folder: '', description: ' d ', tags: 'a, ,b', bound: true };

  it('cleans a folder as typed', () => {
    expect(cleanFolder(' berichte \\ monat / ')).toBe('berichte/monat');
    expect(cleanFolder('  ')).toBe('');
  });

  it('wants a name and a folder the file system takes', () => {
    expect(formProblem(form)).toBeNull();
    expect(formProblem({ ...form, name: '  ' })).toBe('name');
    expect(formProblem({ ...form, folder: '../raus' })).toBe('folder');
    expect(formProblem({ ...form, folder: 'a:b' })).toBe('folder');
    expect(formProblem({ ...form, folder: 'a/b/c/d/e/f/g/h/i' })).toBe('folder');
  });

  it('binds a new query to the connection and keeps what an old one was bound to', () => {
    const pg = { id: 'c1', kind: 'postgres' };
    expect(metaOf(form, pg, null)).toEqual({
      name: 'Umsatz',
      description: 'd',
      tags: ['a', 'b'],
      connection: 'c1',
      dialect: 'postgres',
    });
    const before = { ...metaOf(form, pg, null), connection: 'old', dialect: 'mysql' };
    expect(metaOf(form, pg, before).connection).toBe('old');
    expect(metaOf({ ...form, bound: false }, pg, before).connection).toBeNull();
    expect(metaOf({ ...form, bound: false }, pg, before).dialect).toBeNull();
  });

  it('suggests a name from the first line of the text that is no comment', () => {
    expect(nameFromText('-- note\n\n  select *   from orders;\nwhere')).toBe(
      'select * from orders',
    );
    expect(nameFromText('x'.repeat(100)).length).toBe(58);
    expect(nameFromText('-- only')).toBe('');
  });

  it('cuts a preview and says so', () => {
    expect(previewOf('a\nb')).toBe('a\nb');
    expect(previewOf('1\n2\n3\n4', 2)).toBe('1\n2\n…');
  });
});
