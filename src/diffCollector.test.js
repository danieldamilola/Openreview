'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseUnifiedDiff,
  chunkFiles,
  buildChangedLineIndex,
  matchesIgnore,
  collectDiff,
} = require('./diffCollector');

const SAMPLE = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,3 +1,4 @@',
  ' context',
  '-old',
  '+new1',
  '+new2',
  ' more',
  'diff --git a/src/b.js b/src/b.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/b.js',
  '@@ -0,0 +1,2 @@',
  '+x',
  '+y',
].join('\n');

describe('diffCollector', () => {
  it('parses files and hunks with line numbers', () => {
    const r = parseUnifiedDiff(SAMPLE);
    assert.equal(r.files.length, 2);
    assert.equal(r.empty, false);
    assert.equal(r.files[0].file, 'src/a.js');
    assert.equal(r.files[1].status, 'added');
    const adds = r.files[0].hunks[0].lines.filter((l) => l.type === 'add');
    assert.deepEqual(adds.map((l) => l.newLine), [2, 3]);
    assert.equal(r.stats.additions, 4);
    assert.equal(r.stats.deletions, 1);
  });

  it('handles empty diffs', () => {
    const r = parseUnifiedDiff('');
    assert.equal(r.empty, true);
    assert.deepEqual(r.files, []);
    assert.deepEqual(chunkFiles(r), []);
  });

  it('applies ignore patterns', () => {
    const r = parseUnifiedDiff(SAMPLE, { ignorePatterns: ['src/b.js'] });
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].file, 'src/a.js');
    assert.deepEqual(r.stats.skippedIgnored, ['src/b.js']);
  });

  it('matches directory prefixes and globs', () => {
    assert.equal(matchesIgnore('dist/bundle.js', ['dist/']), true);
    assert.equal(matchesIgnore('a.lock', ['*.lock']), true);
    assert.equal(matchesIgnore('x/a.lock', ['*.lock']), false); // * does not cross /
    assert.equal(matchesIgnore('x/a.lock', ['**/*.lock']), true);
    assert.equal(matchesIgnore('a.lock', ['**/*.lock']), true); // **/ matches zero dirs too
    assert.equal(matchesIgnore('src/a.js', ['**/*.js']), true);
  });

  it('truncates oversized diffs with flags', () => {
    const r = parseUnifiedDiff(SAMPLE, { limits: { maxFiles: 1, maxTotalChars: 10 } });
    assert.equal(r.truncated, true);
    assert.equal(r.files.length, 1);
  });

  it('builds changed-line index for anchoring', () => {
    const r = parseUnifiedDiff(SAMPLE);
    const idx = buildChangedLineIndex(r);
    assert.deepEqual([...idx.get('src/a.js')].sort((a, b) => a - b), [2, 3]);
    assert.deepEqual([...idx.get('src/b.js')], [1, 2]);
  });

  it('collectDiff prefers three-dot range then falls back', () => {
    const calls = [];
    const r = collectDiff({
      base: 'aaa',
      head: 'bbb',
      gitRunner: (args) => {
        calls.push(args);
        if (args[1] === 'aaa...bbb') throw new Error('no merge base');
        return SAMPLE;
      },
    });
    assert.equal(calls[0][1], 'aaa...bbb');
    assert.equal(r.files.length, 2);
  });

  it('requires base and head', () => {
    assert.throws(() => collectDiff({ base: '', head: 'x' }), /base and head/);
  });
});
