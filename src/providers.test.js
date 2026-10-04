'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createProvider,
  parseModelString,
  extractJson,
  OpencodeProvider,
  OpenAICompatibleProvider,
} = require('./providers');

describe('providers', () => {
  it('parses model strings with provider hints (colon; slash stays in model)', () => {
    assert.deepEqual(parseModelString('opencode:opencode/gpt-5'), {
      providerHint: 'opencode',
      model: 'opencode/gpt-5',
    });
    assert.deepEqual(parseModelString('openai:gpt-4o-mini'), {
      providerHint: 'openai',
      model: 'gpt-4o-mini',
    });
    assert.deepEqual(parseModelString('opencode/gpt-5'), {
      providerHint: undefined,
      model: 'opencode/gpt-5',
    });
    assert.deepEqual(parseModelString('gpt-4o-mini'), { providerHint: undefined, model: 'gpt-4o-mini' });
  });

  it('creates swappable providers from model string + env', () => {
    const a = createProvider({ provider: 'opencode', model: 'opencode/gpt-5' });
    assert.ok(a instanceof OpencodeProvider);
    assert.equal(a.model, 'opencode/gpt-5');
    const b = createProvider({ model: 'opencode:foo/bar' });
    assert.ok(b instanceof OpencodeProvider);
    assert.equal(b.model, 'foo/bar');
    const c = createProvider({ provider: 'openai-compatible', model: 'gpt-4o-mini' });
    assert.ok(c instanceof OpenAICompatibleProvider);
    assert.throws(() => createProvider({ provider: 'wat', model: 'x' }), /Unknown provider/);
  });

  it('extracts JSON from fences and prose', () => {
    assert.deepEqual(extractJson('```json\n{"findings":[]}\n```'), { findings: [] });
    assert.deepEqual(extractJson('here you go {"findings":[]} bye'), { findings: [] });
    assert.throws(() => extractJson('no json here'), /did not contain JSON/);
  });

  it('opencode provider passes model string and parses stdout', async () => {
    let seen = null;
    const p = new OpencodeProvider({
      model: 'opencode/gpt-5',
      spawnImpl: (bin, args, opts) => {
        seen = { bin, args, opts };
        return { status: 0, stdout: '{"findings":[]}', stderr: '' };
      },
    });
    const res = await p.review({ systemPrompt: 's', userPrompt: 'u' });
    assert.deepEqual(res.findings, []);
    assert.deepEqual(seen.args, ['run', '--model', 'opencode/gpt-5', '--format', 'json']);
  });

  it('openai-compatible provider posts model + key from env (mock fetch)', async () => {
    let seenUrl = null;
    let seenBody = null;
    const fetchImpl = async (url, opts) => {
      seenUrl = url;
      seenBody = JSON.parse(opts.body);
      assert.match(opts.headers.authorization, /^Bearer sk-/);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }),
      };
    };
    const p = new OpenAICompatibleProvider({
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      fetchImpl,
    });
    const res = await p.review({ systemPrompt: 's', userPrompt: 'u' });
    assert.deepEqual(res.findings, []);
    assert.equal(seenUrl, 'https://api.openai.com/v1/chat/completions');
    assert.equal(seenBody.model, 'gpt-4o-mini');
  });

  it('openai-compatible provider errors without a key (no hardcoding)', async () => {
    const p = new OpenAICompatibleProvider({ model: 'm', apiKey: undefined, env: {}, fetchImpl: async () => ({}) });
    await assert.rejects(() => p.review({ systemPrompt: 's', userPrompt: 'u' }), /Missing API key/);
  });
});
