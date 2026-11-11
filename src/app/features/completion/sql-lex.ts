import { Dialect } from '../editor/sql-split';

/**
 * A small tokenizer for SQL as it is typed (prompt 021): it never fails – an open string or comment simply
 * ends where the text ends. It knows what the completion needs to know: words, quoted names, strings,
 * comments, numbers and signs, each with its place in the text.
 */
export type TokenKind = 'word' | 'quoted' | 'string' | 'comment' | 'number' | 'sign';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /** A word in upper case; a quoted name without its quotes; else the text. */
  readonly value: string;
  readonly start: number;
  /** Behind its last character. */
  readonly end: number;
  /** A string, comment or quoted name that the text ended in. */
  readonly open?: boolean;
}

const WORD = /[\p{L}\p{N}_$#@]/u;
const WORD_START = /[\p{L}_#@]/u;

export function lex(sql: string, dialect: Dialect): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number, value?: string, open = false) => {
    const text = sql.slice(start, end);
    tokens.push({
      kind,
      text,
      value: value ?? (kind === 'word' ? text.toUpperCase() : text),
      start,
      end,
      ...(open ? { open } : {}),
    });
  };
  /** Reads up to the closing `quote` (doubled = the quote itself); answers with the end and the content. */
  const quoted = (from: number, quote: string, backslash: boolean) => {
    let j = from + 1;
    let value = '';
    while (j < sql.length) {
      if (backslash && sql[j] === '\\' && j + 1 < sql.length) {
        value += sql[j + 1];
        j += 2;
      } else if (sql[j] === quote) {
        if (sql[j + 1] === quote) {
          value += quote;
          j += 2;
        } else {
          return { end: j + 1, value, open: false };
        }
      } else {
        value += sql[j++];
      }
    }
    return { end: sql.length, value, open: true };
  };
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol < 0 ? sql.length : eol;
      // a line comment the text ends in is still being written
      push('comment', i, end, undefined, eol < 0);
      i = end;
    } else if (c === '#' && dialect === 'mysql' && !WORD.test(sql[i + 1] ?? '')) {
      const eol = sql.indexOf('\n', i);
      const end = eol < 0 ? sql.length : eol;
      push('comment', i, end, undefined, eol < 0);
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close < 0 ? sql.length : close + 2;
      push('comment', i, end, undefined, close < 0);
      i = end;
    } else if (c === "'") {
      const q = quoted(i, "'", dialect === 'mysql');
      push('string', i, q.end, q.value, q.open);
      i = q.end;
    } else if (c === '"' && dialect !== 'mysql') {
      const q = quoted(i, '"', false);
      push('quoted', i, q.end, q.value, q.open);
      i = q.end;
    } else if (c === '"') {
      // MySQL: a string unless ANSI_QUOTES is on – the common case
      const q = quoted(i, '"', true);
      push('string', i, q.end, q.value, q.open);
      i = q.end;
    } else if (c === '`' && (dialect === 'mysql' || dialect === 'sqlite')) {
      const q = quoted(i, '`', false);
      push('quoted', i, q.end, q.value, q.open);
      i = q.end;
    } else if (c === '[' && (dialect === 'sqlserver' || dialect === 'sqlite')) {
      const close = sql.indexOf(']', i + 1);
      const end = close < 0 ? sql.length : close + 1;
      push('quoted', i, end, sql.slice(i + 1, close < 0 ? sql.length : close), close < 0);
      i = end;
    } else if (c === '$' && dialect === 'postgres' && /^\$[\p{L}_]*\$/u.test(sql.slice(i, i + 64))) {
      const tag = /^\$[\p{L}_]*\$/u.exec(sql.slice(i, i + 64))![0];
      const close = sql.indexOf(tag, i + tag.length);
      const end = close < 0 ? sql.length : close + tag.length;
      push('string', i, end, undefined, close < 0);
      i = end;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9a-zA-Z_.]/.test(sql[j])) j++;
      push('number', i, j);
      i = j;
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < sql.length && WORD.test(sql[j])) j++;
      push('word', i, j);
      i = j;
    } else if (c === ':' && sql[i + 1] === ':') {
      push('sign', i, i + 2);
      i += 2;
    } else if ('<>!='.includes(c) && '<>='.includes(sql[i + 1] ?? ' ')) {
      push('sign', i, i + 2);
      i += 2;
    } else {
      push('sign', i, i + 1);
      i++;
    }
  }
  return tokens;
}

/** A token that can be a name: a word or a quoted name. */
export const isName = (t: Token | undefined): t is Token =>
  !!t && (t.kind === 'word' || t.kind === 'quoted');
