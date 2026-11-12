import { ColumnSpec, Gen } from '../../core/testdata/testdata-api';
import {
  GEN_KINDS,
  MAX_TEMPLATES,
  TestdataTemplate,
  choiceText,
  choiceValues,
  defaultGen,
  fieldsOf,
  newSeed,
  readTemplates,
  rowsFollow,
  soundGen,
  specOf,
  templateKey,
  withField,
  withKind,
  withSaved,
  withTemplate,
} from './testdata-logic';

const column = (name: string, gen: Gen, over: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name,
  typeName: 'text',
  valueKind: 'text',
  gen,
  nullShare: 0,
  unique: false,
  maxLen: null,
  ...over,
});

describe('testdata-logic', () => {
  it('has a generator to start from for every kind, with fields that read back', () => {
    for (const kind of GEN_KINDS) {
      const gen = defaultGen(kind);
      expect(gen.kind).toBe(kind);
      // setting a field to what it shows changes nothing
      for (const field of fieldsOf(gen)) {
        expect(withField(gen, field.key, field.value)).toEqual(gen);
      }
    }
    expect(fieldsOf(defaultGen('email'))).toEqual([]);
  });

  it('changes one field and keeps what is no number', () => {
    const int = defaultGen('int');
    expect(withField(int, 'max', '50')).toEqual({ kind: 'int', min: 1, max: 50, normal: false });
    expect(withField(int, 'max', 'viele')).toEqual(int);
    expect(withField(int, 'normal', true)).toMatchObject({ normal: true });
    expect(withField(defaultGen('decimal'), 'scale', '99')).toMatchObject({ scale: 12 });
    expect(withField(defaultGen('decimal'), 'min', '-1.5')).toMatchObject({ min: -1.5 });
    // a share is typed in percent and kept as a share
    expect(withField(defaultGen('bool'), 'trueShare', '80')).toEqual({
      kind: 'bool',
      trueShare: 0.8,
    });
    expect(withField(defaultGen('bool'), 'trueShare', '250')).toEqual({
      kind: 'bool',
      trueShare: 1,
    });
    const stamp = defaultGen('dateTime');
    expect(withField(stamp, 'notBefore', ' created_at ')).toMatchObject({
      notBefore: 'created_at',
    });
    expect(withField(stamp, 'notBefore', '')).toMatchObject({ notBefore: null });
  });

  it('turns rows per parent on and off', () => {
    const fk = defaultGen('foreignKey');
    expect(withField(fk, 'perMin', '3')).toEqual(fk);
    const on = withField(fk, 'perParent', true);
    expect(on).toEqual({ kind: 'foreignKey', perParent: [0, 5] });
    expect(withField(on, 'perMax', '20')).toEqual({ kind: 'foreignKey', perParent: [0, 20] });
    expect(withField(on, 'perParent', false)).toEqual(fk);
    expect(rowsFollow([column('a', on)])).toBe(true);
    expect(rowsFollow([column('a', fk)])).toBe(false);
  });

  it('reads a list of values with weights', () => {
    const values = choiceValues('active:6\n inactive \n\n10:30\npending:x\nzero:0');
    expect(values).toEqual([
      { value: 'active', weight: 6 },
      { value: 'inactive', weight: 1 },
      { value: '10', weight: 30 },
      { value: 'pending:x', weight: 1 },
      { value: 'zero', weight: 0 },
    ]);
    expect(choiceText(values.slice(0, 2))).toBe('active:6\ninactive');
    expect(withField(defaultGen('choice'), 'values', 'a\nb:2')).toEqual({
      kind: 'choice',
      values: [
        { value: 'a', weight: 1 },
        { value: 'b', weight: 2 },
      ],
    });
  });

  it('keeps the column when its generator changes', () => {
    const c = column('email', { kind: 'email' }, { unique: true, maxLen: 80 });
    expect(withKind(c, 'pattern')).toEqual({ ...c, gen: defaultGen('pattern') });
  });

  it('lays a template over the proposal for the columns that are still there', () => {
    const proposed = [
      column('id', { kind: 'sequence', start: 1, step: 1 }, { typeName: 'bigint' }),
      column('name', { kind: 'fullName' }),
      column('new_column', { kind: 'text', min: 5, max: 30 }),
    ];
    const template = {
      rows: 500,
      locale: 'de',
      columns: [
        column('name', { kind: 'company' }, { nullShare: 0.2, typeName: 'old type' }),
        column('gone', { kind: 'uuid' }),
      ],
    };
    const merged = withTemplate(proposed, template);
    expect(merged.map((c) => c.gen.kind)).toEqual(['sequence', 'company', 'text']);
    // the type is the one the table has now
    expect(merged[1]).toMatchObject({ nullShare: 0.2, typeName: 'text' });
    expect(withTemplate(proposed, undefined)).toEqual(proposed);
  });

  it('remembers templates by table and not without end', () => {
    const key = templateKey('pg', 'public', 'orders');
    expect(key).toBe('pg/public/orders');
    const template = { columns: [column('a', { kind: 'uuid' })], rows: 10, locale: 'en' };
    let all: Record<string, TestdataTemplate> = {};
    for (let i = 0; i < MAX_TEMPLATES + 10; i++) all = withSaved(all, `k${i}`, template);
    expect(Object.keys(all)).toHaveLength(MAX_TEMPLATES);
    expect(all['k0']).toBeUndefined();
    all = withSaved(all, 'k50', { ...template, rows: 99 });
    expect(Object.keys(all)).toHaveLength(MAX_TEMPLATES);
    expect(all['k50'].rows).toBe(99);
  });

  it('reads stored templates strictly', () => {
    const good = { columns: [column('a', { kind: 'uuid' })], rows: 10, locale: 'en' };
    const read = readTemplates({
      ok: good,
      noColumns: { rows: 1, locale: 'en' },
      badKind: { columns: [{ name: 'a', gen: { kind: 'sql' } }], rows: 1, locale: 'en' },
      text: 'x',
      nothing: null,
    });
    expect(Object.keys(read)).toEqual(['ok']);
    // a generator that lost a part is made whole: the dialog can show it, the backend can read it
    const broken = readTemplates({
      t: {
        columns: [
          { name: 'c', gen: { kind: 'choice' } },
          { name: 'n', gen: { kind: 'int', min: 'eins', max: 9 }, nullShare: 7 },
          { name: 'f', gen: { kind: 'foreignKey', perParent: [1] } },
          { name: 'x', gen: { kind: 'nope' } },
        ],
        rows: Number.NaN,
        locale: 'fr',
      },
    })['t'];
    expect(broken.columns.map((c) => c.gen)).toEqual([
      defaultGen('choice'),
      { kind: 'int', min: 1, max: 9, normal: false },
      { kind: 'foreignKey', perParent: null },
    ]);
    expect(broken.columns[1].nullShare).toBe(1);
    expect(broken.rows).toBe(1000);
    expect(broken.locale).toBe('en');
    for (const c of broken.columns) expect(() => fieldsOf(c.gen)).not.toThrow();
    expect(soundGen({ kind: 'dateTime', from: 5 })).toEqual(defaultGen('dateTime'));
    expect(soundGen('x')).toBeNull();
    expect(readTemplates(null)).toEqual({});
    expect(readTemplates([good])).toEqual({});
  });

  it('builds the spec and a seed', () => {
    expect(specOf('s', 't', [], 10.6, -3, 'de')).toEqual({
      schema: 's',
      table: 't',
      columns: [],
      rows: 11,
      seed: 0,
      locale: 'de',
    });
    expect(newSeed(() => 0.123456789)).toBe(123456);
  });
});
