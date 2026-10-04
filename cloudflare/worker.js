const API_ROOT = 'https://api.github.com';

async function verifySignature(body, header, secret) {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const expected = `sha256=${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (header.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

async function githubRequest(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'OpenReview-GitHub-App',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${text.slice(0, 500)}`);
}

async function dispatchReview(payload, deliveryId, env) {
  if (!env.DISPATCH_TOKEN || !env.OPENREVIEW_OWNER || !env.OPENREVIEW_REPO) {
    throw new Error('OpenReview dispatch token and repository settings are not configured');
  }
  const repo = payload.repository && payload.repository.full_name;
  if (!repo) throw new Error('Webhook is missing repository data');

  const owner = repo.split('/')[0];
  const pull = payload.pull_request || payload.issue;
  const prNumber = pull && pull.number;
  const pullRequest = payload.pull_request || (payload.issue && payload.issue.pull_request);
  if (!prNumber || !pullRequest) return { ignored: true };

  const event = payload.__event;
  const force = event === 'issue_comment';
  const baseSha = payload.pull_request && payload.pull_request.base && payload.pull_request.base.sha;
  const headSha = payload.pull_request && payload.pull_request.head && payload.pull_request.head.sha;

  return githubRequest(`${API_ROOT}/repos/${env.OPENREVIEW_OWNER}/${env.OPENREVIEW_REPO}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.DISPATCH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'openreview_review',
      client_payload: {
        repository: repo,
        repository_owner: owner,
        repository_name: repo.split('/')[1],
        pr_number: prNumber,
        base_sha: baseSha || '',
        head_sha: headSha || '',
        force,
        delivery_id: deliveryId,
      },
    }),
  });
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return response({ ok: true });
    if (request.method !== 'POST' || url.pathname !== '/webhook') return response({ error: 'Not found' }, 404);

    const raw = await request.text();
    if (!(await verifySignature(raw, request.headers.get('x-hub-signature-256'), env.WEBHOOK_SECRET))) {
      return response({ error: 'Invalid webhook signature' }, 401);
    }

    const event = request.headers.get('x-github-event');
    const delivery = request.headers.get('x-github-delivery') || '';
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return response({ error: 'Invalid JSON' }, 400);
    }
    payload.__event = event;

    if (event === 'pull_request') {
      if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(payload.action)) {
        return response({ ignored: true });
      }
    } else if (event === 'issue_comment') {
      if (payload.action !== 'created' || !payload.issue?.pull_request || !String(payload.comment?.body || '').includes('/review')) {
        return response({ ignored: true });
      }
      if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(payload.comment?.author_association)) {
        return response({ ignored: true });
      }
    } else {
      return response({ ignored: true });
    }

    try {
      await dispatchReview(payload, delivery, env);
      return response({ queued: true });
    } catch (error) {
      return response({ error: error.message }, 502);
    }
  },
};
