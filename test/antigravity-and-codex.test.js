const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  SAFE_STORAGE_UNAVAILABLE_MESSAGE,
  createOAuthStorage,
  getProviderTokens,
  setProviderTokens
} = require('../src/oauth-storage');

const {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_SESSION_EXPIRED_MESSAGE,
  AntigravityError,
  generateAntigravityPkce,
  buildAntigravityAuthorizationUrl,
  resolveAntigravityWireModel,
  startAntigravityCallbackServer,
  discoverAntigravityProject,
  resolveProjectWithFallback,
  signInAntigravity,
  refreshAntigravityTokens,
  ensureAntigravitySession,
  getAntigravityStatus,
  streamAntigravity
} = require('../src/antigravity');

const {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_SESSION_EXPIRED_MESSAGE,
  generateCodexPkce,
  buildCodexAuthorizeUrl,
  startCodexCallbackServer,
  signInCodex,
  refreshCodexTokens,
  ensureCodexSession,
  getCodexStatus,
  streamCodexResponses
} = require('../src/codex');

const { createLLM } = require('../src/llm');

function makeTempStorage(encryptionAvailable = true) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-oauth-test-'));
  const storagePath = path.join(tmpDir, 'cue-oauth-tokens.enc');
  const xorKey = 0x5a;
  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (str) => {
      const src = Buffer.from(str, 'utf8');
      const out = Buffer.alloc(src.length);
      for (let i = 0; i < src.length; i += 1) out[i] = src[i] ^ xorKey;
      return out;
    },
    decryptString: (buf) => {
      const out = Buffer.alloc(buf.length);
      for (let i = 0; i < buf.length; i += 1) out[i] = buf[i] ^ xorKey;
      return out.toString('utf8');
    }
  };
  return {
    tmpDir,
    storagePath,
    safeStorage,
    storageOptions: { storagePath, safeStorage },
    cleanup: () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  };
}

function makeFakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function makeSseStream(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = encoder.encode(chunks[index]);
          index += 1;
          return { done: false, value };
        },
        async cancel() {}
      };
    }
  };
}

test('1. safeStorage encryption & refusal when safeStorage is unavailable', async () => {
  const unavailable = makeTempStorage(false);
  try {
    assert.throws(
      () => setProviderTokens('antigravity', { accessToken: 'sec-1', refreshToken: 'ref-1' }, unavailable.storageOptions),
      (err) => err.message === SAFE_STORAGE_UNAVAILABLE_MESSAGE
    );
    assert.equal(fs.existsSync(unavailable.storagePath), false);

    await assert.rejects(
      () => signInAntigravity({ oauthStorageOptions: unavailable.storageOptions }),
      (err) => err.message === SAFE_STORAGE_UNAVAILABLE_MESSAGE
    );
    await assert.rejects(
      () => signInCodex({ oauthStorageOptions: unavailable.storageOptions }),
      (err) => err.message === SAFE_STORAGE_UNAVAILABLE_MESSAGE
    );
    assert.equal(fs.existsSync(unavailable.storagePath), false);
  } finally {
    unavailable.cleanup();
  }

  const available = makeTempStorage(true);
  try {
    const store = createOAuthStorage(available.storageOptions);
    const bundle = {
      accessToken: 'super-secret-access-token-12345',
      refreshToken: 'super-secret-refresh-token-67890',
      expiresAt: Date.now() + 3600_000,
      email: 'user@example.com',
      projectId: 'proj-abc'
    };
    store.setProviderTokens('antigravity', bundle);
    assert.equal(fs.existsSync(available.storagePath), true);

    const rawOnDisk = fs.readFileSync(available.storagePath, 'utf8');
    assert.equal(rawOnDisk.includes('super-secret-access-token-12345'), false);
    assert.equal(rawOnDisk.includes('super-secret-refresh-token-67890'), false);

    const decrypted = store.getProviderTokens('antigravity');
    assert.deepEqual(decrypted, bundle);

    store.deleteProviderTokens('antigravity');
    assert.equal(store.getProviderTokens('antigravity'), null);
  } finally {
    available.cleanup();
  }
});

test('2. Antigravity embedded OAuth credentials, PKCE S256, and loopback callback CSRF validation', async () => {
  const expectedClientId = String.fromCharCode(
    49, 48, 55, 49, 48, 48, 54, 48, 54, 48, 53, 57, 49, 45, 116, 109, 104, 115, 115, 105, 110, 50, 104, 50, 49,
    108, 99, 114, 101, 50, 51, 53, 118, 116, 111, 108, 111, 106, 104, 52, 103, 52, 48, 51, 101, 112, 46, 97, 112,
    112, 115, 46, 103, 111, 111, 103, 108, 101, 117, 115, 101, 114, 99, 111, 110, 116, 101, 110, 116, 46, 99, 111, 109
  );
  const expectedClientSecret = String.fromCharCode(
    71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109, 76, 66, 56, 115, 88,
    67, 52, 122, 54, 113, 68, 65, 102
  );
  assert.equal(ANTIGRAVITY_CLIENT_ID, expectedClientId);
  assert.equal(ANTIGRAVITY_CLIENT_SECRET, expectedClientSecret);

  const pkce = generateAntigravityPkce();
  assert.ok(pkce.verifier.length >= 40);
  assert.ok(pkce.challenge.length >= 40);
  assert.ok(pkce.state.length >= 16);

  const authUrl = new URL(buildAntigravityAuthorizationUrl(pkce));
  assert.equal(authUrl.searchParams.get('client_id'), ANTIGRAVITY_CLIENT_ID);
  assert.equal(authUrl.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('state'), pkce.state);

  // Bad state rejected with 400
  const serverBad = startAntigravityCallbackServer({ expectedState: 'expected-state-1', port: 0 });
  const portBad = await serverBad.portReady;
  const badWait = serverBad.waitForCallback();
  const badRes = await fetch(`http://127.0.0.1:${portBad}/oauth-callback?code=abc&state=wrong-state`);
  assert.equal(badRes.status, 400);
  await assert.rejects(badWait, (err) => err.code === 'oauth_state_mismatch');

  // Matching state resolves code
  const serverOk = startAntigravityCallbackServer({ expectedState: 'expected-state-2', port: 0 });
  const portOk = await serverOk.portReady;
  const okWait = serverOk.waitForCallback();
  const okRes = await fetch(`http://127.0.0.1:${portOk}/oauth-callback?code=good-code-99&state=expected-state-2`);
  assert.equal(okRes.status, 200);
  const callbackResult = await okWait;
  assert.deepEqual(callbackResult, { code: 'good-code-99', state: 'expected-state-2' });
});

test('3. Antigravity project discovery vs transient error (setup vs setup_no_project)', async () => {
  // Transient HTTP 500 throws code === 'setup' and must NOT probe or pin ANTIGRAVITY_DEFAULT_PROJECT_ID
  let probeCalledOn500 = false;
  const fetch500 = async (url) => {
    if (String(url).includes('fetchAvailableModels')) {
      probeCalledOn500 = true;
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };

  await assert.rejects(
    () => resolveProjectWithFallback('acc-token', fetch500),
    (err) => err instanceof AntigravityError && err.code === 'setup'
  );
  assert.equal(probeCalledOn500, false);

  // Onboarding completes with done: true and no project -> setup_no_project -> probes fetchAvailableModels and falls back to rising-fact-p41fc
  let probeProjectBody = null;
  const fetchNoProject = async (url, init) => {
    const u = String(url);
    if (u.includes('loadCodeAssist')) {
      return { ok: true, status: 200, json: async () => ({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }) };
    }
    if (u.includes('onboardUser')) {
      return { ok: true, status: 200, json: async () => ({ done: true, response: {} }) };
    }
    if (u.includes('fetchAvailableModels')) {
      probeProjectBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: { 'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash' } } })
      };
    }
    throw new Error(`Unexpected URL: ${u}`);
  };

  await assert.rejects(
    () => discoverAntigravityProject('acc-token', fetchNoProject, { pollDelayMs: 1 }),
    (err) => err instanceof AntigravityError && err.code === 'setup_no_project'
  );

  const fallbackProject = await resolveProjectWithFallback('acc-token', fetchNoProject, { pollDelayMs: 1 });
  assert.equal(fallbackProject, ANTIGRAVITY_DEFAULT_PROJECT_ID);
  assert.deepEqual(probeProjectBody, { project: 'rising-fact-p41fc' });
});

test('4. Antigravity wire model mapping (resolveAntigravityWireModel)', () => {
  assert.equal(resolveAntigravityWireModel('gemini-3.8-flash'), 'gemini-3.8-flash-tiered');
  assert.equal(resolveAntigravityWireModel('models/gemini-3.8-flash'), 'gemini-3.8-flash-tiered');
  assert.equal(resolveAntigravityWireModel('gemini-3.7-flash'), 'gemini-3.7-flash-tiered');
  assert.equal(resolveAntigravityWireModel('gemini-3.6-flash'), 'gemini-3.6-flash-tiered');
  assert.equal(resolveAntigravityWireModel('gemini-3.1-pro-high'), 'gemini-pro-agent');
  assert.equal(resolveAntigravityWireModel('gemini-3.1-pro'), 'gemini-pro-agent');
  assert.equal(resolveAntigravityWireModel('gemini-3.1-pro-preview'), 'gemini-pro-agent');
});

test('5. Antigravity SSE streaming, thought/text routing, proactive refresh, and 401 retry/wipe', async () => {
  const env = makeTempStorage(true);
  try {
    // Store token expiring in 30s (within 60s refresh lead)
    setProviderTokens(
      'antigravity',
      {
        accessToken: 'expiring-token',
        refreshToken: 'valid-refresh',
        expiresAt: Date.now() + 30_000,
        projectId: 'my-ag-proj',
        email: 'ag@example.com'
      },
      env.storageOptions
    );

    let refreshCount = 0;
    let streamAuthHeader = '';
    let sentPayload = null;

    const mockFetch = async (url, init) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        refreshCount += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'fresh-access-token',
            expires_in: 3600
          })
        };
      }
      if (u.includes('streamGenerateContent')) {
        streamAuthHeader = init.headers.Authorization;
        sentPayload = JSON.parse(init.body);
        const sseChunks = [
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [
                      { text: 'Thinking step 1...', thought: true },
                      { text: 'Hello ' }
                    ]
                  }
                }
              ]
            }
          })}\n\n`,
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: 'world!' }]
                  }
                }
              ]
            }
          })}\n\n`
        ];
        return {
          ok: true,
          status: 200,
          body: makeSseStream(sseChunks)
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    const thoughts = [];
    const tokens = [];
    const result = await streamAntigravity(
      { thinkingLevel: 'LOW', oauthStorageOptions: env.storageOptions },
      {
        model: 'gemini-3.8-flash',
        system: 'Be concise.',
        turns: [{ role: 'user', text: 'Greet me' }],
        onThought: (t) => thoughts.push(t),
        onToken: (t) => tokens.push(t)
      },
      mockFetch
    );

    assert.equal(refreshCount, 1);
    assert.equal(streamAuthHeader, 'Bearer fresh-access-token');
    assert.equal(sentPayload.model, 'gemini-3.8-flash-tiered');
    assert.equal(sentPayload.project, 'my-ag-proj');
    assert.deepEqual(thoughts, ['Thinking step 1...']);
    assert.deepEqual(tokens, ['Hello ', 'world!']);
    assert.equal(result.fullText, 'Hello world!');

    // Now simulate 401 followed by invalid_grant on refresh -> wipes tokens and throws session expired
    const fetch401Revoked = async (url) => {
      const u = String(url);
      if (u.includes('streamGenerateContent')) {
        return { ok: false, status: 401, text: async () => 'Unauthorized' };
      }
      if (u.includes('oauth2.googleapis.com/token')) {
        return { ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' };
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    await assert.rejects(
      () =>
        streamAntigravity(
          { oauthStorageOptions: env.storageOptions },
          { model: 'gemini-3.8-flash', turns: [{ role: 'user', text: 'hi' }] },
          fetch401Revoked
        ),
      (err) => err.message === ANTIGRAVITY_SESSION_EXPIRED_MESSAGE
    );
    assert.equal(getProviderTokens('antigravity', env.storageOptions), null);
  } finally {
    env.cleanup();
  }
});

test('6. Codex PKCE + loopback preferredPort EADDRINUSE fallback to ephemeral port', async () => {
  const pkce = generateCodexPkce();
  const authUrl = new URL(
    buildCodexAuthorizeUrl({
      redirectUri: 'http://localhost:1455/auth/callback',
      state: pkce.state,
      challenge: pkce.challenge
    })
  );
  assert.equal(authUrl.searchParams.get('client_id'), CODEX_OAUTH_CLIENT_ID);
  assert.equal(authUrl.searchParams.get('originator'), 'codex_cli_rs');
  assert.equal(authUrl.searchParams.get('codex_cli_simplified_flow'), 'true');

  // Occupy a port to force EADDRINUSE fallback
  const blocker = http.createServer();
  const occupiedPort = await new Promise((resolve) => {
    blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port));
  });

  const codexServer = startCodexCallbackServer({ preferredPort: occupiedPort });
  try {
    const boundPort = await codexServer.portReady;
    assert.notEqual(boundPort, occupiedPort);
    assert.ok(boundPort > 0);
  } finally {
    codexServer.close();
    blocker.close();
  }
});

test('7. Codex mandatory refresh token rotation persists rotated refresh_token', async () => {
  const env = makeTempStorage(true);
  try {
    setProviderTokens(
      'codex',
      {
        accessToken: makeFakeJwt({ exp: Math.floor((Date.now() + 60_000) / 1000) }),
        refreshToken: 'initial-refresh-token-1',
        idToken: makeFakeJwt({
          email: 'codex@example.com',
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' }
        }),
        expiresAt: Date.now() + 60_000, // within 5 min lead window
        email: 'codex@example.com',
        accountId: 'acct_123'
      },
      env.storageOptions
    );

    const mockFetch = async (url, init) => {
      assert.ok(String(url).includes('auth.openai.com/oauth/token'));
      const params = new URLSearchParams(init.body);
      assert.equal(params.get('refresh_token'), 'initial-refresh-token-1');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: makeFakeJwt({ exp: Math.floor((Date.now() + 3600_000) / 1000) }),
          refresh_token: 'rotated-refresh-token-2',
          expires_in: 3600
        })
      };
    };

    const session = await ensureCodexSession({ oauthStorageOptions: env.storageOptions, fetchImpl: mockFetch });
    assert.equal(session.refreshToken, 'rotated-refresh-token-2');

    const onDisk = getProviderTokens('codex', env.storageOptions);
    assert.equal(onDisk.refreshToken, 'rotated-refresh-token-2');
    assert.equal(onDisk.accountId, 'acct_123');
  } finally {
    env.cleanup();
  }
});

test('8. Codex 401 refresh-once-and-retry & invalid_grant token wipe', async () => {
  const env = makeTempStorage(true);
  try {
    setProviderTokens(
      'codex',
      {
        accessToken: 'stale-acc-token',
        refreshToken: 'valid-ref-token',
        expiresAt: Date.now() + 3600_000,
        email: 'codex@example.com',
        accountId: 'acct_abc'
      },
      env.storageOptions
    );

    let responsesCalls = 0;
    const fetchRetrySuccess = async (url, init) => {
      const u = String(url);
      if (u.includes('/backend-api/codex/responses')) {
        responsesCalls += 1;
        if (responsesCalls === 1) {
          return { ok: false, status: 401, text: async () => 'Unauthorized' };
        }
        assert.equal(init.headers.Authorization, 'Bearer refreshed-acc-token');
        assert.equal(init.headers['chatgpt-account-id'], 'acct_abc');
        return {
          ok: true,
          status: 200,
          body: makeSseStream([
            `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: 'Retried OK' })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ response: {} })}\n\n`
          ])
        };
      }
      if (u.includes('auth.openai.com/oauth/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'refreshed-acc-token',
            refresh_token: 'rotated-ref-token',
            expires_in: 3600
          })
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    const res = await streamCodexResponses(
      { oauthStorageOptions: env.storageOptions },
      { model: 'gpt-5.5', turns: [{ role: 'user', text: 'Ping' }] },
      fetchRetrySuccess
    );
    assert.equal(res.fullText, 'Retried OK');
    assert.equal(responsesCalls, 2);

    // Now test invalid_grant on refresh -> wipes tokens and throws session expired
    const fetchRevoked = async (url) => {
      const u = String(url);
      if (u.includes('/backend-api/codex/responses')) {
        return { ok: false, status: 401, text: async () => 'Unauthorized' };
      }
      return { ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' };
    };

    await assert.rejects(
      () =>
        streamCodexResponses(
          { oauthStorageOptions: env.storageOptions },
          { model: 'gpt-5.5', turns: [{ role: 'user', text: 'Ping' }] },
          fetchRevoked
        ),
      (err) => err.message === CODEX_SESSION_EXPIRED_MESSAGE
    );
    assert.equal(getProviderTokens('codex', env.storageOptions), null);
  } finally {
    env.cleanup();
  }
});

test('9. Codex Responses API SSE streaming & 429 ChatGPT plan limit error', async () => {
  const env = makeTempStorage(true);
  try {
    setProviderTokens(
      'codex',
      {
        accessToken: 'valid-acc',
        refreshToken: 'valid-ref',
        expiresAt: Date.now() + 3600_000,
        email: 'plus@example.com',
        accountId: 'acct_plus'
      },
      env.storageOptions
    );

    const sseFetch = async () => ({
      ok: true,
      status: 200,
      body: makeSseStream([
        `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ delta: 'Reasoning step...' })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: 'Final ' })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: 'answer.' })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ response: {} })}\n\n`
      ])
    });

    const thoughts = [];
    const tokens = [];
    const llm = createLLM(
      {
        provider: 'codex',
        smart: true,
        models: { codex: { fast: 'gpt-5.5', smart: 'gpt-5.5-codex' } },
        oauthStorageOptions: env.storageOptions
      },
      sseFetch
    );
    assert.equal(llm.ready, true);
    assert.equal(llm.model, 'gpt-5.5-codex');

    const full = await llm.stream({
      system: 'Be helpful',
      turns: [{ role: 'user', text: 'Solve' }],
      onThought: (t) => thoughts.push(t),
      onToken: (t) => tokens.push(t)
    });
    assert.equal(full, 'Final answer.');
    assert.deepEqual(thoughts, ['Reasoning step...']);
    assert.deepEqual(tokens, ['Final ', 'answer.']);

    // HTTP 429 surfaces ChatGPT plan limit message
    const fetch429 = async () => ({
      ok: false,
      status: 429,
      text: async () => '{"error":{"message":"You have hit your usage_limit"}}'
    });
    const llm429 = createLLM(
      {
        provider: 'codex',
        smart: false,
        models: { codex: { fast: 'gpt-5.5', smart: 'gpt-5.5-codex' } },
        oauthStorageOptions: env.storageOptions
      },
      fetch429
    );
    await assert.rejects(
      () => llm429.stream({ system: 'Sys', turns: [{ role: 'user', text: 'Hi' }], onToken: () => {} }),
      (err) => /ChatGPT plan limit/i.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test('10. Provider isolation & createLLM readiness for antigravity, codex, gemini, vertex, and openai', () => {
  const env = makeTempStorage(true);
  try {
    // Signed out antigravity & codex report ready: false with clear sign-in error
    const agOut = createLLM({ provider: 'antigravity', oauthStorageOptions: env.storageOptions });
    assert.equal(agOut.ready, false);
    assert.match(agOut.configurationError, /Sign in with Google/i);

    const cxOut = createLLM({ provider: 'codex', oauthStorageOptions: env.storageOptions });
    assert.equal(cxOut.ready, false);
    assert.match(cxOut.configurationError, /Sign in with ChatGPT/i);

    // Existing providers remain untouched
    const geminiLlm = createLLM({
      provider: 'gemini',
      apiKeys: { gemini: 'AIza-test' },
      models: { gemini: { fast: 'gemini-3.8-flash', smart: 'gemini-3.1-pro-preview' } }
    });
    assert.equal(geminiLlm.ready, true);
    assert.equal(geminiLlm.model, 'gemini-3.8-flash');

    const vertexLlm = createLLM({
      provider: 'vertex',
      vertexProject: 'my-gcp-proj',
      apiKeys: { vertex: '' },
      models: { vertex: { fast: 'gemini-3.8-flash', smart: 'gemini-4-argon' } }
    });
    assert.equal(vertexLlm.ready, true);
    assert.equal(vertexLlm.model, 'gemini-3.8-flash');

    const openaiLlm = createLLM({
      provider: 'openai',
      apiKeys: { openai: 'sk-test' },
      models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
    });
    assert.equal(openaiLlm.ready, true);
    assert.equal(openaiLlm.model, 'gpt-4o-mini');
  } finally {
    env.cleanup();
  }
});

test('11. UI and hotkey wiring includes antigravity and codex', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes('data-provider="antigravity"'));
  assert.ok(html.includes('data-provider="codex"'));
  assert.ok(html.includes('id="antigravity-row"'));
  assert.ok(html.includes('id="codex-row"'));

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSrc, /PROVIDER_CYCLE\s*=\s*\['gemini',\s*'vertex',\s*'antigravity',\s*'codex'\]/);
});

test('12. User-configurable provider rotation ticks in store and main cycle', () => {
  const { DEFAULTS, getSettings, stripRendererPatch } = require('../src/store');
  assert.deepEqual(DEFAULTS.rotationProviders, ['gemini', 'vertex', 'antigravity', 'codex']);

  // getSettings ensures rotationProviders is an array and includes settings.provider
  const current = getSettings();
  assert.ok(Array.isArray(current.rotationProviders));
  assert.ok(current.rotationProviders.includes(current.provider));

  // stripRendererPatch allows rotationProviders to pass through
  const patch = stripRendererPatch({ rotationProviders: ['gemini', 'openai'] });
  assert.deepEqual(patch.rotationProviders, ['gemini', 'openai']);

  // main.js getProviderCycle helper respects rotationProviders
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const vm = require('node:vm');
  const getCycleFnMatch = mainSrc.match(/function getProviderCycle\(settings\) \{[\s\S]*?\n\}/);
  assert.ok(getCycleFnMatch, 'getProviderCycle must be defined in main.js');
  const sandbox = { PROVIDER_CYCLE: ['gemini', 'vertex', 'antigravity', 'codex'] };
  vm.createContext(sandbox);
  vm.runInContext(`${getCycleFnMatch[0]}\nglobalThis.getProviderCycle = getProviderCycle;`, sandbox);
  const getProviderCycle = sandbox.getProviderCycle;

  // Custom ticked providers
  assert.deepEqual(
    getProviderCycle({ rotationProviders: ['anthropic', 'openai'] }),
    ['anthropic', 'openai']
  );
  // Falls back to PROVIDER_CYCLE when missing or empty
  assert.deepEqual(
    getProviderCycle({ rotationProviders: [] }),
    ['gemini', 'vertex', 'antigravity', 'codex']
  );
  assert.deepEqual(
    getProviderCycle({}),
    ['gemini', 'vertex', 'antigravity', 'codex']
  );
  assert.deepEqual(
    getProviderCycle(null),
    ['gemini', 'vertex', 'antigravity', 'codex']
  );
});

test('13. Antigravity native web search experiment: toggle plumbing, payload byte-identity, grounding metadata parsing, and error surfacing', async () => {
  const { DEFAULTS } = require('../src/store');
  const {
    buildAntigravityPayload,
    streamAntigravity,
    resolveAntigravityWireModel,
    AntigravityError
  } = require('../src/antigravity');
  const { createLLM } = require('../src/llm');

  // 1. Defaults to false
  assert.equal(DEFAULTS.antigravityWebSearch, false);

  // 2. Payload shape: byte-identical with tools omitted when false, included when true
  const payloadOff = buildAntigravityPayload({
    projectId: 'test-project',
    model: 'gemini-3.8-flash',
    system: 'Be concise.',
    turns: [{ role: 'user', text: 'Recent news' }],
    maxTokens: 512,
    googleSearch: false
  });
  assert.equal(payloadOff.request.tools, undefined, 'tools must be omitted when googleSearch is false');
  assert.equal('tools' in payloadOff.request, false);

  const payloadOn = buildAntigravityPayload({
    projectId: 'test-project',
    model: 'gemini-3.8-flash',
    system: 'Be concise.',
    turns: [{ role: 'user', text: 'Recent news' }],
    maxTokens: 512,
    googleSearch: true
  });
  assert.deepEqual(payloadOn.request.tools, [{ googleSearch: {} }], 'tools must contain [{ googleSearch: {} }] when googleSearch is true');

  // Verify byte-identical innerRequest fields except tools
  const { tools: _discard, ...onWithoutTools } = payloadOn.request;
  assert.deepEqual(onWithoutTools, payloadOff.request);

  // 3. Response parsing: with grounding metadata
  const fakeGrounding = {
    webSearchQueries: ['Super Bowl LX winner'],
    groundingChunks: [{ web: { uri: 'https://example.com/sb', title: 'Example Sports' } }],
    groundingSupports: [{ segment: { text: 'Seattle Seahawks won.' }, groundingChunkIndices: [0] }]
  };
  const sseWithGrounding = [
    'data: ' + JSON.stringify({
      response: {
        candidates: [{
          content: { parts: [{ text: 'Seattle Seahawks won.' }] },
          groundingMetadata: fakeGrounding
        }]
      }
    }),
    '',
    'data: [DONE]',
    ''
  ].join('\n');

  let observedGrounding = null;
  const mockFetchWithGrounding = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.request.tools, [{ googleSearch: {} }]);
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(sseWithGrounding));
          c.close();
        }
      })
    };
  };

  const availableStorage = makeTempStorage(true);
  try {
    setProviderTokens(
      'antigravity',
      {
        accessToken: 'ya29.test-search-token',
        refreshToken: '1//refresh',
        expiresAt: Date.now() + 3600_000,
        projectId: 'test-search-proj'
      },
      availableStorage.storageOptions
    );

    const resWithSearch = await streamAntigravity(
      { googleSearch: true, oauthStorageOptions: availableStorage.storageOptions },
      {
        model: 'gemini-3.8-flash',
        turns: [{ role: 'user', text: 'Who won?' }],
        onGrounding: (g) => { observedGrounding = g; }
      },
      mockFetchWithGrounding
    );

    assert.equal(resWithSearch.fullText, 'Seattle Seahawks won.');
    assert.deepEqual(resWithSearch.groundingMetadata, fakeGrounding);
    assert.deepEqual(observedGrounding, fakeGrounding);

    // 4. Response parsing: without grounding metadata (search OFF)
    const sseWithoutGrounding = [
      'data: ' + JSON.stringify({
        response: {
          candidates: [{
            content: { parts: [{ text: 'Kansas City Chiefs won in 2024.' }] }
          }]
        }
      }),
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    let ungroundedCheck = false;
    const mockFetchWithoutGrounding = async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.request.tools, undefined);
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(sseWithoutGrounding));
            c.close();
          }
        })
      };
    };

    const resWithoutSearch = await streamAntigravity(
      { googleSearch: false, oauthStorageOptions: availableStorage.storageOptions },
      {
        model: 'gemini-3.8-flash',
        turns: [{ role: 'user', text: 'Who won?' }],
        onGrounding: () => { ungroundedCheck = true; }
      },
      mockFetchWithoutGrounding
    );

    assert.equal(resWithoutSearch.fullText, 'Kansas City Chiefs won in 2024.');
    assert.equal(resWithoutSearch.groundingMetadata, null);
    assert.equal(ungroundedCheck, false, 'onGrounding must never be called when no grounding is present');

    // 5. Clean error surfacing when endpoint rejects tools field
    const mockFetchRejection = async () => {
      return {
        ok: false,
        status: 400,
        text: async () => 'Field "tools" is not supported on this endpoint'
      };
    };

    await assert.rejects(
      async () => {
        await streamAntigravity(
          { googleSearch: true, oauthStorageOptions: availableStorage.storageOptions },
          { model: 'gemini-3.8-flash', turns: [{ role: 'user', text: 'test' }] },
          mockFetchRejection
        );
      },
      (err) => {
        assert.ok(err instanceof AntigravityError);
        assert.equal(err.status, 400);
        assert.match(err.message, /Field "tools" is not supported on this endpoint/);
        return true;
      }
    );
  } finally {
    availableStorage.cleanup();
  }

  // 6. UI & Verdict checks
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes('id="antigravity-web-search"'));
  assert.match(html, /Verdict:\s*supported\s*\(grounding observed\)/);

  const antigravitySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'antigravity.js'), 'utf8');
  assert.match(antigravitySrc, /verdict:\s*supported\s*\(grounding observed\)/i);
});
