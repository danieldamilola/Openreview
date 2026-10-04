'use strict';

/**
 * Config: model selectable via action input or environment; secrets from
 * environment only. Mirrors the inputs declared in action.yml.
 */

const { parseIgnorePatterns, DEFAULT_LIMITS } = require('./diffCollector');
const { normalizeThreshold } = require('./promptBuilder');

function str(v, fallback = '') {
  return v === undefined || v === null ? fallback : String(v);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v, fallback = true) {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

/**
 * Load config from action inputs (INPUT_* env when running as a GitHub
 * Action) with explicit overrides. Precedence: overrides > INPUT_* >
 * plain env > defaults.
 */
function loadConfig(overrides = {}, env = process.env) {
  const get = (inputName, envNames, fallback = '') => {
    if (overrides[inputName] !== undefined && overrides[inputName] !== '') return overrides[inputName];
    const inputEnv = `INPUT_${inputName.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
    if (env[inputEnv] !== undefined && env[inputEnv] !== '') return env[inputEnv];
    for (const e of [].concat(envNames || [])) {
      if (env[e] !== undefined && env[e] !== '') return env[e];
    }
    return fallback;
  };

  const provider = str(get('provider', ['REVIEW_PROVIDER'], 'openai-compatible')).toLowerCase();
  const model = str(get('model', ['REVIEW_MODEL', 'INPUT_MODEL'], 'gpt-4o-mini'));
  const baseUrl = str(get('base-url', ['REVIEW_BASE_URL', 'OPENAI_BASE_URL'], 'https://api.openai.com/v1'));
  const base = str(get('base', ['REVIEW_BASE', 'BASE_SHA', 'GITHUB_BASE_REF'], ''));
  const head = str(get('head', ['REVIEW_HEAD', 'HEAD_SHA', 'GITHUB_SHA'], ''));
  const event = str(get('review-event', [], 'COMMENT')).toUpperCase();
  const severityThreshold = normalizeThreshold(get('severity-threshold', ['REVIEW_SEVERITY_THRESHOLD'], 'minor'));
  const maxComments = num(get('max-comments', ['REVIEW_MAX_COMMENTS'], 15), 15);
  const rulesEnabled = bool(get('rules-enabled', ['REVIEW_RULES_ENABLED'], true), true);
  const rulesDir = str(get('rules-dir', ['REVIEW_RULES_DIR'], 'rules'), 'rules');
  const ignorePatterns = parseIgnorePatterns(get('ignore-patterns', ['REVIEW_IGNORE'], ''));
  const focus = str(get('focus', [], ''));
  const extraRules = str(get('extra-rules', [], ''));

  const limits = {
    maxFiles: num(get('max-files', ['REVIEW_MAX_FILES'], DEFAULT_LIMITS.maxFiles), DEFAULT_LIMITS.maxFiles),
    maxFileChars: num(
      get('max-file-chars', ['REVIEW_MAX_FILE_CHARS'], DEFAULT_LIMITS.maxFileChars),
      DEFAULT_LIMITS.maxFileChars
    ),
    maxTotalChars: num(
      get('max-total-chars', ['REVIEW_MAX_TOTAL_CHARS'], DEFAULT_LIMITS.maxTotalChars),
      DEFAULT_LIMITS.maxTotalChars
    ),
    maxHunkLines: num(
      get('max-hunk-lines', ['REVIEW_MAX_HUNK_LINES'], DEFAULT_LIMITS.maxHunkLines),
      DEFAULT_LIMITS.maxHunkLines
    ),
  };

  return {
    provider,
    model: model.includes(':') || model.includes('/') ? model : model,
    fullModel: model,
    baseUrl,
    base,
    head,
    event: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(event) ? event : 'COMMENT',
    severityThreshold,
    maxComments,
    rulesEnabled,
    rulesDir,
    ignorePatterns,
    focus: focus || undefined,
    extraRules: extraRules || undefined,
    limits,
  };
}

module.exports = { loadConfig };
