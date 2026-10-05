'use strict';

/**
 * GitHub Action entrypoint (runs.main = src/index.js, node20).
 * Reads inputs via loadConfig(), collects the base...head diff (or parses
 * REVIEW_DIFF for testing), runs the engine, and emits outputs:
 *   - summary (multiline)
 *   - findings-json
 * Also appends the summary to GITHUB_STEP_SUMMARY when available.
 * Never prints secrets; API keys stay in the environment.
 */

const fs = require('node:fs');
const { loadConfig } = require('./config');
const { collectDiff, parseUnifiedDiff } = require('./diffCollector');
const { createProvider } = require('./providers');
const { runReview } = require('./reviewEngine');
const { resolveDiff, diffRange } = require('../scripts/incremental');
const {
  upsertSummaryComment,
  postInlineComments,
  reviewedStateMarker,
} = require('../scripts/post-review');

function setOutput(name, value) {
  const text = String(value);
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    fs.appendFileSync(outFile, `${name}<<__OPENREVIEW_EOF__\n${text}\n__OPENREVIEW_EOF__\n`, 'utf8');
  } else {
    process.stdout.write(`::set-output name=${name}::${oneLine(text)}\n`);
  }
}

function oneLine(s) {
  return String(s).replace(/\r?\n/g, ' ').slice(0, 4000);
}

function resolveRepository(env = process.env) {
  return env.REVIEW_REPOSITORY || env.GITHUB_REPOSITORY || '';
}

async function main() {
  const env = process.env;
  const config = loadConfig();
  const cwd = env.GITHUB_WORKSPACE || process.cwd();
  const token = env.GITHUB_TOKEN || env.INPUT_GITHUB_TOKEN || env['INPUT_GITHUB-TOKEN'] || '';
  const repo = resolveRepository(env);
  const prNumber = env.PR_NUMBER || env.INPUT_PR_NUMBER || '';
  const canPost = Boolean(token && repo && prNumber);

  let diffResult;
  let rawDiff = '';
  let usedBase = config.base;
  let usedHead = config.head;
  if (env.REVIEW_DIFF) {
    diffResult = parseUnifiedDiff(env.REVIEW_DIFF, {
      ignorePatterns: config.ignorePatterns,
      limits: config.limits,
    });
    rawDiff = env.REVIEW_DIFF;
  } else {
    if ((!config.base || !config.head) && !canPost) {
      throw new Error('Missing base/head: set `base` and `head` inputs (or REVIEW_BASE/REVIEW_HEAD).');
    }
    if (canPost) {
      try {
        const plan = await resolveDiff({
          token,
          repo,
          prNumber,
          baseSha: config.base,
          headSha: config.head,
          apiUrl: env.GITHUB_API_URL,
          stateFile: env.REVIEW_STATE_FILE,
          cwd,
          force: env.REVIEW_FORCE === 'true',
        });
        if (plan.skip) {
          const summary = `_Already reviewed at ${plan.lastReviewedSha}. No new commits since the last review._`;
          setOutput('summary', summary);
          setOutput('findings-json', '[]');
          process.stdout.write(summary + '\n');
          return { skipped: true, summary, findings: [] };
        }
        usedBase = plan.base;
        usedHead = plan.head;
        rawDiff = plan.diff || '';
        diffResult = parseUnifiedDiff(rawDiff, {
          ignorePatterns: config.ignorePatterns,
          limits: config.limits,
        });
      } catch (error) {
        process.stderr.write(`incremental diff failed, falling back to local git: ${error.message}\n`);
      }
    }
    if (!diffResult) {
      diffResult = collectDiff({
        base: config.base,
        head: config.head,
        cwd,
        ignorePatterns: config.ignorePatterns,
        limits: config.limits,
      });
      try {
        rawDiff = diffRange({ base: config.base, head: config.head, cwd });
      } catch (error) {
        rawDiff = '';
      }
    }
  }

  const provider = createProvider({
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
  });

  const result = await runReview({
    diffResult,
    provider,
    promptOptions: {
      focus: config.focus,
      extraRules: config.extraRules,
      limits: config.limits,
      severityThreshold: config.severityThreshold,
      maxComments: config.maxComments,
      rules: { enabled: config.rulesEnabled, dir: config.rulesDir, cwd },
      config: { model: `${config.provider}:${config.model}` },
    },
    event: config.event,
    commitId: usedHead || process.env.GITHUB_SHA || undefined,
  });

  setOutput('summary', result.summary);
  setOutput('findings-json', JSON.stringify(result.findings));
  for (const e of result.ruleErrors || []) {
    process.stderr.write(`openreview rules warning [${e.file}${e.id ? ':' + e.id : ''}]: ${e.error}\n`);
  }
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) fs.appendFileSync(stepSummary, result.summary + '\n', 'utf8');
  else process.stdout.write(result.summary + '\n');

  if (canPost && !env.REVIEW_DRY_RUN) {
    const body = `${result.summary}\n\n${reviewedStateMarker(usedHead)}`;
    const upserted = await upsertSummaryComment({
      token,
      repo,
      prNumber,
      body,
      apiUrl: env.GITHUB_API_URL,
    });
    process.stdout.write(`summary comment ${upserted.created ? 'created' : 'updated'}\n`);
    if (result.findings.length > 0 && rawDiff && env.REVIEW_INLINE !== 'false') {
      const inline = await postInlineComments({
        token,
        repo,
        prNumber,
        commitId: usedHead,
        comments: result.payload.comments,
        diff: rawDiff,
        apiUrl: env.GITHUB_API_URL,
        event: config.event,
      });
      process.stdout.write(`inline comments posted: ${inline.posted}, dropped: ${inline.dropped.length}\n`);
    }
  }
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`openreview failed: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

module.exports = { main, resolveRepository };
