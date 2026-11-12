#!/usr/bin/env node
// Builds what the site takes from the repository (run from the repository root: `node site/build.mjs`):
//   1. site/favicon.png and site/img/icon.png from the app icon,
//   2. the swatches of the colour schemes in site/index.html from src/app/core/theme/themes/*.json
//      (the real token values: the scene on the page is drawn with them),
//   3. the shortcut rows in site/keyboard.html from the action catalog and the keymaps, and the number of
//      actions on the start page.
// `--check` writes nothing and fails if a file would change (for CI or before a commit).
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = dirname(fileURLToPath(import.meta.url));
const root = join(site, '..');
const check = process.argv.includes('--check');
let stale = 0;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function write(file, next) {
  const before = readFileSync(file, 'utf8');
  if (before === next) return;
  if (check) { stale += 1; console.error(`stale: ${file}`); return; }
  writeFileSync(file, next);
}

/** Replaces what stands between `<!-- name:start -->` and `<!-- name:end -->`. */
function between(page, name, html, indent) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(page)) throw new Error(`markers of "${name}" not found`);
  return page.replace(re, (_, a, b) => `${a}\n${html}\n${indent}${b}`);
}

function icons() {
  if (check) return;
  mkdirSync(join(site, 'img'), { recursive: true });
  copyFileSync(join(root, 'src-tauri', 'icons', '128x128@2x.png'), join(site, 'img', 'icon.png'));
  copyFileSync(join(root, 'src-tauri', 'icons', '64x64.png'), join(site, 'favicon.png'));
}

// token of the site ← token of the app
const TOKENS = {
  '--bg-app': '--bg-app', '--panel': '--bg-panel', '--raised': '--bg-raised', '--hover': '--bg-hover',
  '--border': '--border', '--text': '--text', '--dim': '--text-dim', '--faint': '--text-dim', '--accent': '--accent',
  '--kw': '--sql-keyword', '--str': '--sql-string', '--num': '--sql-number', '--ident': '--sql-ident',
  '--fn': '--sql-function', '--comment': '--sql-comment', '--null': '--cell-null', '--sel': '--row-selected',
  '--changed-bg': '--cell-changed-bg', '--changed-fg': '--cell-changed-text',
};

// the two base schemes carry German names in the app's files; the site is English
const NAMES = { dark: 'Dark', light: 'Light' };

function schemes() {
  const dir = join(root, 'src', 'app', 'core', 'theme', 'themes');
  const themes = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  // a scheme names what differs; the rest comes from the base of its kind (as in the app)
  const base = (t) => themes.find((b) => b.id === (t.dark ? 'dark' : 'light')).tokens;
  const first = ['dark', 'light'];
  themes.sort((a, b) => (first.indexOf(a.id) + 1 || 9) - (first.indexOf(b.id) + 1 || 9) || a.name.localeCompare(b.name));
  const html = themes.map((t, i) => {
    const tokens = {};
    for (const [mine, theirs] of Object.entries(TOKENS)) {
      const value = t.tokens[theirs] ?? base(t)[theirs];
      if (!/^#[0-9a-f]{3,8}$/i.test(value ?? '')) throw new Error(`${t.id}: ${theirs} is not a colour`);
      tokens[mine] = value;
    }
    return `        <button class="swatch" type="button" aria-pressed="${i === 0}" data-theme="${esc(JSON.stringify(tokens))}" style="--a:${tokens['--bg-app']};--b:${tokens['--accent']}"><i></i>${esc(NAMES[t.id] ?? t.name)}</button>`;
  }).join('\n');
  const file = join(site, 'index.html');
  write(file, between(readFileSync(file, 'utf8'), 'schemes', html, '        '));
  console.log(`index.html: ${themes.length} colour schemes`);
  return themes.length;
}

/** The actions of the catalog: the file has no imports, its entries are read as text. */
function actions() {
  const text = readFileSync(join(root, 'src', 'app', 'core', 'actions', 'action-catalog.ts'), 'utf8');
  const out = [];
  const re = /\{\s*id:\s*'([A-Z0-9_]+)',\s*label:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),\s*group:\s*'(\w+)'/g;
  for (const m of text.matchAll(re)) out.push({ id: m[1], label: (m[2] ?? m[3]).replace(/\\(.)/g, '$1'), group: m[4] });
  if (out.length < 50) throw new Error('action-catalog.ts: could not read the actions');
  return out;
}

const MAC = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const ARROWS = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' };
const MAC_KEYS = { ...ARROWS, Enter: '↵', Backspace: '⌫', Delete: '⌦' };
function stroke(s, mac) {
  const parts = s === '+' ? ['+'] : s.replace(/\+\+$/, '+PLUS').split('+').map((p) => (p === 'PLUS' ? '+' : p));
  const key = parts.pop();
  const shown = (mac ? MAC_KEYS : ARROWS)[key] ?? key;
  if (mac) return ['Ctrl', 'Alt', 'Shift', 'Mod'].filter((m) => parts.includes(m)).map((m) => MAC[m]).join('') + shown;
  const mods = [...new Set(parts.map((m) => (m === 'Mod' ? 'Ctrl' : m)))];
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.includes(m)), shown].join('+');
}
const shortcut = (s, mac) => s.split(' ').map((one) => `<kbd>${esc(stroke(one, mac))}</kbd>`).join(' ');
const cell = (list, mac) => (list?.length ? list.map((s) => shortcut(s, mac)).join(' <span class="no">or</span> ') : '<span class="no">–</span>');

function keyboard(all) {
  const map = (name) => JSON.parse(readFileSync(join(root, 'src', 'app', 'core', 'actions', 'keymaps', `${name}.json`), 'utf8'));
  const [mac, win, linux] = [map('macos'), map('windows'), map('linux')];
  if (JSON.stringify(win) !== JSON.stringify(linux)) throw new Error('windows.json and linux.json differ: keyboard.html needs a third column');
  const groups = [...new Set(all.map((a) => a.group))];
  let count = 0;
  const html = groups.flatMap((group) => {
    const rows = all.filter((a) => a.group === group && (mac[a.id]?.length || win[a.id]?.length));
    if (!rows.length) return [];
    count += rows.length;
    return [
      `            <tr class="group-row"><th colspan="3" scope="colgroup">${esc(group)}</th></tr>`,
      ...rows.map((a) => `            <tr><td>${esc(a.label)}</td><td>${cell(mac[a.id], true)}</td><td>${cell(win[a.id], false)}</td></tr>`),
    ];
  }).join('\n');
  const file = join(site, 'keyboard.html');
  write(file, between(readFileSync(file, 'utf8'), 'keymap', html, '            '));
  console.log(`keyboard.html: ${count} shortcuts of ${all.length} actions`);
}

function numbers(all) {
  const file = join(site, 'index.html');
  const page = readFileSync(file, 'utf8');
  const re = /<b data-count="\d+">\d+<\/b>(<span>actions)/;
  if (!re.test(page)) throw new Error('index.html: the number of actions was not found');
  write(file, page.replace(re, `<b data-count="${all.length}">${all.length}</b>$1`));
}

icons();
schemes();
const all = actions();
keyboard(all);
numbers(all);
if (stale) { console.error('run `node site/build.mjs`'); process.exit(1); }
