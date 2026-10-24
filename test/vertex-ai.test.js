const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { streamVertexGenerateContent, clearVertexTokenCache } = require('../src/vertex-ai');

// Fake service account: a real generated RSA key so createSignedJwt signs for
// real; the mock fetch below answers the token exchange with a fake token.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  client_email: 'test@test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token'
});

function sseData(text) {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
}

// Mock SSE body with a getReader() stream. Reads resolve in order; a pending
// read that is cancelled resolves as done (like a real aborted fetch body).
function sseBody(chunks, { delayMs = 0, failAfter = -1 } = {}) {
  let i = 0;
  let cancelled = false;
  return {
    getReader() {
      return {
        cancel() { cancelled = true; },
        async read() {
          if (cancelled) return { done: true, value: undefined };
          if (failAfter >= 0 && i > failAfter) throw new Error('mock stream failure');
          if (i >= chunks.length) return { done: true, value: undefined };
          const chunk = chunks[i++];
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          if (cancelled) return { done: true, value: undefined };
          return { done: false, value: Buffer.from(chunk) };
        }
      };
    }
  };
}

// A body whose reads never resolve: simulates a stalled region.
function stalledBody() {
  return {
    getReader() {
      return {
        cancel() {},
        read() { return new Promise(() => {}); }
      };
    }
  };
}

function regionOf(url) {
  const m = /\/locations\/([^/]+)\//.exec(String(url));
  return m ? decodeURIComponent(m[1]) : '';
}

// Build a mock fetch from per-region stream scripts and a fallback script.
// streamScript(region, callIndex) returns { status, body } or { status, text }.
// fallbackScript(region, callIndex) returns a parsed JSON body for :generateContent.
function mockFetch({ streamScript, fallbackScript }) {
  const calls = { token: 0, stream: 0, fallback: 0, streamByRegion: {} };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      calls.token++;
      return { ok: true, status: 200, json: async () => ({ access_token: 'fake-token', expires_in: 3600 }) };
    }
    if (u.includes('streamGenerateContent')) {
      calls.stream++;
      const region = regionOf(u);
      calls.streamByRegion[region] = (calls.streamByRegion[region] || 0) + 1;
      const res = streamScript(region, calls.streamByRegion[region]);
      if (res.status !== 200) {
        return { ok: false, status: res.status, text: async () => res.text || `mock ${res.status}` };
      }
      return { ok: true, status: 200, body: res.body };
    }
    if (u.includes(':generateContent')) {
      calls.fallback++;
      const region = regionOf(u);
      const body = fallbackScript ? fallbackScript(region, calls.fallback) : null;
      if (!body) return { ok: false, status: 404, text: async () => 'mock 404' };
      return { ok: true, status: 200, json: async () => body };
    }
    throw new Error(`unexpected url ${u}`);
  };
  return { fetchImpl, calls };
}

function baseConfig() {
  return { serviceAccountJson: SA_JSON, projectId: 'test-project', location: 'global' };
}

test('hedge: fastest region wins, slow region output never leaks', async () => {
  clearVertexTokenCache();
  const { fetchImpl } = mockFetch({
    streamScript: (region) => {
      if (region === 'global') return { status: 200, body: sseBody([sseData('fast')]) };
      if (region === 'us-central1') return { status: 200, body: sseBody([sseData('slow')], { delayMs: 300 }) };
      return { status: 404, text: 'not found' };
    }
  });
  const tokens = [];
  const res = await streamVertexGenerateContent(baseConfig(), {
    model: 'gemini-3.8-flash',
    turns: [{ role: 'user', text: 'hi' }],
    onToken: (t) => tokens.push(t)
  }, fetchImpl);
  assert.equal(res.fullText, 'fast');
  assert.equal(res.region, 'global');
  assert.deepEqual(tokens, ['fast']);
});

test('409 is retried and then succeeds', async () => {
  clearVertexTokenCache();
  const { fetchImpl } = mockFetch({
    streamScript: (_region, callIndex) => {
      if (callIndex <= 2) return { status: 409, text: 'conflict' };
      return { status: 200, body: sseBody([sseData('after-409')]) };
    }
  });
  const res = await streamVertexGenerateContent(baseConfig(), {
    model: 'gemini-3.8-flash',
    turns: [{ role: 'user', text: 'hi' }],
    onToken: () => {}
  }, fetchImpl);
  assert.equal(res.fullText, 'after-409');
});

test('streaming failure before any chunk falls back to generateContent, once', async () => {
  clearVertexTokenCache();
  const { fetchImpl, calls } = mockFetch({
    streamScript: () => ({ status: 404, text: 'not found' }),
    fallbackScript: () => ({
      candidates: [{ content: { parts: [{ text: 'fallback answer' }] } }]
    })
  });
  const tokens = [];
  const res = await streamVertexGenerateContent(baseConfig(), {
    model: 'gemini-3.8-flash',
    turns: [{ role: 'user', text: 'hi' }],
    onToken: (t) => tokens.push(t)
  }, fetchImpl);
  assert.equal(res.fullText, 'fallback answer');
  assert.deepEqual(tokens, ['fallback answer']);
  assert.ok(calls.fallback >= 1);
});

test('partial output is never duplicated: mid-stream failure does not fall back', async () => {
  clearVertexTokenCache();
  const { fetchImpl, calls } = mockFetch({
    streamScript: (region) => {
      if (region === 'global') return { status: 200, body: sseBody([sseData('part ')], { failAfter: 0 }) };
      return { status: 404, text: 'not found' };
    },
    fallbackScript: () => ({
      candidates: [{ content: { parts: [{ text: 'SHOULD NOT APPEAR' }] } }]
    })
  });
  const tokens = [];
  const res = await streamVertexGenerateContent(baseConfig(), {
    model: 'gemini-3.8-flash',
    turns: [{ role: 'user', text: 'hi' }],
    onToken: (t) => tokens.push(t)
  }, fetchImpl);
  assert.equal(res.fullText, 'part ');
  assert.deepEqual(tokens, ['part ']);
  assert.equal(calls.fallback, 0);
});

test('user cancel aborts a stalled hedge promptly', async () => {
  clearVertexTokenCache();
  const { fetchImpl } = mockFetch({
    streamScript: () => ({ status: 200, body: stalledBody() })
  });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  const started = Date.now();
  await assert.rejects(
    streamVertexGenerateContent(baseConfig(), {
      model: 'gemini-3.8-flash',
      turns: [{ role: 'user', text: 'hi' }],
      signal: ctrl.signal,
      onToken: () => {},
      onThought: () => {}
    }, fetchImpl),
    (err) => err && err.name === 'AbortError'
  );
  assert.ok(Date.now() - started < 5000, `cancel took ${Date.now() - started}ms, expected < 5000ms`);
});
