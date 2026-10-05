'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRepository } = require('./index');

test('uses dispatched review repository instead of the workflow repository', () => {
  assert.equal(
    resolveRepository({
      REVIEW_REPOSITORY: 'danieldamilola/Stride',
      GITHUB_REPOSITORY: 'danieldamilola/Openreview',
    }),
    'danieldamilola/Stride',
  );
});

test('falls back to GITHUB_REPOSITORY for a repo-local workflow', () => {
  assert.equal(resolveRepository({ GITHUB_REPOSITORY: 'danieldamilola/Openreview' }), 'danieldamilola/Openreview');
});
