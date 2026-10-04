'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractReviewedSha,
  readStateArtifact,
  getLastReviewedSha,
  planDiff,
} = require('../incremental');
const { reviewedStateMarker } = require('../post-review');

test('extractReviewedSha reads the hidden marker', () => {
  const body = `verdict\n${reviewedStateMarker('1234567890abcdef')}`;
  assert.strictEqual(extractReviewedSha(body), '1234567890abcdef');
  assert.strictEqual(extractReviewedSha('nothing'), null);
});

test('planDiff picks incremental range when prior head is an ancestor', () => {
  const plan = planDiff({
    baseSha: 'base',
    headSha: 'head',
    lastReviewedSha: 'prev',
    ancestorCheck: (a, b) => a === 'prev' && b === 'head',
  });
  assert.deepStrictEqual(plan, { base: 'prev', head: 'head', mode: 'incremental', skip: false });
});

test('planDiff falls back to full range after a rebase', () => {
  const plan = planDiff({
    baseSha: 'base',
    headSha: 'head',
    lastReviewedSha: 'prev',
    ancestorCheck: () => false,
  });
  assert.strictEqual(plan.mode, 'full-rebase');
  assert.strictEqual(plan.base, 'base');
});

test('planDiff skips when head is unchanged, force overrides', () => {
  const same = planDiff({ baseSha: 'b', headSha: 'h', lastReviewedSha: 'h' });
  assert.strictEqual(same.skip, true);
  assert.strictEqual(same.mode, 'up-to-date');
  const forced = planDiff({ baseSha: 'b', headSha: 'h', lastReviewedSha: 'h', force: true });
  assert.strictEqual(forced.mode, 'full');
  assert.strictEqual(forced.skip, false);
});

test('getLastReviewedSha prefers the state artifact over the API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-state-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ reviewedSha: 'artifact-sha' }));
  const sha = await getLastReviewedSha({
    token: 't',
    repo: 'o/r',
    prNumber: 1,
    stateFile: file,
    fetchImpl: async () => {
      throw new Error('API must not be called when an artifact exists');
    },
  });
  assert.strictEqual(sha, 'artifact-sha');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readStateArtifact handles plain-text and missing files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-state-'));
  const file = path.join(dir, 'sha.txt');
  fs.writeFileSync(file, 'plaintext-sha\n');
  assert.strictEqual(readStateArtifact(file), 'plaintext-sha');
  assert.strictEqual(readStateArtifact(path.join(dir, 'missing')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
