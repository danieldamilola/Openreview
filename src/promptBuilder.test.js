'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReviewPrompt,
  validateFindings,
  filterFindingsToDiff,
  meetsThreshold,
  normalizeThreshold,
  filterByThreshold,
  SEVERITIES,
} = require('./promptBuilder');
const { parseUnifiedDiff, buildChangedLineIndex } = require('./diffCollector');

const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,2 +1,3 @@',
  ' ctx',
  '+new1',
  '+new2',
].join('\n');

describe('promptBuilder', () => {
  it('exposes severity labels and JSON schema', () => {
    assert.deepEqual(SEVERITIES, ['critical', 'major', 'minor']);
    const { schema } = buildReviewPrompt([]);
    assert.deepEqual(schema.properties.findings.type, 'array');
  });

  it('renders changed lines with new-side numbers', () => {
    const r = parseUnifiedDiff(DIFF);
    const { systemPrompt, userPrompt } = buildReviewPrompt(r.files);
    assert.match(systemPrompt, /ONLY the changed lines/);
    assert.match(systemPrompt, /STRICT JSON/);
    assert.match(userPrompt, /src\/a\.js/);
    assert.match(userPrompt, /\+ N2/);
  });

  it('validates finding shapes and severities', () => {
    const good = { file: 'src/a.js', line: 2, severity: 'major', message: 'bug' };
    const badSeverity = { ...good, severity: 'nope' };
    const badLine = { ...good, line: 0 };
    const { valid, invalid } = validateFindings([good, badSeverity, badLine, null]);
    assert.equal(valid.length, 1);
    assert.equal(invalid.length, 3);
  });

  it('rejects nit severity and filters by threshold', () => {
    const nit = { file: 'src/a.js', line: 2, severity: 'nit', message: 'typo' };
    const { valid, invalid } = validateFindings([nit]);
    assert.equal(valid.length, 0);
    assert.equal(invalid.length, 1);
    assert.equal(meetsThreshold('critical', 'major'), true);
    assert.equal(meetsThreshold('minor', 'major'), false);
    assert.equal(meetsThreshold('minor', 'minor'), true);
    assert.equal(normalizeThreshold('bogus'), 'minor');
    const { kept, suppressed } = filterByThreshold(
      [
        { file: 'a.js', line: 1, severity: 'major', message: 'm' },
        { file: 'a.js', line: 2, severity: 'minor', message: 'm' },
      ],
      'major'
    );
    assert.equal(kept.length, 1);
    assert.equal(suppressed.length, 1);
    assert.equal(suppressed[0].reason, 'below-threshold');
  });

  it('filters findings to changed lines only', () => {
    const r = parseUnifiedDiff(DIFF);
    const idx = buildChangedLineIndex(r);
    const findings = [
      { file: 'src/a.js', line: 2, severity: 'minor', message: 'ok' },
      { file: 'src/a.js', line: 1, severity: 'minor', message: 'context line!' },
      { file: 'nope.js', line: 1, severity: 'minor', message: 'unknown file' },
    ];
    const { kept, dropped } = filterFindingsToDiff(findings, idx);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 2);
    assert.deepEqual(dropped.map((d) => d.reason).sort(), ['line-not-in-diff', 'unknown-file']);
  });
});
