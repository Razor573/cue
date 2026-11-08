const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveAntigravityWireModel,
  fetchAvailableModels,
  listAntigravityModels,
  streamAntigravity,
  askAntigravity,
  ANTIGRAVITY_MODEL_OPTIONS
} = require('../src/antigravity');

test('Step 10: resolveAntigravityWireModel maps Gemini 3.6/3.7/3.8 Flash to tiered wire IDs and 3.1 Pro to gemini-pro-agent', () => {
  assert.equal(resolveAntigravityWireModel('gemini-3.8-flash'), 'gemini-3.8-flash-tiered');
  assert.equal(resolveAntigravityWireModel('gemini-3.8-flash-preview'), 'gemini-3.8-flash-tiered');
  assert.equal(resolveAntigravityWireModel('gemini-3.7-flash'), 'gemini-3.7-flash-tiered');
  assert.equal(resolveAntigravityWireModel('gemini-3.6-flash'), 'gemini-3.6-flash-tiered');
  assert.equal(resolveAntigravityWireModel('gemini-3.1-pro-high'), 'gemini-pro-agent');
  assert.equal(resolveAntigravityWireModel('gemini-3.1-pro'), 'gemini-pro-agent');
  assert.equal(resolveAntigravityWireModel('gemini-3.5-flash'), 'gemini-3.5-flash');
});

test('Step 10: fetchAvailableModels and listAntigravityModels return ONLY live Gemini models when live fetch succeeds (retired curated IDs disappear)', async () => {
  const fakeAuth = {
    getValidAccessToken: async () => ({
      accessToken: 'ag-live-token',
      projectId: 'proj-live-123'
    })
  };

  const fakeFetch = async (url, init) => {
    assert.match(url, /fetchAvailableModels/);
    assert.equal(init.headers.Authorization, 'Bearer ag-live-token');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        models: {
          'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash' },
          'gemini-3.1-pro-high': { displayName: 'Gemini 3.1 Pro High' },
          'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6' } // non-Gemini ignored
        }
      })
    };
  };

  const result = await listAntigravityModels(fakeAuth, fakeFetch);
  assert.equal(result.live, true);
  const ids = result.models.map((m) => m.id);
  // Only live Gemini models are returned; curated-only models like gemini-3.5-flash are NOT merged in
  assert.deepEqual(ids, ['gemini-3.8-flash', 'gemini-3.1-pro-high']);
  const flashEntry = result.models.find((m) => m.id === 'gemini-3.8-flash');
  assert.equal(flashEntry.wireId, 'gemini-3.8-flash-tiered');
  const proEntry = result.models.find((m) => m.id === 'gemini-3.1-pro-high');
  assert.equal(proEntry.wireId, 'gemini-pro-agent');
});

test('Step 10: fetchAvailableModels falls back to curated ANTIGRAVITY_MODEL_OPTIONS when live fetch fails', async () => {
  const fakeAuth = {
    getValidAccessToken: async () => ({
      accessToken: 'ag-token',
      projectId: 'proj-123'
    })
  };

  const failingFetch = async () => ({
    ok: false,
    status: 503,
    text: async () => 'Service Unavailable'
  });

  const result = await fetchAvailableModels(fakeAuth, failingFetch);
  assert.equal(result.live, false);
  assert.equal(result.models.length, ANTIGRAVITY_MODEL_OPTIONS.length);
  assert.ok(result.models.some((m) => m.id === 'gemini-3.8-flash' && m.wireId === 'gemini-3.8-flash-tiered'));
});

test('Step 10: streamAntigravity and askAntigravity send the resolved wire model ID in the request body', async () => {
  const sentBodies = [];
  const fakeAuth = {
    getValidAccessToken: async () => ({
      accessToken: 'ag-token',
      projectId: 'proj-123'
    })
  };

  const fakeFetch = async (url, init) => {
    sentBodies.push(JSON.parse(init.body));
    const ssePayload = 'data: ' + JSON.stringify({
      response: {
        candidates: [
          { content: { parts: [{ text: 'Tiered wire model response' }] } }
        ]
      }
    }) + '\n\n';
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield Buffer.from(ssePayload, 'utf8');
      })()
    };
  };

  const tokens = [];
  const reply = await streamAntigravity({
    auth: fakeAuth,
    model: 'gemini-3.8-flash',
    system: 'Be concise.',
    turns: [{ role: 'user', text: 'Hello' }],
    onToken: (t) => tokens.push(t),
    fetchImpl: fakeFetch
  });

  assert.equal(reply, 'Tiered wire model response');
  assert.deepEqual(tokens, ['Tiered wire model response']);
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0].model, 'gemini-3.8-flash-tiered');

  const askReply = await askAntigravity({
    auth: fakeAuth,
    model: 'gemini-3.1-pro-high',
    system: 'Be concise.',
    turns: [{ role: 'user', text: 'Hello' }],
    fetchImpl: fakeFetch
  });
  assert.equal(askReply, 'Tiered wire model response');
  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[1].model, 'gemini-pro-agent');
});
