'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  OPENREVIEW_MARKER,
  upsertSummaryComment,
  anchorComments,
  addedLinesByPath,
  postInlineComments,
  reviewedStateMarker,
  extractReviewedSha,
} = require('../post-review');

const SAMPLE_DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,2 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 2;',
  '+console.log("debug");',
  '+const c = 3;',
  '',
].join('\n');

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, method: options.method });
    const handler = responses.shift();
    assert.ok(handler, `unexpected request ${options.method} ${url}`);
    const result = typeof handler === 'function' ? handler(url, options) : handler;
    const status = result.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(result.body === undefined ? {} : result.body),
    };
  };
  impl.calls = calls;
  return impl;
}

test('upsertSummaryComment creates once then patches the same comment', async () => {
  const stored = [];
  let nextId = 1;
  const responses = [
    { body: [] }, // first list -> empty
    { status: 201, body: { id: nextId++ } }, // create
    () => ({ body: stored.slice() }), // second list
    { body: { id: 1 } }, // patch
  ];
  const fetchImpl = fakeFetch(responses);
  const original = fetchImpl;
  // seed stored after create by wrapping
  const wrapped = async (url, options) => {
    const response = await original(url, options);
    if (options.method === 'POST' && url.endsWith('/comments')) {
      stored.push({ id: 1, body: JSON.parse(options.body).body });
    }
    return response;
  };
  wrapped.calls = original.calls;

  const first = await upsertSummaryComment({
    token: 't',
    repo: 'o/r',
    prNumber: 7,
    body: 'Starting review...',
    fetchImpl: wrapped,
  });
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.updated, false);

  const second = await upsertSummaryComment({
    token: 't',
    repo: 'o/r',
    prNumber: 7,
    body: 'Final verdict: comment',
    fetchImpl: wrapped,
  });
  assert.strictEqual(second.created, false);
  assert.strictEqual(second.updated, true);

  const posts = wrapped.calls.filter((c) => c.method === 'POST');
  assert.strictEqual(posts.length, 1, 'only one summary comment is ever created');
  assert.ok(stored[0].body.includes(OPENREVIEW_MARKER));
});

test('addedLinesByPath tracks only added right-side lines', () => {
  const added = addedLinesByPath(SAMPLE_DIFF);
  const lines = added.get('src/app.js');
  assert.deepStrictEqual([...lines].sort((a, b) => a - b), [2, 3, 4]);
  assert.ok(!lines.has(1), 'unchanged context line is not anchored');
});

test('postInlineComments drops comments not on added diff lines', async () => {
  const fetchImpl = fakeFetch([{ status: 201, body: { id: 99 } }]);
  const result = await postInlineComments({
    token: 't',
    repo: 'o/r',
    prNumber: 7,
    commitId: 'abc',
    diff: SAMPLE_DIFF,
    fetchImpl,
    comments: [
      { path: 'src/app.js', line: 3, body: 'anchored ok' },
      { path: 'src/app.js', line: 1, body: 'context line, drop me' },
      { path: 'src/other.js', line: 1, body: 'unknown file, drop me' },
    ],
  });
  assert.strictEqual(result.posted, 1);
  assert.strictEqual(result.dropped.length, 2);
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.deepStrictEqual(body.comments.map((c) => c.line), [3]);
  assert.strictEqual(body.comments[0].side, 'RIGHT');
});

test('anchorComments with no matches posts nothing', async () => {
  const fetchImpl = fakeFetch([]);
  const result = await postInlineComments({
    token: 't',
    repo: 'o/r',
    prNumber: 7,
    commitId: 'abc',
    diff: SAMPLE_DIFF,
    fetchImpl,
    comments: [{ path: 'src/app.js', line: 999, body: 'nope' }],
  });
  assert.strictEqual(result.posted, 0);
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('reviewed state marker round-trips the SHA', () => {
  const marker = reviewedStateMarker('deadbeefcafe');
  assert.strictEqual(extractReviewedSha(`summary\n${marker}`), 'deadbeefcafe');
  assert.strictEqual(extractReviewedSha('no marker here'), null);
});
