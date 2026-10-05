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
  return text ? JSON.parse(text) : null;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemBytes(pem) {
  const isPkcs1 = pem.includes('-----BEGIN RSA PRIVATE KEY-----');
  const base64 = pem.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g, '');
  const binary = atob(base64);
  const key = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (!isPkcs1) return key;

  const der = (tag, value) => {
    const length = value.length;
    const size = length < 128
      ? [length]
      : (() => {
        const bytes = [];
        let remaining = length;
        while (remaining > 0) {
          bytes.unshift(remaining & 0xff);
          remaining >>>= 8;
        }
        return [0x80 | bytes.length, ...bytes];
      })();
    return new Uint8Array([tag, ...size, ...value]);
  };
  const concat = (...parts) => {
    const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  };
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaEncryption = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  return der(0x30, concat(version, rsaEncryption, der(0x04, key)));
}

async function createAppJwt(env) {
  if (!env.OPENREVIEW_APP_ID || !env.OPENREVIEW_APP_PRIVATE_KEY) {
    throw new Error('OpenReview GitHub App credentials are not configured');
  }
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBytes(env.OPENREVIEW_APP_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64Url(new TextEncoder().encode(JSON.stringify({
    iat: now - 30,
    exp: now + 540,
    iss: env.OPENREVIEW_APP_ID,
  })));
  const unsigned = `${header}.${claims}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function dispatchReview(payload, deliveryId, env) {
  if (!env.OPENREVIEW_OWNER || !env.OPENREVIEW_REPO) {
    throw new Error('OpenReview repository settings are not configured');
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

  const installationId = payload.installation && payload.installation.id;
  if (!installationId) throw new Error('Webhook is missing the GitHub App installation');
  const appJwt = await createAppJwt(env);
  const installation = await githubRequest(`${API_ROOT}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repositories: [env.OPENREVIEW_REPO],
      permissions: { contents: 'write' },
    }),
  });

  return githubRequest(`${API_ROOT}/repos/${env.OPENREVIEW_OWNER}/${env.OPENREVIEW_REPO}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${installation.token}`, 'Content-Type': 'application/json' },
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

function isReviewCommand(body) {
  const text = String(body || '');
  return /\/review\b/i.test(text) || /@openview0\s+review\b/i.test(text);
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
      if (payload.action !== 'created' || !payload.issue?.pull_request || !isReviewCommand(payload.comment?.body)) {
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
