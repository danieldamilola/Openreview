'use strict';

// Posting layer for the AI PR review bot.
//
// Responsibilities:
//   * find-or-create ONE summary comment, identified by the hidden marker
//     OPENREVIEW_MARKER, and patch it in place so pushes never spam;
//   * post inline review comments via the pulls API, but only for lines that
//     are actually present in the diff (anchored to added lines).
//
// Uses the global fetch (Node 18+) against GITHUB_API_URL. No dependencies.

const OPENREVIEW_MARKER = '<!-- openreview-bot:summary -->';
const REVIEWED_SHA_RE = /<!-- openreview-bot:reviewed:([0-9a-fA-F]{7,40}) -->/;
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function resolveApiBase(apiUrl) {
  return (apiUrl || process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
}

async function githubFetch(method, path, options = {}) {
  const { token, apiUrl, body, fetchImpl = fetch } = options;
  if (!token) throw new Error('GITHUB_TOKEN is required to call the GitHub API');
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  const url = `${resolveApiBase(apiUrl)}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'openreview-pr-review-bot',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = null;
    }
  }
  if (!response.ok) {
    const message = data && data.message ? data.message : text || `HTTP ${response.status}`;
    const err = new Error(`GitHub API ${response.status}: ${message}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function listIssueComments({ token, repo, prNumber, apiUrl, fetchImpl }) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubFetch(
      'GET',
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      { token, apiUrl, fetchImpl },
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

function findSummaryComment(comments, marker = OPENREVIEW_MARKER) {
  return (
    (comments || []).find(
      (comment) => typeof comment.body === 'string' && comment.body.includes(marker),
    ) || null
  );
}

function withMarker(body, marker = OPENREVIEW_MARKER) {
  const text = String(body || '');
  return text.includes(marker) ? text : `${marker}\n\n${text}`;
}

// Find the single summary comment and patch it, or create it when absent.
async function upsertSummaryComment({
  token,
  repo,
  prNumber,
  body,
  marker = OPENREVIEW_MARKER,
  apiUrl,
  fetchImpl,
}) {
  const comments = await listIssueComments({ token, repo, prNumber, apiUrl, fetchImpl });
  const existing = findSummaryComment(comments, marker);
  const rendered = withMarker(body, marker);
  if (existing) {
    const comment = await githubFetch('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, {
      token,
      apiUrl,
      fetchImpl,
      body: { body: rendered },
    });
    return { comment, created: false, updated: true };
  }
  const comment = await githubFetch('POST', `/repos/${repo}/issues/${prNumber}/comments`, {
    token,
    apiUrl,
    fetchImpl,
    body: { body: rendered },
  });
  return { comment, created: true, updated: false };
}

// Map each file path to the set of added (right-side) new line numbers.
function addedLinesByPath(diffText) {
  const map = new Map();
  let path = null;
  let newLine = 0;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+++ ')) {
      let value = line.slice(4).split('\t')[0].trim();
      if (value === '/dev/null') {
        path = null;
      } else {
        path = value.replace(/^b\//, '');
        if (!map.has(path)) map.set(path, new Set());
      }
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (path === null) continue;
    const marker = line[0];
    if (marker === '+') {
      map.get(path).add(newLine);
      newLine += 1;
    } else if (marker === '-') {
      // removed line: does not advance the new-file counter
    } else if (marker === '\\') {
      // "\ No newline at end of file"
    } else if (line.startsWith(' ')) {
      newLine += 1;
    }
  }
  return map;
}

// Split comments into those anchored to an added diff line and those not.
function anchorComments(comments, diffText) {
  const added = addedLinesByPath(diffText);
  const anchored = [];
  const dropped = [];
  for (const comment of comments || []) {
    const set = added.get(comment.path);
    if (set && set.has(Number(comment.line))) anchored.push(comment);
    else dropped.push(comment);
  }
  return { anchored, dropped };
}

// Post inline comments. Anything not on an added diff line is dropped.
async function postInlineComments({
  token,
  repo,
  prNumber,
  commitId,
  comments,
  diff,
  apiUrl,
  fetchImpl,
  event = 'COMMENT',
}) {
  const { anchored, dropped } = anchorComments(comments, diff);
  if (anchored.length === 0) return { posted: 0, dropped, review: null };
  const payload = anchored.map((comment) => ({
    path: comment.path,
    line: Number(comment.line),
    side: comment.side || 'RIGHT',
    body: comment.body,
  }));
  const review = await githubFetch('POST', `/repos/${repo}/pulls/${prNumber}/reviews`, {
    token,
    apiUrl,
    fetchImpl,
    body: {
      commit_id: commitId,
      event,
      body: 'OpenReview code review.',
      comments: payload,
    },
  });
  return { posted: anchored.length, dropped, review };
}

// Build the hidden state marker that records the reviewed SHA.
function reviewedStateMarker(sha) {
  return `<!-- openreview-bot:reviewed:${sha} -->`;
}

function extractReviewedSha(text) {
  const match = REVIEWED_SHA_RE.exec(String(text || ''));
  return match ? match[1] : null;
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
  const common = {
    token: env.GITHUB_TOKEN,
    repo: env.GITHUB_REPOSITORY,
    prNumber: env.PR_NUMBER,
    apiUrl: env.GITHUB_API_URL,
  };
  if (payload.action === 'inline') {
    const result = await postInlineComments({
      ...common,
      commitId: payload.commitId || env.HEAD_SHA,
      comments: payload.comments || [],
      diff: payload.diff || '',
    });
    process.stdout.write(JSON.stringify({ posted: result.posted, dropped: result.dropped.length }));
    return;
  }
  const result = await upsertSummaryComment({ ...common, body: payload.body || '' });
  process.stdout.write(
    JSON.stringify({
      created: result.created,
      updated: result.updated,
      id: result.comment && result.comment.id,
    }),
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`post-review failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  OPENREVIEW_MARKER,
  REVIEWED_SHA_RE,
  githubFetch,
  listIssueComments,
  findSummaryComment,
  withMarker,
  upsertSummaryComment,
  addedLinesByPath,
  anchorComments,
  postInlineComments,
  reviewedStateMarker,
  extractReviewedSha,
};
