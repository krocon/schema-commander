import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alternatives,
  fillMissing,
  group,
  licenceFiles,
  normalise,
  render,
  shippedCrates,
  upToDate,
} from './notices.mjs';

const dep = (pkg, kinds) => ({ pkg, dep_kinds: kinds.map((kind) => ({ kind })) });

test('only normal dependencies reachable from our crate ship', () => {
  const meta = {
    workspace_members: ['app'],
    packages: ['app', 'a', 'b', 'build', 'dev', 'via-build'].map((id) => ({
      id,
      name: id,
      version: '1.0.0',
      license: 'MIT',
      authors: [],
      manifest_path: `/reg/${id}/Cargo.toml`,
    })),
    resolve: {
      nodes: [
        { id: 'app', deps: [dep('a', [null]), dep('build', ['build']), dep('dev', ['dev'])] },
        { id: 'a', deps: [dep('b', [null, 'build'])] },
        { id: 'build', deps: [dep('via-build', [null])] },
        { id: 'b', deps: [] },
        { id: 'dev', deps: [] },
        { id: 'via-build', deps: [] },
      ],
    },
  };
  assert.deepEqual(
    shippedCrates(meta)
      .map((p) => p.name)
      .sort(),
    ['a', 'b'],
  );
});

test('licence files: root names and extra files of a package', () => {
  const files = {
    '/p': [
      'LICENSE-MIT',
      'LICENSE-APACHE',
      'NOTICE',
      'README.md',
      'license.txt',
      'src',
      'COPYING',
      // what editlicious-editor ships for the crates inside its WebAssembly
      'THIRD-PARTY-NOTICES.txt',
    ],
  };
  const fs = {
    readdirSync: (d) => files[d] ?? [],
    statSync: (f) => ({ isFile: () => !f.endsWith('/src') }),
    existsSync: () => false,
  };
  assert.deepEqual(licenceFiles('/p', 'x', fs), [
    'COPYING',
    'LICENSE-APACHE',
    'LICENSE-MIT',
    'NOTICE',
    'THIRD-PARTY-NOTICES.txt',
    'license.txt',
  ]);
});

test('equal texts group together, whatever the line ends', () => {
  const { groups, without } = group([
    { label: 'b 1', texts: ['MIT text\r\n'] },
    { label: 'a 1', texts: ['﻿MIT text  \n\n'] },
    { label: 'c 1', texts: ['other'] },
    { label: 'd 1', license: 'MIT', texts: [] },
  ]);
  assert.deepEqual(
    groups.map((g) => g.labels),
    [['a 1', 'b 1'], ['c 1']],
  );
  assert.equal(groups[0].text, 'MIT text\n');
  assert.deepEqual(
    without.map((c) => c.label),
    ['d 1'],
  );
  assert.match(
    render({ groups, without }, { crates: 3, npm: 0, assets: 0 }),
    /without a licence file[\s\S]*d 1/,
  );
});

test('SPDX alternatives', () => {
  assert.deepEqual(alternatives('MIT OR Apache-2.0'), ['MIT', 'Apache-2.0']);
  assert.deepEqual(alternatives('MIT/Apache-2.0'), ['MIT', 'Apache-2.0']);
  assert.deepEqual(alternatives('(MIT OR Apache-2.0) AND Unicode-3.0'), []);
  assert.deepEqual(alternatives(null), []);
});

test('a crate without a licence file gets the standard text of a licence it offers', () => {
  const apache = 'Apache License\n                           Version 2.0, January 2004\n…terms…';
  const mit = 'Copyright (c) Someone Else\n\nPermission is hereby granted, free of charge, …';
  const out = fillMissing([
    { label: 'has-apache', license: 'Apache-2.0', texts: [apache] },
    { label: 'has-mit', license: 'MIT', texts: [mit] },
    { label: 'either', license: 'MIT OR Apache-2.0', authors: [], texts: [] },
    {
      label: 'mit-only',
      name: 'mit-only',
      license: 'MIT',
      authors: ['Ann <ann@x.org>', 'Bo'],
      texts: [],
    },
    { label: 'gpl', license: 'GPL-3.0', texts: [] },
  ]);
  // Apache-2.0 is preferred: the unchanged text another crate ships
  assert.equal(out[2].texts[0], normalise(apache));
  // MIT: the standard body, the crate's authors as copyright holders (no e-mail)
  assert.equal(
    out[3].texts[0],
    'Copyright (c) Ann, Bo\n\nPermission is hereby granted, free of charge, …\n',
  );
  // nothing to offer: stays without text (listed apart)
  assert.deepEqual(out[4].texts, []);
});

test('notices --check: a CRLF checkout (git autocrlf on Windows) is still up to date', () => {
  const generated = 'A\n\nB text\n';
  assert.ok(upToDate(generated, generated));
  assert.ok(upToDate('A\r\n\r\nB text\r\n', generated));
  assert.ok(!upToDate('A\r\n\r\nB other\r\n', generated));
  assert.ok(!upToDate('', generated));
});
