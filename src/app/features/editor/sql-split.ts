/**
 * Pure helpers for the statement under the caret: splits a script at `;` outside of strings, quoted
 * identifiers and comments (`--`, `/* … *\/`). Good enough for the walking skeleton; dialect details
 * (dollar quoting, `DELIMITER`, `GO`) come with the editor prompt.
 */
export interface Statement {
  /** The statement without its `;`, trimmed. */
  readonly text: string;
  /** Offsets in the script: from the first character after the previous `;` to the own `;` (exclusive). */
  readonly start: number;
  readonly end: number;
}

export function splitStatements(script: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const text = script.slice(start, end).trim();
    if (text) out.push({ text, start, end });
    start = end + 1;
  };
  while (i < script.length) {
    const c = script[i];
    const next = script[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      // a doubled quote inside is an escaped quote: the loop simply re-enters the string
      const close = script.indexOf(c, i + 1);
      i = close < 0 ? script.length : close + 1;
    } else if (c === '-' && next === '-') {
      const eol = script.indexOf('\n', i);
      i = eol < 0 ? script.length : eol + 1;
    } else if (c === '/' && next === '*') {
      const close = script.indexOf('*/', i + 2);
      i = close < 0 ? script.length : close + 2;
    } else {
      if (c === ';') push(i);
      i++;
    }
  }
  push(script.length);
  return out;
}

/** Offset of a 1-based line and column in `script`. */
export function offsetOf(script: string, line: number, ch: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const eol = script.indexOf('\n', offset);
    if (eol < 0) return script.length;
    offset = eol + 1;
  }
  return Math.min(script.length, offset + Math.max(0, ch - 1));
}

/**
 * The statement the caret is in or directly behind (caret after the `;` still means that statement);
 * between two statements the following one, at the very end the last one.
 */
export function statementAt(script: string, offset: number): Statement | null {
  const statements = splitStatements(script);
  if (!statements.length) return null;
  for (const s of statements) {
    // `end` is the position of the `;`: a caret right behind it (end + 1) still belongs to it
    if (offset <= s.end + 1) return s;
  }
  return statements[statements.length - 1];
}
