'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseRulesYaml,
  validateRule,
  scanDiff,
  dedupeAgainstRules,
} = require('./rulesEngine');
const { parseUnifiedDiff } = require('./diffCollector');

const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,2 +1,3 @@',
  ' ctx',
  '+const x = eval(userInput);',
  '+console.log("left over");',
  'diff --git a/old.py b/old.py',
  '--- a/old.py',
  '+++ b/old.py',
  '@@ -1 +1,2 @@',
  ' y = 1',
  '+z = exec(payload)',
].join('\n');

const YAML = [
  '# a comment line',
  'rules:',
  '  - id: no-eval',
  '    severity: critical',
  '    files: ["**/*.js"]',
  '    pattern: "\\\\beval\\\\s*\\\\("',
  '    message: "Avoid eval."',
  '    suggestion: "Refactor it."',
  '  - id: no-console',
  '    description: single quotes work too',
  "    severity: 'minor'",
  '    files:',
  '      - "**/*.js"',
  '      - "**/*.ts"',
  '    pattern: \'console\\.log\\s*\\(\'',
  '    message: "Remove console.log."',
].join('\n');

function validRules() {
  const raw = parseRulesYaml(YAML, 'test.yml');
  const seen = new Set();
  return raw.map((r) => validateRule(r, seen).rule);
}

describe('rulesEngine', () => {
  it('parses inline and block lists, quotes, and comments', () => {
    const raw = parseRulesYaml(YAML, 'test.yml');
    assert.equal(raw.length, 2);
    assert.equal(raw[0].id, 'no-eval');
    assert.deepEqual(raw[0].files, ['**/*.js']);
    assert.deepEqual(raw[1].files, ['**/*.js', '**/*.ts']);
    assert.equal(raw[1].description, 'single quotes work too');
  });

  it('unescapes double-quoted regex patterns', () => {
    const [rule] = validRules();
    assert.equal(rule.pattern, '\\beval\\s*\\(');
    assert.equal(rule._re.test('eval(x)'), true);
  });

  it('rejects bad rules: missing id, bad severity, bad regex', () => {
    const seen = new Set();
    assert.match(validateRule({ severity: 'major', pattern: 'x', message: 'm' }, seen).error, /missing required "id"/);
    assert.match(validateRule({ id: 'a', severity: 'nit', pattern: 'x', message: 'm' }, seen).error, /severity must be/);
    assert.match(validateRule({ id: 'b', severity: 'major', pattern: '([', message: 'm' }, seen).error, /invalid regex/);
    assert.match(validateRule({ id: 'c', severity: 'major', pattern: 'x' }, seen).error, /missing required "message"/);
    validateRule({ id: 'dup', severity: 'major', pattern: 'x', message: 'm' }, seen);
    assert.match(validateRule({ id: 'dup', severity: 'major', pattern: 'x', message: 'm' }, seen).error, /duplicate/);
  });

  it('rejects malformed yaml outside the rules list', () => {
    assert.throws(() => parseRulesYaml('nope: 1\n', 'bad.yml'), /expected "rules:" list/);
  });

  it('scans only added lines in matching files', () => {
    const findings = scanDiff(parseUnifiedDiff(DIFF), validRules());
    assert.equal(findings.length, 2);
    const byId = Object.fromEntries(findings.map((f) => [f.rule, f]));
    assert.equal(byId['no-eval'].file, 'src/a.js');
    assert.equal(byId['no-eval'].line, 2);
    assert.equal(byId['no-eval'].severity, 'critical');
    assert.equal(byId['no-console'].line, 3);
    // old.py has exec() but no rule targets python files here.
    assert.ok(!findings.some((f) => f.file === 'old.py'));
  });

  it('matches all files when "files" is omitted and skips deleted files', () => {
    const seen = new Set();
    const { rule } = validateRule(
      { id: 'any', severity: 'major', pattern: 'SECRET', message: 'm' },
      seen
    );
    const diff = [
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-SECRET gone',
      'diff --git a/new.txt b/new.txt',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+has SECRET here',
    ].join('\n');
    const findings = scanDiff(parseUnifiedDiff(diff), [rule]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'new.txt');
  });

  it('prefers rule hits over LLM findings on the same line', () => {
    const ruleHit = { file: 'a.js', line: 1, severity: 'critical', message: 'rule' };
    const { kept, duplicates } = dedupeAgainstRules(
      [
        { file: 'a.js', line: 1, severity: 'major', message: 'llm dup' },
        { file: 'a.js', line: 2, severity: 'minor', message: 'llm unique' },
      ],
      [ruleHit]
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].line, 2);
    assert.equal(duplicates.length, 1);
  });
});
