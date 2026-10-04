'use strict';

/**
 * Review engine: orchestrates diff -> chunk -> prompt -> provider ->
 * validate -> anchor-filter -> format.
 *
 * Language choice: Node.js (plain JavaScript, CommonJS, zero npm
 * dependencies). Rationale: GitHub Actions ships Node 20+ so the action
 * runs without a build step or `npm install`; global `fetch` covers the
 * OpenAI-compatible provider and `node:child_process` covers `git` and the
 * `opencode` CLI. Tests run with the stdlib runner (`node --test`).
 *
 * Trigger model (CodeRabbit-style, wired in the example workflow):
 * - pull_request opened / synchronize: review full PR diff (base...head)
 *   or incremental diff (priorHead...head) when the previous reviewed SHA
 *   is known; only new commits are sent on synchronize where feasible.
 */

const {
  buildChangedLineIndex,
  chunkFiles,
} = require('./diffCollector');
const {
  buildReviewPrompt,
  validateFindings,
  filterFindingsToDiff,
  filterByThreshold,
  normalizeThreshold,
} = require('./promptBuilder');
const { formatSummary, formatReviewPayload, sortFindings } = require('./formatter');
const { loadRules, scanDiff, dedupeAgainstRules } = require('./rulesEngine');

async function runReview({ diffResult, provider, promptOptions = {}, event = 'COMMENT', commitId } = {}) {
  if (!diffResult) throw new Error('runReview requires diffResult');
  if (!provider || typeof provider.review !== 'function') throw new Error('runReview requires a provider');

  if (!diffResult.files || diffResult.files.length === 0) {
    const summary = formatSummary({
      findings: [],
      stats: { ...(diffResult.stats || {}), truncated: diffResult.truncated },
      config: promptOptions.config,
    });
    return {
      findings: [],
      dropped: [],
      suppressed: [],
      invalid: [],
      ruleErrors: [],
      chunks: 0,
      summary,
      payload: formatReviewPayload({ findings: [], summary, event, commitId }),
      truncated: Boolean(diffResult.truncated),
      empty: true,
    };
  }

  // Deterministic rules first: exact pattern hits at zero API cost.
  const rulesOpt = promptOptions.rules || {};
  let ruleFindings = [];
  let ruleErrors = [];
  if (rulesOpt.enabled !== false) {
    const loaded = Array.isArray(rulesOpt.rules)
      ? { rules: rulesOpt.rules, errors: [] }
      : loadRules(rulesOpt.dir || 'rules', rulesOpt.cwd || process.env.GITHUB_WORKSPACE || process.cwd());
    ruleErrors = loaded.errors;
    ruleFindings = scanDiff(diffResult, loaded.rules);
  }

  const chunks = chunkFiles(diffResult, { limits: promptOptions.limits });
  const allValid = [];
  const allInvalid = [];
  for (const fileChunk of chunks) {
    const { systemPrompt, userPrompt } = buildReviewPrompt(fileChunk, promptOptions);
    const { findings } = await provider.review({ systemPrompt, userPrompt });
    const { valid, invalid } = validateFindings(findings);
    allValid.push(...valid);
    allInvalid.push(...invalid);
  }

  const index = buildChangedLineIndex(diffResult);
  const { kept, dropped } = filterFindingsToDiff(allValid, index);

  // Deterministic rule hits win over LLM findings on the same line.
  const { kept: llmKept, duplicates } = dedupeAgainstRules(kept, ruleFindings);
  const allDropped = [...dropped, ...duplicates.map((f) => ({ finding: f, reason: 'duplicate-of-rule' }))];
  const combined = [...ruleFindings, ...llmKept];

  // Severity threshold: hide anything below it (e.g. no nits, ever).
  const threshold = normalizeThreshold(promptOptions.severityThreshold);
  const { kept: above, suppressed: belowThreshold } = filterByThreshold(combined, threshold);

  // Comment cap: keep the most severe findings first.
  const maxComments = Number(promptOptions.maxComments ?? 15);
  const sorted = sortFindings(above);
  let finalList = sorted;
  let capped = [];
  if (Number.isFinite(maxComments) && maxComments > 0 && sorted.length > maxComments) {
    finalList = sorted.slice(0, maxComments);
    capped = sorted.slice(maxComments).map((f) => ({ finding: f, reason: 'over-max-comments' }));
  }
  const suppressed = [...belowThreshold, ...capped];

  const summary = formatSummary({
    findings: finalList,
    stats: { ...(diffResult.stats || {}), truncated: diffResult.truncated },
    config: promptOptions.config,
    dropped: allDropped,
    suppressed,
  });

  return {
    findings: finalList,
    dropped: allDropped,
    suppressed,
    invalid: allInvalid,
    ruleErrors,
    chunks: chunks.length,
    summary,
    payload: formatReviewPayload({ findings: finalList, summary, event, commitId }),
    truncated: Boolean(diffResult.truncated),
    empty: false,
  };
}

module.exports = { runReview };
