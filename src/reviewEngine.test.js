'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseUnifiedDiff } = require('./diffCollector');
const { runReview } = require('./reviewEngine');

const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,2 +1,3 @@',
  ' ctx',
  '+risky()',
  '+safe()',
].join('\n');

function stubProvider(findings) {
  return {
    review: async () => ({ rawText: JSON.stringify({ findings }), findings }),
  };
}

describe('reviewEngine', () => {
  it('keeps only anchored findings and formats outputs', async () => {
    const diffResult = parseUnifiedDiff(DIFF);
    const res = await runReview({
      diffResult,
      provider: stubProvider([
        { file: 'src/a.js', line: 2, severity: 'major', message: 'needs check' },
        { file: 'src/a.js', line: 1, severity: 'minor', message: 'context, drop me' },
        { file: 'x.js', line: 9, severity: 'minor', message: 'unknown file' },
        { file: 'src/a.js', line: 3, severity: 'bogus', message: 'invalid' },
      ]),
      promptOptions: {},
    });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].line, 2);
    assert.equal(res.dropped.length, 2);
    assert.equal(res.suppressed.length, 0);
    assert.equal(res.invalid.length, 1);
    assert.equal(res.empty, false);
    assert.match(res.summary, /## Code Review/);
    assert.equal(res.payload.comments.length, 1);
    assert.equal(res.payload.comments[0].side, 'RIGHT');
  });

  it('hides findings below the severity threshold', async () => {
    const diffResult = parseUnifiedDiff(DIFF);
    const res = await runReview({
      diffResult,
      provider: stubProvider([
        { file: 'src/a.js', line: 2, severity: 'major', message: 'needs check' },
        { file: 'src/a.js', line: 3, severity: 'minor', message: 'smell' },
      ]),
      promptOptions: { severityThreshold: 'major' },
    });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].severity, 'major');
    assert.equal(res.suppressed.length, 1);
    assert.equal(res.suppressed[0].reason, 'below-threshold');
    assert.match(res.summary, /hidden by severity threshold/);
    assert.equal(res.payload.comments.length, 1);
  });

  it('caps inline comments at maxComments, most severe first', async () => {
    const diffResult = parseUnifiedDiff(DIFF);
    const res = await runReview({
      diffResult,
      provider: stubProvider([
        { file: 'src/a.js', line: 2, severity: 'minor', message: 'smell' },
        { file: 'src/a.js', line: 3, severity: 'critical', message: 'injection' },
      ]),
      promptOptions: { maxComments: 1 },
    });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].severity, 'critical');
    assert.equal(res.suppressed.length, 1);
    assert.equal(res.suppressed[0].reason, 'over-max-comments');
    assert.equal(res.payload.comments.length, 1);
  });

  it('handles empty diffs with a clean summary', async () => {
    const diffResult = parseUnifiedDiff('');
    let called = false;
    const res = await runReview({
      diffResult,
      provider: { review: async () => { called = true; return { findings: [] }; } },
    });
    assert.equal(called, false);
    assert.equal(res.empty, true);
    assert.match(res.summary, /No issues found/);
  });

  it('merges deterministic rule hits and drops LLM duplicates', async () => {
    const diffResult = parseUnifiedDiff(DIFF);
    const res = await runReview({
      diffResult,
      provider: stubProvider([
        { file: 'src/a.js', line: 2, severity: 'major', message: 'llm also saw it' },
      ]),
      promptOptions: {
        rules: {
          enabled: true,
          rules: [
            {
              id: 'no-risky',
              severity: 'critical',
              files: ['src/*.js'],
              pattern: 'risky\\(\\)',
              flags: '',
              message: 'risky() is dangerous',
              _re: /risky\(\)/,
            },
          ],
        },
      },
    });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].rule, 'no-risky');
    assert.equal(res.findings[0].severity, 'critical');
    assert.equal(res.dropped.length, 1);
    assert.equal(res.dropped[0].reason, 'duplicate-of-rule');
    assert.deepEqual(res.ruleErrors, []);
  });

  it('loads real sample rules from the rules/ directory', async () => {
    const path = require('node:path');
    const diffResult = parseUnifiedDiff(DIFF);
    const res = await runReview({
      diffResult,
      provider: stubProvider([]),
      promptOptions: {
        rules: { enabled: true, cwd: path.join(__dirname, '..'), dir: 'rules' },
      },
    });
    // DIFF has no eval/console/secrets, so zero hits and zero load errors.
    assert.equal(res.findings.length, 0);
    assert.deepEqual(res.ruleErrors, []);
  });
});
