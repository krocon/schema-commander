/** Test data (prompt 049): the generators as the dialog offers them, templates, the spec. Pure. */
import { ColumnSpec, Gen, GenKind, TestdataSpec } from '../../core/testdata/testdata-api';

/** Job ids of test data runs: a range of their own (exports 1+, … transfer 10e9+). */
export const TESTDATA_JOB_BASE = 11_000_000_000;
/** Rows of the preview. */
export const PREVIEW_ROWS = 20;
/** Templates kept at most. */
export const MAX_TEMPLATES = 200;

/** The generators in the order the dialog lists them. */
export const GEN_KINDS: readonly GenKind[] = [
  'skip',
  'fixed',
  'sequence',
  'int',
  'decimal',
  'bool',
  'date',
  'dateTime',
  'time',
  'uuid',
  'text',
  'pattern',
  'choice',
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  'street',
  'city',
  'zip',
  'country',
  'company',
  'lorem',
  'json',
  'foreignKey',
];

/** A generator of a kind with values to start from. */
export function defaultGen(kind: GenKind): Gen {
  switch (kind) {
    case 'fixed':
      return { kind, value: '' };
    case 'sequence':
      return { kind, start: 1, step: 1 };
    case 'int':
      return { kind, min: 1, max: 1000, normal: false };
    case 'decimal':
      return { kind, min: 0, max: 1000, scale: 2 };
    case 'bool':
      return { kind, trueShare: 0.5 };
    case 'date':
      return { kind, from: '2023-01-01', to: '2026-12-31' };
    case 'dateTime':
      return { kind, from: '2023-01-01', to: '2026-12-31', notBefore: null };
    case 'text':
      return { kind, min: 5, max: 30 };
    case 'pattern':
      return { kind, pattern: '[A-Z]{3}-\\d{4}' };
    case 'choice':
      return { kind, values: [{ value: 'a', weight: 1 }] };
    case 'lorem':
      return { kind, words: 8 };
    case 'json':
      return { kind, template: '{"id": {{int:1:1000}}}' };
    case 'foreignKey':
      return { kind, perParent: null };
    default:
      return { kind } as Gen;
  }
}

/** A value of a generator the dialog shows as a field. */
export interface GenField {
  readonly key: string;
  readonly type: 'number' | 'text' | 'check' | 'lines';
  readonly value: string | number | boolean;
}

/** `a:3` per line: a value and, behind the last colon, its weight. */
export function choiceText(values: readonly { value: string; weight: number }[]): string {
  return values.map((v) => (v.weight === 1 ? v.value : `${v.value}:${v.weight}`)).join('\n');
}

export function choiceValues(text: string): { value: string; weight: number }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const at = line.lastIndexOf(':');
      const weight = at > 0 ? Number(line.slice(at + 1)) : NaN;
      return Number.isFinite(weight) && weight >= 0
        ? { value: line.slice(0, at), weight }
        : { value: line, weight: 1 };
    });
}

/** The fields of a generator, in the order they are shown. */
export function fieldsOf(gen: Gen): GenField[] {
  switch (gen.kind) {
    case 'fixed':
      return [{ key: 'value', type: 'text', value: gen.value }];
    case 'sequence':
      return [
        { key: 'start', type: 'number', value: gen.start },
        { key: 'step', type: 'number', value: gen.step },
      ];
    case 'int':
      return [
        { key: 'min', type: 'number', value: gen.min },
        { key: 'max', type: 'number', value: gen.max },
        { key: 'normal', type: 'check', value: gen.normal },
      ];
    case 'decimal':
      return [
        { key: 'min', type: 'number', value: gen.min },
        { key: 'max', type: 'number', value: gen.max },
        { key: 'scale', type: 'number', value: gen.scale },
      ];
    case 'bool':
      return [{ key: 'trueShare', type: 'number', value: Math.round(gen.trueShare * 100) }];
    case 'date':
      return [
        { key: 'from', type: 'text', value: gen.from },
        { key: 'to', type: 'text', value: gen.to },
      ];
    case 'dateTime':
      return [
        { key: 'from', type: 'text', value: gen.from },
        { key: 'to', type: 'text', value: gen.to },
        { key: 'notBefore', type: 'text', value: gen.notBefore ?? '' },
      ];
    case 'text':
      return [
        { key: 'min', type: 'number', value: gen.min },
        { key: 'max', type: 'number', value: gen.max },
      ];
    case 'pattern':
      return [{ key: 'pattern', type: 'text', value: gen.pattern }];
    case 'choice':
      return [{ key: 'values', type: 'lines', value: choiceText(gen.values) }];
    case 'lorem':
      return [{ key: 'words', type: 'number', value: gen.words }];
    case 'json':
      return [{ key: 'template', type: 'text', value: gen.template }];
    case 'foreignKey':
      return [
        { key: 'perParent', type: 'check', value: gen.perParent !== null },
        { key: 'perMin', type: 'number', value: gen.perParent?.[0] ?? 0 },
        { key: 'perMax', type: 'number', value: gen.perParent?.[1] ?? 5 },
      ];
    default:
      return [];
  }
}

const whole = (value: string | number | boolean, fallback: number): number => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
};

/** The generator with one field changed. What is no number stays what it was. */
export function withField(gen: Gen, key: string, value: string | number | boolean): Gen {
  switch (gen.kind) {
    case 'fixed':
      return { ...gen, value: String(value) };
    case 'sequence':
      return key === 'start'
        ? { ...gen, start: whole(value, gen.start) }
        : { ...gen, step: whole(value, gen.step) };
    case 'int':
      if (key === 'normal') return { ...gen, normal: value === true };
      return key === 'min'
        ? { ...gen, min: whole(value, gen.min) }
        : { ...gen, max: whole(value, gen.max) };
    case 'decimal': {
      const n = Number(value);
      if (!Number.isFinite(n)) return gen;
      if (key === 'scale') return { ...gen, scale: Math.min(12, Math.max(0, Math.round(n))) };
      return key === 'min' ? { ...gen, min: n } : { ...gen, max: n };
    }
    case 'bool':
      return { ...gen, trueShare: Math.min(100, Math.max(0, whole(value, 50))) / 100 };
    case 'date':
      return key === 'from' ? { ...gen, from: String(value) } : { ...gen, to: String(value) };
    case 'dateTime':
      if (key === 'notBefore') {
        const name = String(value).trim();
        return { ...gen, notBefore: name === '' ? null : name };
      }
      return key === 'from' ? { ...gen, from: String(value) } : { ...gen, to: String(value) };
    case 'text':
      return key === 'min'
        ? { ...gen, min: Math.max(0, whole(value, gen.min)) }
        : { ...gen, max: Math.max(0, whole(value, gen.max)) };
    case 'pattern':
      return { ...gen, pattern: String(value) };
    case 'choice':
      return { ...gen, values: choiceValues(String(value)) };
    case 'lorem':
      return { ...gen, words: Math.max(1, whole(value, gen.words)) };
    case 'json':
      return { ...gen, template: String(value) };
    case 'foreignKey': {
      const [min, max] = gen.perParent ?? [0, 5];
      if (key === 'perParent') return { ...gen, perParent: value === true ? [min, max] : null };
      if (gen.perParent === null) return gen;
      return key === 'perMin'
        ? { ...gen, perParent: [Math.max(0, whole(value, min)), max] }
        : { ...gen, perParent: [min, Math.max(0, whole(value, max))] };
    }
    default:
      return gen;
  }
}

/** The column with another kind of generator; a kind that is no number of the column keeps its type. */
export function withKind(column: ColumnSpec, kind: GenKind): ColumnSpec {
  return { ...column, gen: defaultGen(kind) };
}

/** What the user set for a table, to use again. */
export interface TestdataTemplate {
  readonly columns: readonly ColumnSpec[];
  readonly rows: number;
  readonly locale: string;
}

export const templateKey = (connectionId: string, schema: string, table: string): string =>
  `${connectionId}/${schema}/${table}`;

/**
 * The proposal for a table with what a template says of it: the generators of columns that are still
 * there, with the type the table has now. A column the table got since keeps its proposal.
 */
export function withTemplate(
  proposed: readonly ColumnSpec[],
  template: TestdataTemplate | undefined,
): ColumnSpec[] {
  if (!template) return [...proposed];
  return proposed.map((column) => {
    const saved = template.columns.find((c) => c.name === column.name);
    if (!saved) return column;
    return { ...column, gen: saved.gen, nullShare: saved.nullShare, unique: saved.unique };
  });
}

/** The templates with one more; the oldest go when there are too many. */
export function withSaved(
  templates: Readonly<Record<string, TestdataTemplate>>,
  key: string,
  template: TestdataTemplate,
): Record<string, TestdataTemplate> {
  const rest = Object.entries(templates).filter(([k]) => k !== key);
  return Object.fromEntries([...rest.slice(-(MAX_TEMPLATES - 1)), [key, template]]);
}

/**
 * A stored generator made sound: every field it should have, of the type it should have – what is
 * missing or wrong is the value a new one starts with. `null`: its kind is none.
 */
export function soundGen(raw: unknown): Gen | null {
  if (!raw || typeof raw !== 'object') return null;
  const stored = raw as Record<string, unknown>;
  const kind = stored['kind'];
  if (typeof kind !== 'string' || !(GEN_KINDS as readonly string[]).includes(kind)) return null;
  const fresh = defaultGen(kind as GenKind) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { kind };
  for (const [key, start] of Object.entries(fresh)) {
    if (key === 'kind') continue;
    const value = stored[key];
    if (key === 'values') {
      const list = Array.isArray(value)
        ? value.filter(
            (v): v is { value: string; weight: number } =>
              !!v &&
              typeof v.value === 'string' &&
              typeof v.weight === 'number' &&
              Number.isFinite(v.weight),
          )
        : [];
      out[key] = list.length > 0 ? list.map((v) => ({ value: v.value, weight: v.weight })) : start;
    } else if (key === 'perParent') {
      const pair =
        Array.isArray(value) &&
        value.length === 2 &&
        value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0);
      out[key] = pair ? [value[0], value[1]] : null;
    } else if (key === 'notBefore') {
      out[key] = typeof value === 'string' && value !== '' ? value : null;
    } else if (typeof start === 'number') {
      out[key] = typeof value === 'number' && Number.isFinite(value) ? value : start;
    } else {
      out[key] = typeof value === typeof start ? value : start;
    }
  }
  return out as unknown as Gen;
}

/** Templates as stored: only what has the shape of one, each generator made sound. */
export function readTemplates(raw: unknown): Record<string, TestdataTemplate> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, TestdataTemplate> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(-MAX_TEMPLATES)) {
    const t = value as Partial<TestdataTemplate> | null;
    if (!t || typeof t !== 'object' || !Array.isArray(t.columns)) continue;
    const columns: ColumnSpec[] = [];
    for (const c of t.columns as readonly Partial<ColumnSpec>[]) {
      const gen = soundGen(c?.gen);
      if (!c || typeof c.name !== 'string' || !gen) continue;
      const share =
        typeof c.nullShare === 'number' && Number.isFinite(c.nullShare) ? c.nullShare : 0;
      columns.push({
        name: c.name,
        typeName: typeof c.typeName === 'string' ? c.typeName : '',
        valueKind: c.valueKind ?? 'text',
        gen,
        nullShare: Math.min(1, Math.max(0, share)),
        unique: c.unique === true,
        maxLen: typeof c.maxLen === 'number' ? c.maxLen : null,
      });
    }
    if (columns.length === 0) continue;
    const rows = typeof t.rows === 'number' && Number.isFinite(t.rows) ? t.rows : 1000;
    out[key] = {
      columns,
      rows: Math.min(50_000_000, Math.max(0, Math.round(rows))),
      locale: t.locale === 'de' ? 'de' : 'en',
    };
  }
  return out;
}

/** The spec the backend gets. */
export function specOf(
  schema: string,
  table: string,
  columns: readonly ColumnSpec[],
  rows: number,
  seed: number,
  locale: string,
): TestdataSpec {
  return {
    schema,
    table,
    columns,
    rows: Math.max(0, Math.round(rows)),
    seed: Math.max(0, Math.round(seed)),
    locale,
  };
}

/** A seed to start from: any whole number will do, this one is easy to read out loud. */
export const newSeed = (random: () => number = Math.random): number =>
  Math.floor(random() * 1_000_000);

/** Whether the number of rows follows from the parents (a foreign key with rows per parent). */
export const rowsFollow = (columns: readonly ColumnSpec[]): boolean =>
  columns.some((c) => c.gen.kind === 'foreignKey' && c.gen.perParent !== null);
