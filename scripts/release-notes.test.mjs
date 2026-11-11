import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommit, renderNotes } from './release-notes.mjs';

test('parses conventional headers', () => {
  assert.deepEqual(parseCommit('feat(017): app icon'), {
    type: 'feat',
    rawType: 'feat',
    scope: '017',
    subject: 'app icon',
    breaking: false,
  });
  assert.equal(parseCommit('fix!: drop old session format').breaking, true);
  assert.equal(parseCommit('refactor: x', 'BREAKING CHANGE: y').breaking, true);
  assert.equal(parseCommit('Merge whatever').type, 'other');
});

test('groups, hides chores and tests', () => {
  const md = renderNotes(
    [
      { hash: 'aaaaaaaaaa', subject: 'feat(ops): copy dialog' },
      { hash: 'bbbbbbbbbb', subject: 'fix: crash on empty dir' },
      { hash: 'cccccccccc', subject: 'chore: bump deps' },
      { hash: 'dddddddddd', subject: 'test: more cases' },
      { hash: 'eeeeeeeeee', subject: 'feat!: new config file' },
    ],
    'v0.2.0',
  );
  assert.match(md, /^## v0\.2\.0/);
  assert.match(md, /### Breaking changes\n\n- new config file \(eeeeeee\)/);
  assert.match(md, /### Features\n\n- \*\*ops:\*\* copy dialog \(aaaaaaa\)\n- new config file/);
  assert.match(md, /### Bug fixes\n\n- crash on empty dir/);
  assert.doesNotMatch(md, /bump deps|more cases/);
});

test('empty range', () => {
  assert.match(renderNotes([]), /No user-facing changes/);
});
