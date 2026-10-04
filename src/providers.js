'use strict';

/**
 * Provider abstraction.
 *
 * - OpencodeProvider: shells out to the `opencode` CLI (`opencode run`)
 *   with a model string, e.g. model "opencode/gpt-5" or any string the CLI
 *   accepts. API keys come from the environment (passed through, never
 *   hardcoded). spawnImpl is injectable for tests.
 * - OpenAICompatibleProvider: POSTs to {baseUrl}/chat/completions with
 *   { model, messages } and requests a JSON object back. Works for OpenAI
 *   and any OpenAI-compatible endpoint (custom baseUrl). Key from env.
 * - createProvider({ provider, model }) selects an implementation. The
 *   model string may carry a prefix ("opencode:<m>", "opencode/<m>",
 *   "openai:<m>"); otherwise `provider` selects the backend and `model`
 *   is passed through verbatim.
 *
 * No secrets are hardcoded: keys are read from environment variables only.
 */

const { spawnSync } = require('node:child_process');

const ENV_KEYS_OPENAI = ['REVIEW_PROVIDER_API_KEY', 'OPENAI_API_KEY', 'REVIEW_API_KEY', 'INPUT_API_KEY'];
const ENV_KEYS_OPENCODE = ['OPENCODE_API_KEY', 'OPENAI_API_KEY', 'REVIEW_API_KEY'];

function readEnvKey(env, names) {
  const source = env || process.env;
  for (const n of names) {
    const v = source[n];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

class ProviderError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = opts.provider;
    this.cause = opts.cause;
  }
}

/** Pull a JSON object/array out of raw model text (handles ```json fences). */
function extractJson(rawText) {
  if (typeof rawText !== 'string') throw new ProviderError('Empty model response');
  const text = rawText.trim();
  if (!text) throw new ProviderError('Empty model response');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fence ? fence[1].trim() : text;
  // Try direct parse, then fall back to first {...} / [...] span.
  try {
    return JSON.parse(candidate);
  } catch {
    const startObj = candidate.indexOf('{');
    const startArr = candidate.indexOf('[');
    let start = -1;
    if (startObj !== -1 && (startArr === -1 || startObj < startArr)) start = startObj;
    else if (startArr !== -1) start = startArr;
    if (start === -1) throw new ProviderError('Model response did not contain JSON');
    const slice = candidate.slice(start);
    // Greedy end: last } or ]
    const endObj = slice.lastIndexOf('}');
    const endArr = slice.lastIndexOf(']');
    const end = Math.max(endObj, endArr);
    if (end === -1) throw new ProviderError('Model response did not contain JSON');
    try {
      return JSON.parse(slice.slice(0, end + 1));
    } catch (err) {
      throw new ProviderError('Model response was not valid JSON', { cause: err });
    }
  }
}

function normalizeFindingsPayload(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.findings)) return parsed.findings;
  return [];
}

/** Split "provider:model" prefix; "/" stays part of the model name (models often contain slashes). */
function parseModelString(model) {
  const raw = String(model || '').trim();
  const m = /^(opencode|openai-compatible|openai)\s*:\s*(.+)$/i.exec(raw);
  if (m) return { providerHint: m[1].toLowerCase(), model: m[2].trim() };
  return { providerHint: undefined, model: raw };
}

class OpencodeProvider {
  constructor(opts = {}) {
    this.name = 'opencode';
    this.model = opts.model || 'opencode/default';
    this.bin = opts.bin || process.env.OPENCODE_BIN || 'opencode';
    this.spawnImpl = opts.spawnImpl || ((bin, args, o) => spawnSync(bin, args, o));
    this.env = opts.env || process.env;
  }
  apiKeyPresent() {
    return Boolean(readEnvKey(this.env, ENV_KEYS_OPENCODE));
  }
  async review({ systemPrompt, userPrompt, signal } = {}) {
    if (signal && signal.aborted) throw new ProviderError('Aborted', { provider: this.name });
    const args = ['run', '--model', this.model, '--format', 'json'];
    let res;
    try {
      res = this.spawnImpl(
        this.bin,
        args,
        {
          input: `${systemPrompt || ''}\n\n${userPrompt || ''}`,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          env: this.env,
        }
      );
    } catch (err) {
      throw new ProviderError(`opencode spawn failed: ${err.message}`, { provider: this.name, cause: err });
    }
    if (!res || res.status !== 0) {
      const stderr = res && res.stderr ? String(res.stderr).slice(0, 2000) : '';
      throw new ProviderError(`opencode run failed (status ${res ? res.status : 'unknown'}) ${stderr}`, {
        provider: this.name,
      });
    }
    const rawText = String(res.stdout || '');
    const parsed = extractJson(rawText);
    return { rawText, findings: normalizeFindingsPayload(parsed) };
  }
}

class OpenAICompatibleProvider {
  constructor(opts = {}) {
    this.name = 'openai-compatible';
    this.model = opts.model || 'gpt-4o-mini';
    this.baseUrl = (opts.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = opts.apiKey || readEnvKey(opts.env || process.env, ENV_KEYS_OPENAI);
    this.fetchImpl =
      opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
    this.extraHeaders = opts.extraHeaders || {};
  }
  apiKeyPresent() {
    return Boolean(this.apiKey);
  }
  async review({ systemPrompt, userPrompt, signal } = {}) {
    if (!this.fetchImpl) throw new ProviderError('No fetch implementation available', { provider: this.name });
    if (!this.apiKey) {
      throw new ProviderError(
        `Missing API key (set one of ${ENV_KEYS_OPENAI.join(', ')})`,
        { provider: this.name }
      );
    }
    const url = `${this.baseUrl}/chat/completions`;
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt || '' },
            { role: 'user', content: userPrompt || '' },
          ],
        }),
      });
    } catch (err) {
      throw new ProviderError(`HTTP request failed: ${err.message}`, { provider: this.name, cause: err });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProviderError(`HTTP ${res.status}: ${body.slice(0, 2000)}`, { provider: this.name });
    }
    const data = await res.json().catch((err) => {
      throw new ProviderError('Invalid JSON from provider', { provider: this.name, cause: err });
    });
    const rawText =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || '')
        : JSON.stringify(data);
    const parsed = extractJson(rawText);
    return { rawText, findings: normalizeFindingsPayload(parsed) };
  }
}

function createProvider({ provider, model, baseUrl, apiKey, env, fetchImpl, spawnImpl, bin } = {}) {
  const { providerHint, model: cleanModel } = parseModelString(model);
  const want = String(provider || providerHint || 'openai-compatible').toLowerCase();
  if (want === 'opencode') {
    return new OpencodeProvider({ model: cleanModel || 'opencode/default', env, spawnImpl, bin });
  }
  if (want === 'openai-compatible' || want === 'openai') {
    return new OpenAICompatibleProvider({
      model: cleanModel || 'gpt-4o-mini',
      baseUrl,
      apiKey,
      env,
      fetchImpl,
    });
  }
  throw new ProviderError(`Unknown provider: ${provider}`);
}

module.exports = {
  ProviderError,
  OpencodeProvider,
  OpenAICompatibleProvider,
  createProvider,
  parseModelString,
  extractJson,
  normalizeFindingsPayload,
  ENV_KEYS_OPENAI,
  ENV_KEYS_OPENCODE,
};
