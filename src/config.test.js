'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./config');

describe('config', () => {
  it('selects model via input/config with env fallback', () => {
    const c = loadConfig({ model: 'opencode:foo' }, {});
    assert.equal(c.model, 'opencode:foo');
    const d = loadConfig({}, { REVIEW_MODEL: 'gpt-4o', INPUT_PROVIDER: 'openai-compatible' });
    assert.equal(d.model, 'gpt-4o');
    assert.equal(d.provider, 'openai-compatible');
  });

  it('parses ignore patterns and limits', () => {
    const c = loadConfig({ 'ignore-patterns': 'a,b', 'max-files': '5' }, {});
    assert.deepEqual(c.ignorePatterns, ['a', 'b']);
    assert.equal(c.limits.maxFiles, 5);
  });

  it('parses severity threshold and comment cap with safe defaults', () => {
    const d = loadConfig({}, {});
    assert.equal(d.severityThreshold, 'minor');
    assert.equal(d.maxComments, 15);
    const c = loadConfig({ 'severity-threshold': 'major', 'max-comments': '3' }, {});
    assert.equal(c.severityThreshold, 'major');
    assert.equal(c.maxComments, 3);
    const bad = loadConfig({}, { REVIEW_SEVERITY_THRESHOLD: 'nit', REVIEW_MAX_COMMENTS: 'x' });
    assert.equal(bad.severityThreshold, 'minor');
    assert.equal(bad.maxComments, 15);
  });
});
