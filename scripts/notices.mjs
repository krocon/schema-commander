#!/usr/bin/env node
// THIRD-PARTY-NOTICES.txt: the licence texts of everything that ships inside the app
// (prompt 034, taken from files-and-folders-tauri). No extra tools: Rust via `cargo metadata` (normal dependencies
// reachable from our crate, every target platform – an upper bound), npm via
// `pnpm licenses list --prod`, plus fixed texts for bundled assets (scripts/notices/).
// Identical licence texts are printed once, with every component that uses them.
//
//   pnpm notices            # writes THIRD-PARTY-NOTICES.txt
//   pnpm notices --check    # fails if the file is out of date (needs cargo + node_modules)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'THIRD-PARTY-NOTICES.txt');

/** File names that hold a licence or a notice the licence asks to keep (NOTICE of Apache-2.0). */
const LICENCE_FILE =
  /^(licen[cs]e|copying|notice|unlicense|copyright|third[-_ ]party[-_ ]notices)([-._].*)?$/i;

/** Licence texts that live deeper in a package than its root. */
const EXTRA_FILES = {};

/** Bundled assets that are no package (relative to scripts/notices/). */
const ASSETS = [];

/**
 * Packages reachable from the workspace members over normal (not build/dev) dependencies,
 * for every target platform. `meta` is the output of `cargo metadata`.
 */
export function shippedCrates(meta) {
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  const own = new Set(meta.workspace_members);
  const seen = new Set();
  const todo = [...own];
  while (todo.length > 0) {
    const id = todo.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((k) => k.kind === null)) todo.push(dep.pkg);
    }
  }
  return [...seen]
    .filter((id) => !own.has(id))
    .map((id) => pkgs.get(id))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? null,
      authors: p.authors ?? [],
      dir: dirname(p.manifest_path),
    }));
}

/** Licence files of a package directory (sorted, so the output is stable). */
export function licenceFiles(dir, name, fs = { readdirSync, statSync, existsSync }) {
  const own = fs
    .readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f) && fs.statSync(join(dir, f)).isFile())
    .sort();
  const extra = (EXTRA_FILES[name] ?? []).filter((f) => fs.existsSync(join(dir, f)));
  return [...own, ...extra];
}

/** Normalised text (line ends, trailing blanks) – so equal licences group together. */
export function normalise(text) {
  return (
    text
      .replace(/^﻿/, '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => l.trimEnd())
      .join('\n')
      .trim() + '\n'
  );
}

/**
 * `--check`: is the file on disk the generated text? Line ends do not count – git with
 * `core.autocrlf` (default on Windows, also on GitHub's runners) checks the file out with CRLF.
 */
export function upToDate(onDisk, generated) {
  return onDisk.replace(/\r\n/g, '\n') === generated;
}

/**
 * Groups components by identical licence text. `components`: { label, license, texts: string[] }.
 * Components without any text are listed apart (with their licence id).
 */
export function group(components) {
  const byHash = new Map();
  const without = [];
  for (const c of components) {
    if (c.texts.length === 0) {
      without.push(c);
      continue;
    }
    for (const t of c.texts) {
      const text = normalise(t);
      const h = createHash('sha256').update(text).digest('hex');
      const g = byHash.get(h) ?? { text, labels: [] };
      if (!g.labels.includes(c.label)) g.labels.push(c.label);
      byHash.set(h, g);
    }
  }
  const groups = [...byHash.values()];
  for (const g of groups) g.labels.sort((a, b) => a.localeCompare(b));
  groups.sort((a, b) => a.labels[0].localeCompare(b.labels[0]) || a.text.localeCompare(b.text));
  without.sort((a, b) => a.label.localeCompare(b.label));
  return { groups, without };
}

/** Licence ids offered by an SPDX expression ("MIT OR Apache-2.0", "MIT/Apache-2.0"). */
export function alternatives(expr) {
  // "A AND B" needs both texts – no single standard text fits; such crates are listed apart
  if (/\sAND\s/.test(expr ?? '')) return [];
  return (expr ?? '')
    .replace(/[()]/g, ' ')
    .split(/\s+OR\s+|\//)
    .map((a) => a.trim())
    .filter((a) => a !== '' && !/\sAND\s/.test(a));
}

/** Standard texts, preferred in this order when a component offers a choice. */
const STANDARD = [
  { id: 'Apache-2.0', match: /^Apache License\s+Version 2\.0, January 2004/, from: null },
  { id: 'MPL-2.0', match: /^Mozilla Public License Version 2\.0/, from: null },
  {
    id: 'MIT',
    match: /Permission is hereby granted, free of charge/,
    from: 'Permission is hereby granted',
  },
  {
    id: 'BSD-3-Clause',
    match: /Neither the name of the copyright holder/,
    from: 'Redistribution and use',
  },
];

/**
 * Components without a licence file get the standard text of a licence they offer – the
 * unchanged text another component ships (Apache-2.0, MPL-2.0), or for MIT/BSD-3-Clause the
 * standard body with the crate's authors as copyright holders. Returns the text or null.
 */
export function standardTextFor(component, shipped) {
  for (const std of STANDARD) {
    if (!alternatives(component.license).includes(std.id)) continue;
    const base = shipped.map(normalise).find((t) => std.match.test(t.trimStart()));
    if (!base) continue;
    if (std.from === null) return base;
    const holders = component.authors?.length
      ? component.authors.map((a) => a.replace(/\s*<[^>]*>/, '')).join(', ')
      : `the authors of ${component.name}`;
    return `Copyright (c) ${holders}\n\n${base.slice(base.indexOf(std.from))}`;
  }
  return null;
}

/** Fills in the standard texts for components that ship none (see standardTextFor). */
export function fillMissing(components) {
  const shipped = components
    .flatMap((c) => c.texts.map((t) => ({ label: c.label, t })))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((x) => x.t);
  return components.map((c) => {
    if (c.texts.length > 0) return c;
    const text = standardTextFor(c, shipped);
    return text ? { ...c, texts: [text], standard: true } : c;
  });
}

export function render({ groups, without }, counts) {
  const rule = '='.repeat(80);
  const out = [
    'THIRD-PARTY NOTICES – Schema Commander',
    '',
    'Schema Commander is licensed under the MIT License (see LICENSE). It contains the',
    'following third-party components. Generated by `pnpm notices` (scripts/notices.mjs).',
    `Rust crates: ${counts.crates} (all target platforms, so some are not part of every`,
    `build), npm packages: ${counts.npm}, bundled assets: ${counts.assets}.`,
    '',
    'Components whose licence lets you choose (e.g. "MIT OR Apache-2.0") are used under',
    'any one of the offered licences; every licence text the component ships is reproduced.',
    'MPL-2.0 components are unmodified; their source code is available from crates.io.',
    'Crates that ship no licence file are listed with the standard text of their declared',
    'licence (for MIT/BSD-3-Clause with the authors from Cargo.toml as copyright holders).',
    '',
  ];
  for (const g of groups) {
    out.push(rule, ...g.labels, rule, '', g.text);
  }
  if (without.length > 0) {
    out.push(
      rule,
      'Components without a licence file in their package (licence as declared):',
      rule,
      '',
      ...without.map((c) => c.label),
      '',
    );
  }
  return out.join('\n');
}

function cargoComponents() {
  const out = execFileSync(
    'cargo',
    [
      'metadata',
      '--format-version',
      '1',
      '--manifest-path',
      join(ROOT, 'src-tauri/Cargo.toml'),
      '--locked',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return shippedCrates(JSON.parse(out)).map((p) => ({
    label: `${p.name} ${p.version} (${p.license ?? 'no licence declared'})`,
    name: p.name,
    license: p.license,
    authors: p.authors,
    texts: licenceFiles(p.dir, p.name).map((f) => readFileSync(join(p.dir, f), 'utf8')),
  }));
}

function npmComponents() {
  const out = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  return Object.entries(JSON.parse(out)).flatMap(([license, list]) =>
    list.map((p) => {
      const dir = p.paths[0];
      return {
        label: `${p.name} ${p.versions.join(', ')} (${license}, npm)`,
        license,
        texts: licenceFiles(dir, p.name).map((f) => readFileSync(join(dir, f), 'utf8')),
      };
    }),
  );
}

function assetComponents() {
  return ASSETS.map((a) => ({
    label: `${a.name} ${a.version} (${a.license}, bundled asset)`,
    license: a.license,
    texts: [readFileSync(join(ROOT, 'scripts/notices', a.file), 'utf8')],
  }));
}

function main() {
  const crates = cargoComponents();
  const npm = npmComponents();
  const assets = assetComponents();
  const text = render(group(fillMissing([...crates, ...npm, ...assets])), {
    crates: crates.length,
    npm: npm.length,
    assets: assets.length,
  });
  if (process.argv.includes('--check')) {
    const old = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (!upToDate(old, text)) {
      console.error('THIRD-PARTY-NOTICES.txt is out of date – run `pnpm notices`.');
      process.exit(1);
    }
    return;
  }
  writeFileSync(OUT, text);
  console.log(
    `THIRD-PARTY-NOTICES.txt: ${crates.length} crates, ${npm.length} npm packages, ${assets.length} assets`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
