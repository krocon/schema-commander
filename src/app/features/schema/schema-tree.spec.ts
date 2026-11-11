import { menuPosition } from '../../shared/context-menu';
import { allows, rowName, rowQualified } from './schema-actions';
import { TreeRow } from './schema-logic';
import { TREE_ROW_HEIGHT, visibleRange } from './schema-tree';

function row(over: Partial<TreeRow>): TreeRow {
  return {
    id: 'x',
    level: 1,
    kind: 'info',
    label: '',
    detail: '',
    icon: '',
    tone: '',
    expandable: false,
    expanded: false,
    schema: null,
    object: null,
    column: null,
    error: false,
    ...over,
  };
}

const ARCHIVE = { name: 'archive', quoted: 'archive', system: false, current: false };
const TABLE = row({
  kind: 'object',
  schema: ARCHIVE,
  object: { kind: 'table', name: 'Old Orders', quoted: '"Old Orders"', detail: '', rows: 1 },
});
const VIEW = row({
  kind: 'object',
  schema: ARCHIVE,
  object: { kind: 'view', name: 'v', quoted: 'v', detail: '', rows: null },
});
const ROUTINE = row({
  kind: 'object',
  schema: ARCHIVE,
  object: { kind: 'routine', name: 'f', quoted: 'f', detail: '', rows: null },
});
const COLUMN = row({
  kind: 'column',
  column: {
    name: 'select',
    quoted: '"select"',
    typeName: 'text',
    nullable: true,
    default: null,
    key: '',
  },
});

describe('visibleRange', () => {
  it('renders the rows in view and a few around them', () => {
    expect(visibleRange(0, 220, 50_000)).toEqual({ first: 0, last: 18 });
    const far = visibleRange(TREE_ROW_HEIGHT * 10_000, 220, 50_000);
    expect(far).toEqual({ first: 9992, last: 10_018 });
    expect(visibleRange(TREE_ROW_HEIGHT * 49_995, 220, 50_000).last).toBe(50_000);
  });

  it('survives a list shorter than the scroll position', () => {
    expect(visibleRange(10_000, 220, 3)).toEqual({ first: 3, last: 3 });
    expect(visibleRange(0, 220, 0)).toEqual({ first: 0, last: 0 });
  });
});

describe('menuPosition', () => {
  it('opens at the pointer and stays inside the window', () => {
    expect(menuPosition(100, 100, 200, 150, 800, 600)).toEqual({ left: 100, top: 100 });
    expect(menuPosition(790, 590, 200, 150, 800, 600)).toEqual({ left: 596, top: 446 });
    expect(menuPosition(-5, -5, 200, 150, 800, 600)).toEqual({ left: 4, top: 4 });
  });
});

describe('what a node offers', () => {
  it('names rows as SQL writes them', () => {
    expect(rowName(TABLE)).toBe('"Old Orders"');
    expect(rowQualified(TABLE)).toBe('archive."Old Orders"');
    expect(rowName(COLUMN)).toBe('"select"');
    expect(rowQualified(COLUMN)).toBe('"select"');
    expect(rowName(row({ kind: 'schema', schema: ARCHIVE }))).toBe('archive');
    expect(rowName(row({ kind: 'group', schema: ARCHIVE }))).toBeNull();
    expect(rowName(null)).toBeNull();
  });

  it('offers data and templates for what has rows', () => {
    expect(allows('SCHEMA_OPEN_DATA', TABLE)).toBe(true);
    expect(allows('SCHEMA_OPEN_DATA', VIEW)).toBe(true);
    expect(allows('SCHEMA_OPEN_DATA', ROUTINE)).toBe(false);
    expect(allows('SCHEMA_INSERT_TEMPLATE', TABLE)).toBe(true);
    expect(allows('SCHEMA_INSERT_TEMPLATE', VIEW)).toBe(false);
    expect(allows('SCHEMA_SELECT_TEMPLATE', VIEW)).toBe(true);
    expect(allows('SCHEMA_COPY_QUALIFIED', COLUMN)).toBe(false);
    expect(allows('SCHEMA_COPY_NAME', COLUMN)).toBe(true);
    expect(allows('SCHEMA_INSERT_NAME', ROUTINE)).toBe(true);
    expect(allows('SCHEMA_INSERT_NAME', row({ kind: 'info' }))).toBe(false);
    expect(allows('SCHEMA_COPY_NAME', null)).toBe(false);
  });
});
