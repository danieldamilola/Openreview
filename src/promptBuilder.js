'use strict';

/**
 * Review prompt builder: renders structured per-file hunks into an LLM
 * prompt that demands strict JSON findings.
 *
 * Finding schema (v1):
 *   { file: string, line: number, severity: "critical"|"major"|"minor",
 *     message: string, suggestion?: string, rule?: string }
 */

const SEVERITIES = ['critical', 'major', 'minor'];

const FINDING_JSON_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'severity', 'message'],
        properties: {
          file: { type: 'string', description: 'Repo-relative path, must match a reviewed file' },
          line: { type: 'integer', description: 'New-side line number; must be an added (+) line' },
          severity: { type: 'string', enum: SEVERITIES },
          message: { type: 'string', description: 'Concise problem statement' },
          suggestion: { type: 'string', description: 'Concrete fix or code snippet (optional)' },
          rule: { type: 'string', description: 'Short rule/category tag (optional)' },
        },
      },
    },
  },
  required: ['findings'],
};

const SYSTEM_PROMPT = [
  'You are an expert code reviewer (CodeRabbit-style).',
  'Review ONLY the changed lines marked with "+". Context lines (" ") are for understanding; never flag them.',
  'Every finding MUST anchor to a file and new-side line number that appears as an added ("+") line in the diff.',
  'If a file has no issues, return {"findings": []} for it. Never invent files, lines, or issues.',
  'Severity labels (use exactly one):',
  '- critical: bug, security hole, data loss, crash (must fix before merge)',
  '- major: correctness risk, likely bug, bad API/error handling (should fix)',
  '- minor: maintainability, performance smell, unclear code (consider fixing)',
  'Do NOT report style nits, typos, formatting, or naming preferences.',
  'Only report substantive issues: bugs, security holes, crashes, data loss,',
  'correctness risks, bad error handling, and real maintainability problems.',
  'Output STRICT JSON only: {"findings":[{file,line,severity,message,suggestion?,rule?}]}.',
  'No markdown fences, no prose, no extra keys.',
].join('\n');

function renderFileHunk(file) {
  const out = [];
  out.push(`--- FILE: ${file.file} [${file.status}]${file.truncated ? ' (TRUNCATED)' : ''}`);
  if (!file.hunks || file.hunks.length === 0) {
    out.push('(no hunks)');
    return out.join('\n');
  }
  for (const h of file.hunks) {
    out.push(
      `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.truncated ? ' (TRUNCATED)' : ''}`
    );
    for (const l of h.lines) {
      const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      const tag =
        l.type === 'add'
          ? `N${l.newLine}`
          : l.type === 'del'
            ? `O${l.oldLine}`
            : `O${l.oldLine}/N${l.newLine}`;
      out.push(`${prefix} ${String(tag).padEnd(10)} ${l.content}`);
    }
  }
  return out.join('\n');
}

/**
 * Build system + user prompts for one chunk (list of parsed files).
 * @param {Array} fileChunk parsed files from diffCollector
 * @param {object} [options] { focus?, language?, extraRules? }
 */
function buildReviewPrompt(fileChunk, options = {}) {
  const files = Array.isArray(fileChunk) ? fileChunk : [];
  const focus = options.focus || 'Correctness, security, error handling, and maintainability.';
  const extra = options.extraRules ? `\nExtra repo rules:\n${options.extraRules}` : '';
  const userPrompt = [
    `Review the following ${files.length} changed file(s). Focus: ${focus}${extra}`,
    'Changed lines are prefixed with "+ N<line>". Only report findings on those lines.',
    'Return STRICT JSON matching {"findings":[{file,line,severity,message,suggestion?,rule?}]}.',
    '',
    ...files.map(renderFileHunk),
  ].join('\n');

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    schema: FINDING_JSON_SCHEMA,
    severities: [...SEVERITIES],
  };
}

function isValidSeverity(s) {
  return SEVERITIES.includes(s);
}

// Severity rank: lower index = more severe. Used for threshold filtering.
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2 };

function normalizeThreshold(threshold) {
  const t = String(threshold || 'minor').toLowerCase();
  return SEVERITIES.includes(t) ? t : 'minor';
}

function meetsThreshold(severity, threshold) {
  return (SEVERITY_RANK[severity] ?? 99) <= (SEVERITY_RANK[normalizeThreshold(threshold)] ?? 2);
}

// Split findings into those at/above the threshold and those below it.
// Anything with an unknown severity is treated as below threshold.
function filterByThreshold(findings, threshold) {
  const kept = [];
  const suppressed = [];
  for (const f of findings || []) {
    if (meetsThreshold(f && f.severity, threshold)) kept.push(f);
    else suppressed.push({ finding: f, reason: 'below-threshold' });
  }
  return { kept, suppressed };
}

/**
 * Validate raw findings (shape + enum). Returns { valid, invalid }.
 * Line-anchor checking against the diff needs buildChangedLineIndex and is
 * done by filterFindingsToDiff() so prompt tests stay hermetic.
 */
function validateFindings(findings) {
  const valid = [];
  const invalid = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    const ok =
      f &&
      typeof f.file === 'string' &&
      f.file.length > 0 &&
      Number.isInteger(f.line) &&
      f.line > 0 &&
      isValidSeverity(f.severity) &&
      typeof f.message === 'string' &&
      f.message.trim().length > 0 &&
      (f.suggestion === undefined || typeof f.suggestion === 'string') &&
      (f.rule === undefined || typeof f.rule === 'string');
    if (ok) valid.push(f);
    else invalid.push(f);
  }
  return { valid, invalid };
}

/**
 * Keep only findings anchored to added (+) lines in the diff.
 * Unknown files and off-diff lines are dropped and reported.
 */
function filterFindingsToDiff(findings, changedIndex) {
  const kept = [];
  const dropped = [];
  for (const f of findings || []) {
    const set = changedIndex instanceof Map ? changedIndex.get(f.file) : undefined;
    if (!set) {
      dropped.push({ finding: f, reason: 'unknown-file' });
      continue;
    }
    if (!set.has(f.line)) {
      dropped.push({ finding: f, reason: 'line-not-in-diff' });
      continue;
    }
    kept.push(f);
  }
  return { kept, dropped };
}

module.exports = {
  SEVERITIES,
  SEVERITY_RANK,
  FINDING_JSON_SCHEMA,
  SYSTEM_PROMPT,
  buildReviewPrompt,
  renderFileHunk,
  validateFindings,
  filterFindingsToDiff,
  normalizeThreshold,
  meetsThreshold,
  filterByThreshold,
};
