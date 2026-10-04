'use strict';

/**
 * Output formatter: GitHub markdown summary + inline comment payloads.
 *
 * - formatSummary(): human-readable markdown for the PR (posted as a review
 *   body or step summary). Includes counts by severity, per-file sections,
 *   and truncation/empty notices.
 * - formatInlineComments(): GitHub Pull Request review comments
 *   ({ path, line, side, body }) anchored to new-side (+) lines only.
 * - formatReviewPayload(): full create-a-review payload
 *   ({ body, event, comments }).
 */

const { SEVERITIES } = require('./promptBuilder');

const SEVERITY_EMOJI = {
  critical: ':rotating_light:',
  major: ':warning:',
  minor: ':information_source:',
};

const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2 };

function sortFindings(findings) {
  return [...(findings || [])].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 99;
    const sb = SEVERITY_ORDER[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    if (a.file !== b.file) return String(a.file).localeCompare(String(b.file));
    return (a.line || 0) - (b.line || 0);
  });
}

function countBySeverity(findings) {
  const counts = { critical: 0, major: 0, minor: 0 };
  for (const f of findings || []) {
    if (f.severity in counts) counts[f.severity] += 1;
  }
  return counts;
}

function findingBody(f) {
  const emoji = SEVERITY_EMOJI[f.severity] || '';
  const head = `${emoji} **${f.severity}** ${f.rule ? `(\`${f.rule}\`)` : ''}`.trim();
  let body = `${head}\n\n${f.message}`;
  if (f.suggestion) {
    const looksLikeCode = /[{};`]/.test(f.suggestion) || f.suggestion.includes('\n');
    body += looksLikeCode
      ? `\n\n**Suggestion:**\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``
      : `\n\n**Suggestion:** ${f.suggestion}`;
  }
  return body;
}

/**
 * Render the markdown summary posted on the PR.
 */
function formatSummary({ findings = [], stats = {}, config = {}, dropped = [], suppressed = [] } = {}) {
  const counts = countBySeverity(findings);
  const total = findings.length;
  const lines = [];
  lines.push('## Code Review');
  lines.push('');
  if (total === 0) {
    lines.push('No issues found on the changed lines. :white_check_mark:');
  } else {
    lines.push(
      `Found **${total}** issue(s): ` +
        SEVERITIES.map((s) => `${SEVERITY_EMOJI[s]} ${counts[s]} ${s}`).join(' · ')
    );
  }
  lines.push('');
  if (stats && (stats.files != null || stats.additions != null)) {
    const parts = [];
    if (stats.files != null) parts.push(`${stats.files} file(s)`);
    if (stats.additions != null) parts.push(`+${stats.additions}`);
    if (stats.deletions != null) parts.push(`-${stats.deletions}`);
    if (parts.length) lines.push(`_Scope: ${parts.join(' / ')}_` + (stats.truncated ? ' _(diff truncated to fit limits)_' : ''));
  }
  if (config && config.model) lines.push(`_Model: \`${config.model}\`_`);
  lines.push('');

  const sorted = sortFindings(findings);
  let lastFile = null;
  for (const f of sorted) {
    if (f.file !== lastFile) {
      lines.push(`### \`${f.file}\``);
      lastFile = f.file;
    }
    const emoji = SEVERITY_EMOJI[f.severity] || '';
    lines.push(`- ${emoji} **${f.severity}** — L${f.line}: ${oneLine(f.message)}`);
    if (f.suggestion) lines.push(`  - Suggestion: ${oneLine(f.suggestion).slice(0, 300)}`);
  }
  if (sorted.length) lines.push('');
  if (dropped && dropped.length) {
    lines.push(`_${dropped.length} finding(s) dropped (not anchored to changed lines)._`);
    lines.push('');
  }
  if (suppressed && suppressed.length) {
    lines.push(`_${suppressed.length} finding(s) hidden by severity threshold / comment cap._`);
    lines.push('');
  }
  lines.push('_Findings anchor to added (+) lines only. Review is incremental when `base` is the last-reviewed head._');
  return lines.join('\n');
}

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Build GitHub review comments (new-side only). Every comment uses
 * side: "RIGHT" semantics via { path, line } for the head commit.
 */
function formatInlineComments(findings = []) {
  return sortFindings(findings).map((f) => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT',
    body: findingBody(f),
  }));
}

/**
 * Full payload for "Create a review for a pull request".
 * event: APPROVE | REQUEST_CHANGES | COMMENT (default COMMENT).
 */
function formatReviewPayload({ findings = [], summary, event = 'COMMENT', commitId } = {}) {
  const body = summary != null ? summary : formatSummary({ findings });
  const comments = formatInlineComments(findings);
  const payload = { body, event, comments };
  if (commitId) payload.commit_id = commitId;
  return payload;
}

module.exports = {
  SEVERITY_EMOJI,
  sortFindings,
  countBySeverity,
  formatSummary,
  formatInlineComments,
  formatReviewPayload,
};
