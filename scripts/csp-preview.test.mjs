import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCsp, resolveFile } from './csp-preview.mjs';

test('the policy allows the editor engine and nothing remote', () => {
  const csp = readCsp();
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /worker-src 'self'/);
  assert.doesNotMatch(csp, /https?:\/\/(?!ipc\.localhost)/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
});

test('serves files of dist only, the app for everything else', () => {
  const dist = mkdtempSync(join(tmpdir(), 'sc-dist-'));
  mkdirSync(join(dist, 'editlicious'));
  writeFileSync(join(dist, 'index.html'), '');
  writeFileSync(join(dist, 'editlicious', 'ed_wasm_bg.wasm'), '');
  assert.equal(
    resolveFile(dist, '/editlicious/ed_wasm_bg.wasm'),
    join(dist, 'editlicious', 'ed_wasm_bg.wasm'),
  );
  assert.equal(resolveFile(dist, '/'), join(dist, 'index.html'));
  assert.equal(resolveFile(dist, '/nope.js'), join(dist, 'index.html'));
  assert.equal(resolveFile(dist, '/../../etc/passwd'), join(dist, 'index.html'));
});
