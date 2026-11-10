import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cargoLockVersion,
  cargoTomlVersion,
  checkVersions,
  isSemver,
  readAll,
  setCargoLockVersion,
  setCargoTomlVersion,
} from './version.mjs';

const TOML = `[package]
name = "schema-commander"
version = "0.1.0"

[dependencies]
serde = { version = "1.0" }
foo = "2"
`;
const LOCK = `[[package]]
name = "foo"
version = "2.0.0"

[[package]]
name = "schema-commander"
version = "0.1.0"
dependencies = []
`;

test('the repository is consistent', () => {
  assert.deepEqual(checkVersions(readAll()), []);
});

test('semver', () => {
  assert.ok(isSemver('1.2.3'));
  assert.ok(isSemver('1.2.3-beta.1'));
  assert.ok(!isSemver('1.2'));
  assert.ok(!isSemver('v1.2.3'));
});

test('Cargo.toml: reads and writes only the package version', () => {
  assert.equal(cargoTomlVersion(TOML), '0.1.0');
  const next = setCargoTomlVersion(TOML, '0.2.0');
  assert.equal(cargoTomlVersion(next), '0.2.0');
  assert.match(next, /serde = \{ version = "1.0" \}/);
});

test('Cargo.lock: only our crate', () => {
  assert.equal(cargoLockVersion(LOCK), '0.1.0');
  const next = setCargoLockVersion(LOCK, '0.2.0');
  assert.equal(cargoLockVersion(next), '0.2.0');
  assert.equal(cargoLockVersion(next, 'foo'), '2.0.0');
});

test('mismatches are reported per file', () => {
  const problems = checkVersions({
    pkg: { version: '0.2.0' },
    tauriConf: { version: '0.1.0' },
    cargoToml: TOML,
    cargoLock: LOCK,
  });
  assert.equal(problems.length, 3);
  assert.deepEqual(
    checkVersions({
      pkg: { version: '0.1.0' },
      tauriConf: { version: '../package.json' },
      cargoToml: TOML,
      cargoLock: LOCK,
    }),
    [],
  );
});
