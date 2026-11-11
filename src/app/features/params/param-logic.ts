import { BoundValue } from '../../core/sql/query.models';
import { codePoints } from '../../core/text/places';
import { lex, Token } from '../completion/sql-lex';
import { Dialect } from '../editor/sql-split';

/**
 * Parameters in statements (prompt 025): finding them, asking what they are, and writing the statement the
 * way the driver wants it – a placeholder where the parameter stood, the value apart from the text. A value
 * never becomes part of the SQL. Pure; the cases are in `param-logic.spec.ts`.
 */

/** The ways a parameter can be written. */
export type ParamForm =
  /** `:name` */
  | 'colon'
  /** `@name` */
  | 'at'
  /** `$name` */
  | 'dollarName'
  /** `${name}` */
  | 'brace'
  /** `$1` */
  | 'dollarNumber'
  /** `?` */
  | 'question';

export const PARAM_FORMS: readonly ParamForm[] = [
  'colon',
  'brace',
  'question',
  'dollarNumber',
  'dollarName',
  'at',
];

/** How each form is written – notation, the same in every language. */
export const FORM_SIGNS: Readonly<Record<ParamForm, string>> = {
  colon: ':name',
  brace: '${name}',
  question: '?',
  dollarNumber: '$1',
  dollarName: '$name',
  at: '@name',
};

/**
 * The forms that are parameters unless the user says otherwise. Left out where the database gives the
 * sign another meaning: `?` is a JSON operator in PostgreSQL, `@name` a variable in MySQL and SQL Server.
 */
export const DEFAULT_FORMS: Readonly<Record<Dialect, readonly ParamForm[]>> = {
  postgres: ['colon', 'brace', 'dollarNumber'],
  mysql: ['colon', 'brace', 'question'],
  sqlserver: ['colon', 'brace', 'question'],
  sqlite: ['colon', 'brace', 'question', 'dollarName', 'at'],
};

/** The forms of a connection: what the user set for it, else the defaults of its database. */
export function formsOf(
  dialect: Dialect,
  own: readonly string[] | undefined,
): readonly ParamForm[] {
  if (!own) return DEFAULT_FORMS[dialect];
  return PARAM_FORMS.filter((f) => own.includes(f));
}

/** A place in a statement where a parameter stands. */
export interface ParamUse {
  /** What tells parameters apart: `kunde`, `$1`, `?2` (the second `?` of its statement). */
  readonly key: string;
  readonly form: ParamForm;
  /** Offsets in the statement (UTF-16); `end` is behind its last character. */
  readonly start: number;
  readonly end: number;
  /** It stands alone in the brackets of an `IN (…)`: a value of type `auto` is a list there. */
  readonly list: boolean;
}

const glued = (a: Token | undefined, b: Token | undefined) => !!a && !!b && a.end === b.start;
const isSign = (t: Token | undefined, text: string) => t?.kind === 'sign' && t.text === text;
const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** `@names` that are variables of the statement itself: declared, or assigned to. */
function variables(tokens: readonly Token[]): Set<string> {
  const found = new Set<string>();
  let declaring = false;
  tokens.forEach((t, i) => {
    if (t.kind === 'word' && t.value === 'DECLARE') declaring = true;
    else if (isSign(t, ';')) declaring = false;
    if (t.kind !== 'word' || !t.text.startsWith('@')) return;
    const before = tokens[i - 1];
    const after = tokens[i + 1];
    const assigned =
      isSign(after, ':') && isSign(tokens[i + 2], '=') && glued(after, tokens[i + 2]);
    if (declaring || assigned || (before?.kind === 'word' && before.value === 'SET')) {
      found.add(t.text);
    }
  });
  return found;
}

/**
 * The parameters of a statement, in the order they stand. Strings, comments and quoted names hold none.
 * Not parameters: `::type`, `:=`, `a[1:n]`, `@@global`, `?|` and `?&`, a `?` or `@name` of a database that
 * uses them otherwise (unless that form is switched on), variables the statement declares.
 */
export function findParams(sql: string, dialect: Dialect, forms: readonly ParamForm[]): ParamUse[] {
  const tokens = lex(sql, dialect);
  const on = new Set(forms);
  const own = on.has('at') ? variables(tokens) : new Set<string>();
  const found: Omit<ParamUse, 'list'>[] = [];
  const uses = { push: (use: Omit<ParamUse, 'list'>) => found.push(use) };
  let anonymous = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    // glued to a name, a number or a closing bracket before it, a sign is no start of a parameter
    const attached =
      glued(prev, t) &&
      (prev.kind === 'word' ||
        prev.kind === 'number' ||
        prev.kind === 'quoted' ||
        prev.kind === 'string' ||
        [')', ']', ':'].includes(prev.text));
    if (t.kind === 'word') {
      if (on.has('at') && /^@[^@]/.test(t.text) && NAME.test(t.text.slice(1)) && !own.has(t.text)) {
        uses.push({ key: t.text.slice(1), form: 'at', start: t.start, end: t.end });
      }
      continue;
    }
    if (t.kind !== 'sign') continue;
    if (t.text === ':' && on.has('colon')) {
      if (!attached && glued(t, next) && next.kind === 'word' && NAME.test(next.text)) {
        uses.push({ key: next.text, form: 'colon', start: t.start, end: next.end });
        i++;
      }
    } else if (t.text === '$') {
      const brace = tokens[i + 2];
      const close = tokens[i + 3];
      if (
        on.has('brace') &&
        isSign(next, '{') &&
        glued(t, next) &&
        glued(next, brace) &&
        brace?.kind === 'word' &&
        NAME.test(brace.text) &&
        isSign(close, '}') &&
        glued(brace, close)
      ) {
        uses.push({ key: brace.text, form: 'brace', start: t.start, end: close.end });
        i += 3;
      } else if (attached || !glued(t, next)) {
        continue;
      } else if (on.has('dollarNumber') && next.kind === 'number' && /^\d+$/.test(next.text)) {
        uses.push({ key: `$${next.text}`, form: 'dollarNumber', start: t.start, end: next.end });
        i++;
      } else if (on.has('dollarName') && next.kind === 'word' && NAME.test(next.text)) {
        uses.push({ key: next.text, form: 'dollarName', start: t.start, end: next.end });
        i++;
      }
    } else if (t.text === '?' && on.has('question')) {
      // `?|`, `?&` and `??` are operators
      const operator =
        (glued(t, next) && next.kind === 'sign' && ['|', '&', '?'].includes(next.text)) ||
        (glued(prev, t) && isSign(prev, '?'));
      if (!operator) {
        anonymous++;
        uses.push({ key: `?${anonymous}`, form: 'question', start: t.start, end: t.end });
      }
    }
  }
  return found.map((use) => {
    const first = tokens.findIndex((t) => t.start === use.start);
    const last = tokens.findIndex((t) => t.end === use.end);
    const open = tokens[first - 1];
    const before = tokens[first - 2];
    const list =
      isSign(open, '(') &&
      before?.kind === 'word' &&
      before.value === 'IN' &&
      isSign(tokens[last + 1], ')');
    return { ...use, list };
  });
}

/** The keys of the parameters that stand in an `IN (…)` somewhere in the statements. */
export function listKeys(
  sqls: readonly string[],
  dialect: Dialect,
  forms: readonly ParamForm[],
): Set<string> {
  const keys = new Set<string>();
  for (const sql of sqls) {
    for (const use of findParams(sql, dialect, forms)) if (use.list) keys.add(use.key);
  }
  return keys;
}

/** A value where it is used: `auto` in the brackets of an `IN` is a list. */
export function inPlace(value: ParamValue, list: boolean): ParamValue {
  return value.type === 'auto' && list ? { ...value, type: 'list' } : value;
}

/** The keys of the parameters of statements, each once, in the order they first stand. */
export function paramKeys(
  sqls: readonly string[],
  dialect: Dialect,
  forms: readonly ParamForm[],
): string[] {
  const keys: string[] = [];
  for (const sql of sqls) {
    for (const use of findParams(sql, dialect, forms)) {
      if (!keys.includes(use.key)) keys.push(use.key);
    }
  }
  return keys;
}

/** What a value is. `auto` reads it off the text. */
export type ParamType = 'auto' | 'text' | 'number' | 'date' | 'bool' | 'null' | 'list';
export const PARAM_TYPES: readonly ParamType[] = [
  'auto',
  'text',
  'number',
  'date',
  'bool',
  'list',
  'null',
];

/** A value as the user gave it. */
export interface ParamValue {
  readonly type: ParamType;
  readonly text: string;
}

export const EMPTY_VALUE: ParamValue = { type: 'auto', text: '' };

const INT = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.\d*|\.\d+)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/;
const YES = ['true', 't', 'yes', 'y', 'ja', 'j', '1'];
const NO = ['false', 'f', 'no', 'n', 'nein', '0'];

function number(text: string): BoundValue | null {
  const t = text.trim();
  if (INT.test(t)) {
    const digits = t.replace(/^[+-]/, '').replace(/^0+(?=\d)/, '');
    const sign = t.startsWith('-') ? '-' : '';
    // what an i64 holds for sure; longer numbers are exact as decimals
    return digits.length <= 18
      ? { kind: 'int', value: sign + digits }
      : { kind: 'decimal', value: sign + digits };
  }
  if (DECIMAL.test(t)) {
    const sign = t.startsWith('-') ? '-' : '';
    let body = t.replace(/^[+-]/, '');
    if (body.startsWith('.')) body = `0${body}`;
    if (body.endsWith('.')) body = `${body}0`;
    return { kind: 'decimal', value: sign + body };
  }
  return null;
}

const two = (n: string) => n.padStart(2, '0');

/** A date as the database reads it everywhere: `2026-11-11`, with a time `2026-11-11 12:30:00`. */
function date(text: string): BoundValue | null {
  const [day, ...rest] = text.trim().replace('T', ' ').split(/\s+/);
  if (rest.length > 1) return null;
  let iso: string | null = null;
  const a = ISO_DATE.exec(day);
  const b = LOCAL_DATE.exec(day);
  if (a) iso = day;
  else if (b) iso = `${b[3]}-${two(b[2])}-${two(b[1])}`;
  if (!iso) return null;
  const [, , month, dayOfMonth] = ISO_DATE.exec(iso)!.map(Number);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
  if (rest.length === 0) return { kind: 'date', value: iso };
  const time = TIME.exec(rest[0]);
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] ?? 0) > 59)
    return null;
  return {
    kind: 'datetime',
    value: `${iso} ${two(time[1])}:${time[2]}:${time[3] ?? '00'}${time[4] ?? ''}`,
  };
}

function bool(text: string): BoundValue | null {
  const t = text.trim().toLowerCase();
  if (YES.includes(t)) return { kind: 'bool', value: true };
  if (NO.includes(t)) return { kind: 'bool', value: false };
  return null;
}

/**
 * What `auto` takes a text for. Careful on purpose: only what is written the way the thing is written –
 * `0123` stays a text (a postcode), `1` a number and not a boolean, `11.11.2026` a text (it could be a
 * version); who means it otherwise chooses the type.
 */
export function guess(text: string): BoundValue {
  const t = text.trim();
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) return number(t) ?? { kind: 'text', value: text };
  if (t === 'true' || t === 'false') return { kind: 'bool', value: t === 'true' };
  if (ISO_DATE.test(t.split(/[ T]/)[0])) return date(t) ?? { kind: 'text', value: text };
  return { kind: 'text', value: text };
}

/** The entries of a list as typed: one per line, or separated by commas. */
export function listItems(text: string): string[] {
  const parts = text.includes('\n') ? text.split('\n') : text.split(',');
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** What a value is bound as: values (several for a list), `null` for NULL, or what is wrong with it. */
export type Resolved =
  | { readonly ok: true; readonly values: readonly BoundValue[] | null }
  | { readonly ok: false; readonly problem: 'number' | 'date' | 'bool' };

export function resolve(value: ParamValue): Resolved {
  const one = (v: BoundValue | null, problem: 'number' | 'date' | 'bool'): Resolved =>
    v ? { ok: true, values: [v] } : { ok: false, problem };
  switch (value.type) {
    case 'null':
      return { ok: true, values: null };
    case 'text':
      return { ok: true, values: [{ kind: 'text', value: value.text }] };
    case 'number':
      return one(number(value.text), 'number');
    case 'date':
      return one(date(value.text), 'date');
    case 'bool':
      return one(bool(value.text), 'bool');
    case 'list': {
      const items = listItems(value.text).map(guess);
      // one kind for all: numbers only when every entry is one
      const numeric = items.every((v) => v.kind === 'int' || v.kind === 'decimal');
      return {
        ok: true,
        values: numeric
          ? items
          : listItems(value.text).map((t) => ({ kind: 'text', value: t }) as const),
      };
    }
    case 'auto':
      return { ok: true, values: [guess(value.text)] };
  }
}

/** The placeholder of the `n`-th value (from 1) of a statement, as each driver wants it. */
export function placeholder(dialect: Dialect, n: number, kind: BoundValue['kind']): string {
  switch (dialect) {
    case 'postgres': {
      const p = `$${n}`;
      // numbers with a fraction and dates travel as text: the cast makes them what they are, exactly
      if (kind === 'decimal') return `CAST(${p} AS numeric)`;
      if (kind === 'date') return `CAST(${p} AS date)`;
      if (kind === 'datetime') return `CAST(${p} AS timestamp)`;
      return p;
    }
    case 'mysql':
      if (kind === 'decimal') return 'CAST(? AS DECIMAL(65,30))';
      if (kind === 'date') return 'CAST(? AS DATE)';
      if (kind === 'datetime') return 'CAST(? AS DATETIME(6))';
      return '?';
    case 'sqlserver': {
      const p = `@P${n}`;
      if (kind === 'date') return `CAST(${p} AS date)`;
      if (kind === 'datetime') return `CAST(${p} AS datetime2)`;
      return p;
    }
    case 'sqlite':
      return `?${n}`;
  }
}

/** A piece of the statement that was replaced: where it stood, and where its replacement stands. */
export interface Replaced {
  readonly from: number;
  readonly to: number;
  readonly sentFrom: number;
  readonly sentTo: number;
}

export interface BoundStatement {
  /** The statement with the placeholders of the driver. */
  readonly sql: string;
  readonly params: readonly BoundValue[];
  readonly replaced: readonly Replaced[];
}

export type Binding =
  | { readonly ok: true; readonly statement: BoundStatement }
  | {
      readonly ok: false;
      /** The parameter that has no value, or whose value is not what its type says. */
      readonly key: string;
      readonly problem: 'missing' | 'number' | 'date' | 'bool';
    };

/**
 * Writes a statement for the driver: every parameter becomes the placeholder of its value – a list as
 * many placeholders as it has entries (none: `NULL`, which matches nothing), `NULL` the word itself. The
 * values go apart. A statement without parameters comes back as it is, with no values.
 */
export function bind(
  sql: string,
  dialect: Dialect,
  forms: readonly ParamForm[],
  values: Readonly<Record<string, ParamValue>>,
): Binding {
  const uses = findParams(sql, dialect, forms);
  const params: BoundValue[] = [];
  const replaced: Replaced[] = [];
  let out = '';
  let at = 0;
  for (const use of uses) {
    const value = values[use.key];
    if (!value) return { ok: false, key: use.key, problem: 'missing' };
    const resolved = resolve(inPlace(value, use.list));
    if (!resolved.ok) return { ok: false, key: use.key, problem: resolved.problem };
    out += sql.slice(at, use.start);
    const sentFrom = out.length;
    if (resolved.values === null || resolved.values.length === 0) {
      out += 'NULL';
    } else {
      out += resolved.values
        .map((v) => {
          params.push(v);
          return placeholder(dialect, params.length, v.kind);
        })
        .join(', ');
    }
    replaced.push({ from: use.start, to: use.end, sentFrom, sentTo: out.length });
    at = use.end;
  }
  out += sql.slice(at);
  return { ok: true, statement: { sql: out, params, replaced } };
}

/**
 * A position of the statement as sent (characters from 1, as the databases count) in the statement as
 * written. A place inside a placeholder is the start of its parameter.
 */
export function writtenPosition(written: string, bound: BoundStatement, position: number): number {
  // characters → UTF-16 in the sent text
  let offset = 0;
  let seen = 1;
  for (const ch of bound.sql) {
    if (seen >= position) break;
    offset += ch.length;
    seen++;
  }
  let shift = 0;
  for (const r of bound.replaced) {
    if (offset < r.sentFrom) break;
    if (offset < r.sentTo) return codePoints(written.slice(0, r.from)) + 1;
    shift = r.to - r.sentTo;
  }
  return codePoints(written.slice(0, Math.max(0, offset + shift))) + 1;
}

/** What a value is, for the messages: `kunde = 42`, `ab = 2026-01-01`, `ids = (1, 2, 3)`. */
export function describeValue(key: string, value: ParamValue): string {
  const resolved = resolve(value);
  const show = (v: BoundValue) =>
    v.kind === 'text' ? `'${String(v.value).replace(/'/g, "''")}'` : String(v.value);
  let text: string;
  if (!resolved.ok) text = value.text;
  else if (resolved.values === null) text = 'NULL';
  else if (value.type === 'list') text = `(${resolved.values.map(show).join(', ')})`;
  else text = show(resolved.values[0]);
  const cut = text.length > 80 ? `${text.slice(0, 77)}…` : text;
  return `${key} = ${cut}`;
}
