#!/usr/bin/env node
// Texts of the UI live in catalogs (prompt 017): `*-texts.ts` (English, the source) and `*.de.ts` (German).
// This check fails when a text stands in a template or German text in a source file:
//   1. a text node of an inline template with a word in it,
//   2. a static `title`, `aria-label`, `placeholder`, `label` or `alt` with a word in it,
//   3. a string literal that reads like a text in a binding or an interpolation,
//   4. an umlaut or ß outside `*.de.ts` (German belongs into the German catalogs).
// A line that must stay as it is ends with `// texts-ok: <why>`; in a template `<!-- texts-ok: <why> -->`
// on the line before.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'label', 'alt']);
/** Bindings whose strings are names for the machine, not texts. */
const NAME_BINDINGS =
  /^(\[?(class|id|style|ngClass|tabindex|role|type|for|name|value|orientation|pane|controls|scope|src|href)\]?|\[(class|style|attr\.(id|data-[\w-]+|aria-(controls|labelledby|describedby|activedescendant|owns|orientation|selected|pressed|expanded|checked|current|haspopup|sort)|role|for|type|color-scheme|ui-language|line-numbers))[\w.%-]*\]?|\([\w.:-]+\))$/;
const WORD = /\p{L}{2,}/u;
/** Words that are the same in every language (symbols of the UI, names). */
const SAME = new Set(['TX', 'SQL', 'NULL', 'OK', 'ms', 'px', 'UTF', 'TLS', 'SSH', 'CSV', 'JSON']);

const hasWord = (text) => (text.match(/\p{L}{2,}/gu) ?? []).some((w) => !SAME.has(w));

/** A string literal of an expression reads like a text: a blank between words, or a capital first letter. */
function textLiterals(expression) {
  const found = [];
  for (const m of expression.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
    const s = m[1];
    if (!hasWord(s)) continue;
    if (/^[A-Z0-9_]+$/.test(s)) continue; // an action id, a constant
    if (/^[\w.#:[\]=-]+$/.test(s) && !/^\p{Lu}\p{Ll}/u.test(s)) continue; // a name: `tab-`, `row`
    if (/^(Arrow(Left|Right|Up|Down)|Home|End|Enter|Escape|Tab|Delete|Backspace)$/.test(s))
      continue;
    if (/\p{L}{2,}\s+\p{L}{2,}/u.test(s) || /^\p{Lu}\p{Ll}/u.test(s) || /[äöüÄÖÜß]/.test(s)) {
      found.push(s);
    }
  }
  return found;
}

/** The problems of one inline template; `line` counts from the start of the template. */
export function checkTemplate(template) {
  const problems = [];
  const lineAt = (i) => template.slice(0, i).split('\n').length;
  const allowed = new Set();
  for (const m of template.matchAll(/<!--\s*texts-ok:[^>]*-->/g)) allowed.add(lineAt(m.index) + 1);
  const add = (i, kind, text) => {
    const line = lineAt(i);
    if (!allowed.has(line)) problems.push({ line, kind, text: text.trim().slice(0, 60) });
  };
  const text = (from, to) => {
    let raw = template.slice(from, to);
    // interpolations are expressions: their literals are checked, the rest is no text
    raw = raw.replace(/\{\{([\s\S]*?)\}\}/g, (all, expression, at) => {
      for (const s of textLiterals(expression)) add(from + at, 'literal', s);
      return ' '.repeat(all.length);
    });
    // control flow: `@if (…) {`, `@for (…) {`, `@let a = …;`, `@else`, `}`
    raw = raw
      .replace(/@let\s[\s\S]*?;/g, (all) => ' '.repeat(all.length))
      .replace(
        /@(if|for|switch|case|defer|else if)\s*\((?:[^()]|\([^()]*\))*\)\s*(?:;[^{]*)?/g,
        (all) => ' '.repeat(all.length),
      )
      .replace(/@(else|empty|default|placeholder|loading|error)\b/g, (all) =>
        ' '.repeat(all.length),
      );
    const m = raw.match(WORD);
    if (m && hasWord(raw)) {
      const at = raw.search(/\S/);
      add(from + Math.max(0, at), 'text', raw.trim().replace(/\s+/g, ' '));
    }
  };
  let i = 0;
  let textFrom = 0;
  while (i < template.length) {
    if (template.startsWith('<!--', i)) {
      text(textFrom, i);
      const end = template.indexOf('-->', i);
      i = end < 0 ? template.length : end + 3;
      textFrom = i;
    } else if (template[i] === '<' && /[a-zA-Z/]/.test(template[i + 1] ?? '')) {
      text(textFrom, i);
      // the tag, attribute by attribute (a value may hold `>`)
      let j = i + 1;
      while (j < template.length && template[j] !== '>') {
        const attr = /^\s*([^\s=>/"']+)(?:\s*=\s*"([^"]*)")?/.exec(template.slice(j));
        if (!attr || attr[0].length === 0) {
          j++;
          continue;
        }
        const [all, name, value] = attr;
        const at = j + all.length - (value?.length ?? 0) - 1;
        if (value !== undefined && j > i + 1) {
          const bound = /^[[(@]/.test(name);
          if (!bound && TEXT_ATTRIBUTES.has(name) && hasWord(value)) add(at, 'attribute', value);
          else if (bound && !NAME_BINDINGS.test(name)) {
            for (const s of textLiterals(value)) add(at, 'literal', s);
          }
        }
        j += all.length;
      }
      i = j + 1;
      textFrom = i;
    } else {
      i++;
    }
  }
  text(textFrom, template.length);
  return problems;
}

/** The problems of one source file. */
export function checkSource(path, source) {
  const problems = [];
  const lines = source.split('\n');
  if (!path.endsWith('.de.ts')) {
    lines.forEach((line, n) => {
      if (/[äöüÄÖÜß]/.test(line) && !/texts-ok:/.test(line)) {
        problems.push({ line: n + 1, kind: 'german', text: line.trim().slice(0, 60) });
      }
    });
  }
  for (const m of source.matchAll(/\btemplate:\s*`((?:[^`\\]|\\.)*)`/g)) {
    const start = source.slice(0, m.index).split('\n').length - 1;
    for (const p of checkTemplate(m[1])) problems.push({ ...p, line: p.line + start });
  }
  return problems;
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) yield path;
  }
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const targets = process.argv.slice(2);
  const list = targets.length
    ? targets.flatMap((t) => (statSync(t).isDirectory() ? [...files(t)] : [t]))
    : [...files(join(root, 'src/app'))];
  let count = 0;
  for (const path of list) {
    for (const p of checkSource(path, readFileSync(path, 'utf8'))) {
      count++;
      console.log(`${relative(process.cwd(), path)}:${p.line}  ${p.kind}: ${p.text}`);
    }
  }
  if (count > 0) {
    console.error(`\n${count} text(s) outside the catalogs (see scripts/check-texts.mjs).`);
    process.exit(1);
  }
  console.log(`texts: ${list.length} files, every text is in a catalog.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
