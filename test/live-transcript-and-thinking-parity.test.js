'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULTS } = require('../src/store');
const { geminiGenerationConfig } = require('../src/llm');
const { streamVertexGenerateContent } = require('../src/vertex-ai');

test('Unit 1: Store sessionInstructions default and persistence shape', () => {
  assert.equal(typeof DEFAULTS.sessionInstructions, 'string');
  assert.equal(DEFAULTS.sessionInstructions, '');
});

test('Unit 2: Gemini and Vertex includeThoughts configuration & live thinking streaming', async (t) => {
  await t.test('geminiGenerationConfig sets includeThoughts: true when requested', () => {
    // When includeThoughts: true is passed
    const cfgLow = geminiGenerationConfig({ system: 'sys', maxTokens: 500, thinkingLevel: 'LOW', includeThoughts: true });
    assert.deepEqual(cfgLow.thinkingConfig, { thinkingLevel: 'low', includeThoughts: true });

    const cfgSmart = geminiGenerationConfig({ system: 'sys', maxTokens: 1000, thinking: true, includeThoughts: true });
    assert.deepEqual(cfgSmart.thinkingConfig, { thinkingLevel: 'medium', includeThoughts: true });

    const cfgFast = geminiGenerationConfig({ system: 'sys', maxTokens: 500, thinking: false, includeThoughts: true });
    assert.deepEqual(cfgFast.thinkingConfig, { thinkingLevel: 'low', includeThoughts: true });
  });

  await t.test('src/llm.js wires includeThoughts: true into streamGemini and createLLM vertex branch', () => {
    const llmSrc = fs.readFileSync(path.join(__dirname, '..', 'src/llm.js'), 'utf8');
    assert.match(llmSrc, /geminiGenerationConfig\(\{[\s\S]*?includeThoughts:\s*true[\s\S]*?\}\)/);
    assert.match(llmSrc, /streamVertexGenerateContent\([\s\S]*?includeThoughts:\s*true/);
  });

  await t.test('Vertex AI streamVertexGenerateContent includes includeThoughts: true in thinkingConfig', async () => {
    const { privateKey: TEST_PRIVATE_KEY_PEM } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const SAMPLE_SA = JSON.stringify({
      type: 'service_account',
      project_id: 'cue-thinking-test',
      private_key_id: 'k1',
      private_key: TEST_PRIVATE_KEY_PEM,
      client_email: 'test@cue-thinking-test.iam.gserviceaccount.com',
      token_uri: 'https://oauth2.googleapis.com/token'
    });

    const capturedBodies = [];
    const mockFetch = async (url, init) => {
      if (url.includes('oauth2.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'ya29.vertex-test-token', expires_in: 3600 }),
        };
      }
      capturedBodies.push(JSON.parse(init.body));
      const sseBody = [
        'data: ' + JSON.stringify({
          candidates: [{
            content: {
              parts: [
                { thought: true, text: 'Reasoning step 1...' },
                { text: 'Final answer text' },
              ],
            },
          }],
        }),
        '',
      ].join('\n');
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseBody));
          controller.close();
        },
      });
      return { ok: true, status: 200, body: stream };
    };

    const receivedThoughts = [];
    const receivedTokens = [];

    const res = await streamVertexGenerateContent(
      {
        serviceAccountJson: SAMPLE_SA,
        projectId: 'cue-thinking-test',
        location: 'global',
        thinkingLevel: 'HIGH',
      },
      {
        model: 'gemini-3.8-flash',
        turns: [{ role: 'user', text: 'Hello' }],
        maxTokens: 512,
        onToken: (tok) => receivedTokens.push(tok),
        onThought: (th) => receivedThoughts.push(th),
      },
      mockFetch
    );

    assert.equal(capturedBodies.length, 1);
    assert.deepEqual(capturedBodies[0].generationConfig.thinkingConfig, {
      thinkingLevel: 'HIGH',
      includeThoughts: true
    });
    assert.deepEqual(receivedThoughts, ['Reasoning step 1...']);
    assert.deepEqual(receivedTokens, ['Final answer text']);
  });
});

test('Unit 3: Main process merges sessionInstructions and sessionDirectives into contextBlock', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSrc, /settingsForPrompt\.sessionInstructions/);
  assert.match(mainSrc, /activeInstructions/);
  assert.match(mainSrc, /ACTIVE SESSION DIRECTIVES & INSTRUCTIONS \(MUST FOLLOW FOR ALL RESPONSES\):/);
});

test('Unit 4: DOM Elements in renderer/index.html and Liquid Glass CSS in styles.css', () => {
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer/index.html'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer/styles.css'), 'utf8');

  // Live dual-speaker feed elements
  assert.match(htmlSrc, /id="live-transcript-feed"\s+class="live-transcript-feed"/);
  assert.match(htmlSrc, /id="live-transcript-turns"\s+class="live-transcript-turns"/);
  assert.match(htmlSrc, /id="live-interim-bubble"\s+class="live-interim-bubble hidden"/);

  // Verification that live-transcript-feed is inside panel-main before action-row
  const feedIdx = htmlSrc.indexOf('id="live-transcript-feed"');
  const actionRowIdx = htmlSrc.indexOf('id="action-row"');
  const messagesIdx = htmlSrc.indexOf('id="messages"');
  assert.ok(feedIdx > messagesIdx, 'live-transcript-feed must be after messages');
  assert.ok(feedIdx < actionRowIdx, 'live-transcript-feed must be before action-row');

  // Session instructions UI in Style settings
  assert.match(htmlSrc, /data-pane="style"/);
  assert.match(htmlSrc, /class="session-instructions-block"/);
  assert.match(htmlSrc, /id="session-instructions"/);
  assert.match(htmlSrc, /id="clear-session-instructions-btn"/);

  // CSS styling classes
  assert.match(cssSrc, /\.live-transcript-feed\s*\{/);
  assert.match(cssSrc, /\.live-turn\s*\{/);
  assert.match(cssSrc, /\.live-turn\.live-turn-you\s*\{/);
  assert.match(cssSrc, /\.live-turn\.live-turn-them\s*\{/);
  assert.match(cssSrc, /\.speaker-tag\s*\{/);
  assert.match(cssSrc, /\.speaker-tag\.you\s*\{/);
  assert.match(cssSrc, /\.speaker-tag\.them\s*\{/);
  assert.match(cssSrc, /\.turn-text\s*\{/);
  assert.match(cssSrc, /\.live-interim-bubble\s*\{/);
  assert.match(cssSrc, /\.session-instructions-block\s*\{/);
});

test('Unit 5: Renderer scrolling behavior during generation & dual-speaker transcript handlers', () => {
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer/renderer.js'), 'utf8');

  // Answer view starting at top
  assert.match(rendererSrc, /function startAi\([^\)]*\)\s*\{[\s\S]*?messages\.scrollTop = 0;/);
  assert.match(rendererSrc, /cue\.on\('llm:start'[\s\S]*?messages\.scrollTop = 0;/);

  // appendToken must NOT force auto-scroll to bottom during streaming
  const appendTokenMatch = rendererSrc.match(/function appendToken\(t\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(appendTokenMatch, 'appendToken must exist');
  assert.doesNotMatch(appendTokenMatch[1], /messages\.scrollTop\s*=\s*messages\.scrollHeight/, 'appendToken must not force messages.scrollTop to bottom');

  // llm:thought must NOT force messages container scroll
  const thoughtHandlerMatch = rendererSrc.match(/cue\.on\('llm:thought'[\s\S]*?bodyEl\.scrollTop\s*=\s*bodyEl\.scrollHeight;\s*\}\s*\}\);/);
  assert.ok(thoughtHandlerMatch, 'llm:thought handler must scroll internal bodyEl only');
  assert.doesNotMatch(thoughtHandlerMatch[0], /messages\.scrollTop\s*=\s*messages\.scrollHeight/);

  // Dual-speaker live transcript handlers
  assert.match(rendererSrc, /live-interim-bubble/);
  assert.match(rendererSrc, /speaker-tag \$\{channel\}/);
  assert.match(rendererSrc, /live-transcript-turns/);
  assert.match(rendererSrc, /live-turn live-turn-\$\{channel\}/);

  // Session instructions wiring
  assert.match(rendererSrc, /#session-instructions/);
  assert.match(rendererSrc, /settings\.sessionInstructions/);
  assert.match(rendererSrc, /#clear-session-instructions-btn/);
});
