const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../src/store');
const { geminiGenerationConfig, listGeminiSTTModels, GEMINI_STT_MODELS } = require('../src/llm');
const { buildSystem } = require('../src/prompts');

test('Unit 1: store.js defaults thinking levels and sttModel', () => {
  const defaults = store.DEFAULTS;
  assert.equal(defaults.geminiThinkingLevel, 'LOW');
  assert.equal(defaults.vertexThinkingLevel, 'LOW');
  assert.equal(defaults.geminiSttModel, 'gemini-3.5-transcribe');
});

test('Unit 1: geminiGenerationConfig handles Gemini 3.x/4.x and non-3.x models with thoughts', () => {
  const cfgFlash = geminiGenerationConfig({
    system: 'sys prompt',
    maxTokens: 800,
    thinking: false,
    includeThoughts: true,
    model: 'gemini-3.8-flash'
  });
  assert.equal(cfgFlash.systemInstruction, 'sys prompt');
  assert.deepEqual(cfgFlash.thinkingConfig, { thinkingLevel: 'low', includeThoughts: true });
  assert.ok(cfgFlash.maxOutputTokens >= 800 + 1024);

  const cfgPro = geminiGenerationConfig({
    system: 'sys prompt',
    maxTokens: 1200,
    thinking: true,
    thinkingLevel: 'HIGH',
    includeThoughts: true,
    model: 'gemini-4-argon'
  });
  assert.deepEqual(cfgPro.thinkingConfig, { thinkingLevel: 'high', includeThoughts: true });
  assert.ok(cfgPro.maxOutputTokens >= 1200 + 4096);

  const cfgLegacy = geminiGenerationConfig({
    system: 'sys prompt',
    maxTokens: 500,
    includeThoughts: true,
    model: 'custom-model'
  });
  assert.deepEqual(cfgLegacy.thinkingConfig, { includeThoughts: true, thinkingBudget: -1 });
});

test('Unit 1: GEMINI_STT_MODELS contains active Gemini models and no dead IDs', () => {
  const deadIds = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro'];
  assert.ok(Array.isArray(GEMINI_STT_MODELS) && GEMINI_STT_MODELS.length >= 6);
  for (const m of GEMINI_STT_MODELS) {
    assert.ok(!deadIds.includes(m.id), `model ${m.id} is in dead list`);
    assert.match(m.id, /^gemini-[34]/);
  }
});

test('Unit 1: listGeminiSTTModels returns curated and live models without dead models', async () => {
  const fakeFetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { name: 'models/gemini-3.5-transcribe' },
          { name: 'models/gemini-3.8-flash' },
          { name: 'models/gemini-2.0-flash' },
          { name: 'models/gemini-4-argon' }
        ]
      })
    };
  };

  const res = await listGeminiSTTModels('fake-key', fakeFetch);
  assert.equal(res.ok, true);
  assert.equal(res.live, true);
  const ids = res.models.map((m) => m.id);
  assert.ok(ids.includes('gemini-3.5-transcribe'));
  assert.ok(ids.includes('gemini-3.8-flash'));
  assert.ok(!ids.includes('gemini-2.0-flash'), 'must filter out dead gemini-2.0-flash');
});

test('Unit 2: Typography styles ensure compact high-density layout', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.ai-text\s*\{[^}]*font-size:\s*13px/);
  assert.match(css, /\.ai-text\.small\s*\{[^}]*font-size:\s*12px/);
  assert.match(css, /\.ai-text\s+pre\s*\{[^}]*font-size:\s*12px/);
  assert.match(css, /\.thinking-header\s*\{[^}]*font-size:\s*11px/);
  assert.match(css, /\.response-ol,\s*\.response-ul\s*\{[^}]*font-size:\s*13px/);
});

test('Unit 3: Priority directives are placed at end of system prompt and in user turn', () => {
  const base = 'BASE INSTRUCTIONS\nPHANTOM_LENS_DIRECTIVES';
  const context = 'INTERVIEW CONTEXT';
  const priority = 'CRITICAL ACTIVE SESSION DIRECTIVES (TOP PRIORITY OVERRIDE): give me best and second best';

  const system = buildSystem(base, context, priority);
  assert.ok(system.endsWith(priority), 'priority directives must be at the very end of system prompt');

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSrc, /CRITICAL ACTIVE SESSION DIRECTIVES & USER INSTRUCTIONS \(TOP PRIORITY OVERRIDE\)/);
  assert.match(mainSrc, /\[ACTIVE SESSION DIRECTIVES:/);
  assert.match(mainSrc, /give me /);
});

test('Unit 4: Sound settings UI exposes Gemini STT model dropdown and refresh button', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes('id="gemini-stt-row"'), 'must have #gemini-stt-row');
  assert.ok(html.includes('id="gemini-stt-model-select"'), 'must have #gemini-stt-model-select');
  assert.ok(html.includes('id="refresh-gemini-stt-btn"'), 'must have #refresh-gemini-stt-btn');

  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.ok(preloadSrc.includes('listGeminiSTTModels:'), 'preload.js must expose listGeminiSTTModels');

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(mainSrc.includes("'stt:gemini-models'"), 'main.js must handle stt:gemini-models IPC');
});
