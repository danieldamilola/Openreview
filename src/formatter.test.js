'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatSummary,
  formatInlineComments,
  formatReviewPayload,
  countBySeverity,
} = require('./formatter');

const FINDINGS = [
  { file: 'b.js', line: 5, severity: 'minor', message: 'unclear naming' },
  { file: 'a.js', line: 2, severity: 'critical', message: 'sql injection', suggestion: 'use params' },
  { file: 'a.js', line: 3, severity: 'major', message: 'no error handling' },
];

describe('formatter', () => {
  it('counts severities and renders markdown summary', () => {
    assert.deepEqual(countBySeverity(FINDINGS), { critical: 1, major: 1, minor: 1 });
    const md = formatSummary({ findings: FINDINGS, stats: { files: 2, additions: 10, deletions: 1 } });
    assert.match(md, /## Code Review/);
    assert.match(md, /Found \*\*3\*\* issue/);
    assert.match(md, /`a\.js`/);
    assert.match(md, /critical/);
  });

  it('renders empty state for clean diffs', () => {
    const md = formatSummary({ findings: [] });
    assert.match(md, /No issues found/);
  });

  it('emits RIGHT-side inline comments sorted by severity', () => {
    const comments = formatInlineComments(FINDINGS);
    assert.equal(comments.length, 3);
    assert.equal(comments[0].path, 'a.js'); // critical first
    assert.equal(comments[0].side, 'RIGHT');
    assert.match(comments[0].body, /critical/);
  });

  it('builds a full review payload', () => {
    const p = formatReviewPayload({ findings: FINDINGS, event: 'COMMENT', commitId: 'abc' });
    assert.equal(p.event, 'COMMENT');
    assert.equal(p.commit_id, 'abc');
    assert.equal(p.comments.length, 3);
    assert.match(p.body, /## Code Review/);
  });
});
