'use strict';

// Incremental review planning for the AI PR review bot.
//
// The previously reviewed head SHA is recovered from one of:
//   1. a state artifact file (REVIEW_STATE_FILE) written by the engine, or
//   2. the hidden marker in the existing summary comment.
//
// When the previous SHA is an ancestor of the new head, only priorHead...head
// is diffed so a push reviews just the new commits. Otherwise the full
// base...head diff is used. If git objects are unavailable locally the diff is
// fetched from the GitHub compare API.

const fs = require('fs');
const { execFileSync } = require('child_process');

const REVIEWED_SHA_RE = /<!-- openreview-bot:reviewed:([0-9a-fA-F]{7,40}) -->/;

function extractReviewedSha(text) {
  const match = REVIEWED_SHA_RE.exec(String(text || ''));
  return match ? match[1] : null;
}

function readStateArtifact(filePath) {
  if (!filePath) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed.reviewedSha || parsed.reviewed_sha || null;
    } catch (error) {
      return raw;
    }
  } catch (error) {
    return null;
  }
}

async function getLastReviewedSha({
  token,
  repo,
  prNumber,
  apiUrl,
  stateFile,
  fetchImpl,
} = {}) {
  const fromArtifact = readStateArtifact(stateFile);
  if (fromArtifact) return fromArtifact;
  if (!token || !repo || !prNumber) return null;
  const { listIssueComments, findSummaryComment } = require('./post-review');
  const comments = await listIssueComments({ token, repo, prNumber, apiUrl, fetchImpl });
  const summary = findSummaryComment(comments);
  return summary ? extractReviewedSha(summary.body) : null;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function hasCommit(sha, cwd) {
  if (!sha) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function isAncestor(ancestor, descendant, cwd) {
  if (!ancestor || !descendant) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    return false;
  }
}

// Decide which range to review. Pure and easy to unit test.
function planDiff({ baseSha, headSha, lastReviewedSha, ancestorCheck = () => false, force = false }) {
  if (force || !lastReviewedSha) {
    return { base: baseSha, head: headSha, mode: 'full', skip: false };
  }
  if (lastReviewedSha === headSha) {
    return { base: baseSha, head: headSha, mode: 'up-to-date', skip: true };
  }
  if (ancestorCheck(lastReviewedSha, headSha)) {
    return { base: lastReviewedSha, head: headSha, mode: 'incremental', skip: false };
  }
  return { base: baseSha, head: headSha, mode: 'full-rebase', skip: false };
}

function diffRange({ base, head, cwd }) {
  return git(['diff', '--unified=3', base, head, '--'], cwd);
}

// Build a unified diff from the compare API when local git cannot.
async function apiDiff({ token, repo, base, head, apiUrl, fetchImpl }) {
  const { githubFetch } = require('./post-review');
  const compare = await githubFetch('GET', `/repos/${repo}/compare/${base}...${head}`, {
    token,
    apiUrl,
    fetchImpl,
  });
  const parts = [];
  for (const file of (compare && compare.files) || []) {
    if (!file || !file.filename) continue;
    parts.push(`diff --git a/${file.filename} b/${file.filename}`);
    parts.push(`--- a/${file.previous_filename || file.filename}`);
    parts.push(`+++ b/${file.filename}`);
    if (file.patch) parts.push(file.patch);
  }
  return parts.join('\n');
}

async function resolveDiff({
  token,
  repo,
  prNumber,
  baseSha,
  headSha,
  apiUrl,
  stateFile = process.env.REVIEW_STATE_FILE,
  cwd = process.cwd(),
  force = false,
  fetchImpl,
} = {}) {
  const lastReviewedSha = await getLastReviewedSha({
    token,
    repo,
    prNumber,
    apiUrl,
    stateFile,
    fetchImpl,
  });
  const plan = planDiff({
    baseSha,
    headSha,
    lastReviewedSha,
    force,
    ancestorCheck: (a, b) => isAncestor(a, b, cwd),
  });
  if (plan.skip) return { ...plan, lastReviewedSha, source: 'none', diff: '' };
  if (hasCommit(plan.base, cwd) && hasCommit(plan.head, cwd)) {
    return { ...plan, lastReviewedSha, source: 'git', diff: diffRange({ base: plan.base, head: plan.head, cwd }) };
  }
  const diff = await apiDiff({ token, repo, base: plan.base, head: plan.head, apiUrl, fetchImpl });
  return { ...plan, lastReviewedSha, source: 'api', diff };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  const env = process.env;
  const input = (await readStdin()).trim();
  const payload = input ? JSON.parse(input) : {};
  const result = await resolveDiff({
    token: env.GITHUB_TOKEN,
    repo: env.GITHUB_REPOSITORY,
    prNumber: env.PR_NUMBER,
    baseSha: payload.baseSha || env.BASE_SHA,
    headSha: payload.headSha || env.HEAD_SHA,
    apiUrl: env.GITHUB_API_URL,
    stateFile: env.REVIEW_STATE_FILE,
    cwd: env.GITHUB_WORKSPACE || process.cwd(),
    force: payload.force !== undefined ? Boolean(payload.force) : env.REVIEW_FORCE === 'true',
  });
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`incremental failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  REVIEWED_SHA_RE,
  extractReviewedSha,
  readStateArtifact,
  getLastReviewedSha,
  hasCommit,
  isAncestor,
  planDiff,
  diffRange,
  apiDiff,
  resolveDiff,
};
