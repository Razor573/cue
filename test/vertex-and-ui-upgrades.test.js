const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  VERTEX_MODEL_OPTIONS,
  VERTEX_REGIONS,
  validateServiceAccountJson,
  getVertexAccessToken,
  clearVertexTokenCache,
  buildVertexEndpointUrl,
  listVertexModels,
  streamVertexGenerateContent,
} = require('../src/vertex-ai');
const { DEFAULTS, redactForRenderer } = require('../src/store');
const {
  DEFAULT_MODELS,
  PROVIDER_LABELS,
  PROVIDER_MODEL_CATALOG,
  createLLM,
  listProviderModels,
  testProviderConnection,
} = require('../src/llm');

// Generate an ephemeral RSA key pair once for JWT tests
const { privateKey: TEST_PRIVATE_KEY_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const SAMPLE_SA_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'cue-vertex-prod',
  private_key_id: 'key-123',
  private_key: TEST_PRIVATE_KEY_PEM,
  client_email: 'cue-runner@cue-vertex-prod.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

describe('Unit 1: src/vertex-ai.js core engine', () => {
  beforeEach(() => {
    clearVertexTokenCache();
  });

  it('exports curated Vertex model catalog and regions', () => {
    assert.ok(Array.isArray(VERTEX_MODEL_OPTIONS));
    assert.ok(VERTEX_MODEL_OPTIONS.length >= 3);
    assert.ok(VERTEX_MODEL_OPTIONS.some((m) => m.id === 'gemini-3-flash-preview'));
    assert.ok(VERTEX_MODEL_OPTIONS.some((m) => m.id === 'gemini-3.1-pro-preview'));
    assert.ok(Array.isArray(VERTEX_REGIONS));
    assert.ok(VERTEX_REGIONS.includes('global'));
    assert.ok(VERTEX_REGIONS.includes('us-central1'));
  });

  it('validates Service Account JSON and extracts client_email + project_id', () => {
    const valid = validateServiceAccountJson(SAMPLE_SA_JSON);
    assert.equal(valid.ok, true);
    assert.equal(valid.clientEmail, 'cue-runner@cue-vertex-prod.iam.gserviceaccount.com');
    assert.equal(valid.projectId, 'cue-vertex-prod');

    assert.throws(() => validateServiceAccountJson('{bad json'), /Invalid Service Account JSON/i);
    assert.throws(
      () => validateServiceAccountJson(JSON.stringify({ type: 'service_account', project_id: 'abc' })),
      /client_email/i
    );
  });

  it('builds global and regional Vertex AI endpoint URLs', () => {
    const globalUrl = buildVertexEndpointUrl({
      projectId: 'my-proj',
      location: 'global',
      model: 'gemini-3-flash-preview',
      action: 'streamGenerateContent',
      sse: true,
    });
    assert.equal(
      globalUrl,
      'https://aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/global/publishers/google/models/gemini-3-flash-preview:streamGenerateContent?alt=sse'
    );

    const regionalUrl = buildVertexEndpointUrl({
      projectId: 'my-proj',
      location: 'europe-west4',
      model: 'gemini-3.1-pro-preview',
      action: 'generateContent',
      sse: false,
    });
    assert.equal(
      regionalUrl,
      'https://europe-west4-aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/europe-west4/publishers/google/models/gemini-3.1-pro-preview:generateContent'
    );
  });

  it('signs RS256 JWT and exchanges Service Account credentials for a cached Bearer token', async () => {
    let fetchCalls = 0;
    const mockFetch = async (url, init) => {
      fetchCalls += 1;
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(init.method, 'POST');
      assert.match(init.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
      assert.match(init.body, /assertion=eyJ/);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'ya29.mock-vertex-sa-token',
          expires_in: 3600,
        }),
      };
    };

    const res1 = await getVertexAccessToken({ serviceAccountJson: SAMPLE_SA_JSON }, mockFetch);
    assert.equal(res1.token, 'ya29.mock-vertex-sa-token');
    assert.equal(res1.projectId, 'cue-vertex-prod');
    assert.equal(res1.authMode, 'service_account');
    assert.equal(fetchCalls, 1);

    // Second call uses in-memory token cache
    const res2 = await getVertexAccessToken({ serviceAccountJson: SAMPLE_SA_JSON }, mockFetch);
    assert.equal(res2.token, 'ya29.mock-vertex-sa-token');
    assert.equal(fetchCalls, 1);
  });

  it('streams SSE chunks, filters thinking parts, passes Google Search grounding, and fails over on 404', async () => {
    const requestedUrls = [];
    const capturedBodies = [];

    const sseBodyText = [
      'data: ' + JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { thought: true, text: 'Internal reasoning step...' },
              { text: 'Hello from ' },
            ],
          },
        }],
      }),
      '',
      'data: ' + JSON.stringify({
        candidates: [{
          content: {
            parts: [{ text: 'Vertex AI!' }],
          },
        }],
      }),
      '',
    ].join('\n');

    const mockFetch = async (url, init) => {
      if (url.includes('oauth2.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'ya29.vertex-stream-test', expires_in: 3600 }),
        };
      }
      requestedUrls.push(url);
      capturedBodies.push(JSON.parse(init.body));

      // Simulate 404 on first region (europe-west1) so it fails over to global
      if (requestedUrls.length === 1) {
        return {
          ok: false,
          status: 404,
          text: async () => 'Model not found in europe-west1',
        };
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseBodyText));
          controller.close();
        },
      });
      return {
        ok: true,
        status: 200,
        body: stream,
      };
    };

    const chunks = [];
    const res = await streamVertexGenerateContent(
      {
        serviceAccountJson: SAMPLE_SA_JSON,
        location: 'europe-west1',
        thinkingLevel: 'MEDIUM',
        webSearch: true,
      },
      {
        model: 'gemini-3-flash-preview',
        system: 'Be concise.',
        turns: [{ role: 'user', text: 'Test prompt' }],
        maxTokens: 512,
        onToken: (t) => chunks.push(t),
      },
      mockFetch
    );

    assert.equal(res.fullText, 'Hello from Vertex AI!');
    assert.equal(res.region, 'global');
    assert.deepEqual(chunks, ['Hello from ', 'Vertex AI!']);
    assert.equal(requestedUrls.length, 2);
    assert.match(requestedUrls[0], /europe-west1-aiplatform\.googleapis\.com/);
    assert.match(requestedUrls[1], /aiplatform\.googleapis\.com\/v1beta1\/projects\/cue-vertex-prod\/locations\/global/);
    assert.deepEqual(capturedBodies[0].generationConfig.thinkingConfig, { thinkingLevel: 'MEDIUM' });
    assert.deepEqual(capturedBodies[0].tools, [{ googleSearch: {} }]);
  });
});

describe('Unit 1 & 2: Store redaction and LLM router integration', () => {
  it('includes vertex defaults and exposes vertexKeyEmail + hasKey.vertex', () => {
    assert.equal(DEFAULTS.vertexLocation, 'global');
    assert.equal(DEFAULTS.vertexWebSearch, false);
    assert.ok(DEFAULTS.models.vertex);

    const raw = {
      ...DEFAULTS,
      provider: 'vertex',
      apiKeys: {
        ...DEFAULTS.apiKeys,
        vertex: SAMPLE_SA_JSON,
      },
    };
    const safe = redactForRenderer(raw);
    assert.equal(safe.hasKey.vertex, true);
    assert.equal(safe.vertexKeyEmail, 'cue-runner@cue-vertex-prod.iam.gserviceaccount.com');
  });

  it('registers vertex in DEFAULT_MODELS, PROVIDER_LABELS, PROVIDER_MODEL_CATALOG, and createLLM', () => {
    assert.equal(PROVIDER_LABELS.vertex, 'Vertex AI');
    assert.ok(DEFAULT_MODELS.vertex.fast);
    assert.ok(DEFAULT_MODELS.vertex.smart);
    assert.ok(PROVIDER_MODEL_CATALOG.vertex);
    assert.ok(Array.isArray(PROVIDER_MODEL_CATALOG.vertex.all));

    const llm = createLLM({
      provider: 'vertex',
      vertexProject: 'cue-vertex-prod',
      vertexLocation: 'global',
      apiKeys: { vertex: SAMPLE_SA_JSON },
    });
    assert.equal(llm.ready, true);
    assert.equal(typeof llm.stream, 'function');
  });

  it('listProviderModels returns curated fallback when no live key is configured', async () => {
    const res = await listProviderModels({ provider: 'openai', apiKeys: { openai: '' } });
    assert.equal(res.live, false);
    assert.ok(Array.isArray(res.models));
    assert.ok(res.models.some((m) => m.id === 'gpt-4o-mini'));
  });

  it('testProviderConnection validates Vertex AI and returns latency + modelCount', async () => {
    clearVertexTokenCache();
    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'ya29.test-conn', expires_in: 3600 }),
        };
      }
      if (url.includes('/publishers/google/models?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            publisherModels: [{ name: 'publishers/google/models/gemini-3.8-flash' }],
          }),
        };
      }
      const sse = 'data: ' + JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'OK' }] } }],
      }) + '\n\n';
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(sse));
            c.close();
          },
        }),
      };
    };

    const result = await testProviderConnection(
      {
        provider: 'vertex',
        vertexProject: 'cue-vertex-prod',
        vertexLocation: 'global',
        apiKeys: { vertex: SAMPLE_SA_JSON },
      },
      {},
      mockFetch
    );
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'vertex');
    assert.equal(result.reply, 'OK');
    assert.equal(typeof result.latencyMs, 'number');
  });
});

describe('Unit 3: SpecterAI Liquid Glass UI & Profile Tab wiring', () => {
  const root = path.join(__dirname, '..');
  const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf-8');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf-8');
  const rendererJs = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf-8');
  const preloadJs = fs.readFileSync(path.join(root, 'preload.js'), 'utf-8');
  const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf-8');

  it('applies SpecterAI 2026 Liquid Glass tokens and backdrop blur in renderer/styles.css', () => {
    assert.match(css, /--bg-color:\s*rgba\(13,\s*16,\s*24,\s*0\.86\)/);
    assert.match(css, /--accent:\s*#5B8AF5/);
    assert.match(css, /--specular-top:/);
    assert.match(css, /backdrop-filter:\s*blur\(28px\)\s*saturate\(180%\)/);
  });

  it('wires Vertex AI provider, model selectors, test connection, and Profile tab in HTML & renderer.js', () => {
    assert.match(html, /data-provider="vertex"/);
    assert.match(html, /id="vertex-row"/);
    assert.match(html, /id="model-fast-select"/);
    assert.match(html, /id="model-smart-select"/);
    assert.match(html, /id="test-connection-btn"/);
    assert.match(html, /data-tab="profile"/);
    assert.match(html, /id="tab-profile"/);
    assert.match(html, /id="profile-resume"/);
    assert.match(html, /id="profile-jd"/);
    assert.match(html, /id="profile-star"/);

    assert.match(rendererJs, /populateModelSelects/);
    assert.match(rendererJs, /runConnectionTest/);
    assert.match(rendererJs, /parseVertexServiceAccount/);
    assert.match(preloadJs, /listModels:/);
    assert.match(preloadJs, /testConnection:/);
    assert.match(preloadJs, /parseVertexServiceAccount:/);
    assert.match(mainJs, /ipcMain\.handle\('models:list'/);
    assert.match(mainJs, /ipcMain\.handle\('llm:test-connection'/);
    assert.match(mainJs, /ipcMain\.handle\('vertex:parse-sa'/);
  });
});
