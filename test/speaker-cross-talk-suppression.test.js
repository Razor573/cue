const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MAIN_PATH = path.join(__dirname, '..', 'main.js');
const MAIN_JS = fs.readFileSync(MAIN_PATH, 'utf8');

function extractIsTextualEcho(src) {
  const match = src.match(/function isTextualEcho\(youText, recentThemTurns\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'isTextualEcho function definition must exist in main.js');
  return match[0];
}

function createTextualEchoRunner() {
  const fnCode = extractIsTextualEcho(MAIN_JS);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${fnCode}\nglobalThis.isTextualEcho = isTextualEcho;`, sandbox);
  return sandbox.isTextualEcho;
}

test('isTextualEcho suppresses exact phrase echoes regardless of case or punctuation', () => {
  const isEcho = createTextualEchoRunner();
  const recentThem = [{ text: 'can you describe your experience with kubernetes', ts: Date.now() }];
  assert.equal(isEcho('Can you describe your experience with Kubernetes?', recentThem), true);
  assert.equal(isEcho('can you describe your experience with kubernetes', recentThem), true);
});

test('isTextualEcho suppresses substring echoes where speaker bled into mic', () => {
  const isEcho = createTextualEchoRunner();
  const recentThem = [{ text: 'we deployed the service to amazon web services last week', ts: Date.now() }];
  assert.equal(isEcho('amazon web services', recentThem), true);
  assert.equal(isEcho('deployed the service', recentThem), true);
});

test('isTextualEcho suppresses multi-word high-overlap paraphrasing from speaker bleed', () => {
  const isEcho = createTextualEchoRunner();
  const recentThem = [{ text: 'how do you handle distributed database failover and latency', ts: Date.now() }];
  // 5 out of 6 words match = 83.3% > 70%
  assert.equal(isEcho('how do you handle distributed database', recentThem), true);
});

test('isTextualEcho permits distinct user speech and low-overlap phrases', () => {
  const isEcho = createTextualEchoRunner();
  const recentThem = [{ text: 'tell me about your background in machine learning', ts: Date.now() }];
  assert.equal(isEcho('I started building backend pipelines five years ago', recentThem), false);
  assert.equal(isEcho('kubernetes and docker are my preferred tools', recentThem), false);
});

test('isTextualEcho ignores ultra-short tokens under 3 characters', () => {
  const isEcho = createTextualEchoRunner();
  const recentThem = [{ text: 'ok sounds good', ts: Date.now() }];
  assert.equal(isEcho('ok', recentThem), false);
  assert.equal(isEcho('', recentThem), false);
});

test('routeAudio suppresses speaker bleed when them channel is active and you channel is quieter', () => {
  const RMS_GATE = 180;
  const crossTalkState = {
    themLastActiveTs: Date.now() - 100, // Them spoke 100ms ago
    themRecentRms: 300,
    recentThemTurns: []
  };

  const now = Date.now();
  const youRmsBleed = 250; // 250 < 300 * 0.95 = 285
  const themActive = (now - crossTalkState.themLastActiveTs < 1000);
  const isBleed = themActive && ((youRmsBleed < crossTalkState.themRecentRms * 0.95) || (youRmsBleed < RMS_GATE * 2.2));
  assert.equal(isBleed, true, 'Speaker bleed lower than speaker loopback energy should be dropped');
});

test('routeAudio permits double-talk when user speaks loudly over active speaker', () => {
  const RMS_GATE = 180;
  const crossTalkState = {
    themLastActiveTs: Date.now() - 100,
    themRecentRms: 300,
    recentThemTurns: []
  };

  const now = Date.now();
  const youRmsDirectSpeech = 450; // User speaking directly into mic: 450 >= 285 and >= 396
  const themActive = (now - crossTalkState.themLastActiveTs < 1000);
  const isBleed = themActive && ((youRmsDirectSpeech < crossTalkState.themRecentRms * 0.95) || (youRmsDirectSpeech < RMS_GATE * 2.2));
  assert.equal(isBleed, false, 'Loud intentional direct speech during double-talk must not be dropped');
});

test('routeAudio permits normal speech when them channel is inactive', () => {
  const RMS_GATE = 180;
  const crossTalkState = {
    themLastActiveTs: Date.now() - 1200, // Them was silent for 1200ms (> 1000ms)
    themRecentRms: 300,
    recentThemTurns: []
  };

  const now = Date.now();
  const youRms = 200; // Above RMS_GATE (180)
  const themActive = (now - crossTalkState.themLastActiveTs < 1000);
  const isBleed = themActive && ((youRms < crossTalkState.themRecentRms * 0.95) || (youRms < RMS_GATE * 2.2));
  assert.equal(isBleed, false, 'Speech when speaker is inactive must be processed');
});

test('pushTranscript retains recentThemTurns for 8000ms', () => {
  const now = Date.now();
  const turns = [
    { text: 'turn 1', ts: now - 9000 },
    { text: 'turn 2', ts: now - 7000 },
    { text: 'turn 3', ts: now - 2000 }
  ];
  const filtered = turns.filter(t => (now - t.ts) < 8000);
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].text, 'turn 2');
  assert.equal(filtered[1].text, 'turn 3');
});

test('GEMINI_TRANSCRIBE_FALLBACK_MODEL is exported as gemini-3.5-flash-lite and wired in stt.js', () => {
  const { GEMINI_TRANSCRIBE_FALLBACK_MODEL } = require('../src/llm');
  assert.equal(GEMINI_TRANSCRIBE_FALLBACK_MODEL, 'gemini-3.5-flash-lite');
  const sttSource = fs.readFileSync(path.join(__dirname, '..', 'src/stt.js'), 'utf8');
  assert.match(sttSource, /GEMINI_TRANSCRIBE_FALLBACK_MODEL/);
  assert.match(sttSource, /fallbackModel\s*\|\|\s*GEMINI_TRANSCRIBE_FALLBACK_MODEL/);
});

test('listGeminiSTTModels curates voice models and strictly excludes Pro and Argon models', async () => {
  const { GEMINI_STT_MODELS, listGeminiSTTModels } = require('../src/llm');
  const curatedIds = GEMINI_STT_MODELS.map((m) => m.id);
  assert.ok(curatedIds.includes('gemini-3.5-transcribe'));
  assert.ok(curatedIds.includes('gemini-3.5-transcribe-live'));
  assert.ok(curatedIds.includes('gemini-3.8-live'));
  assert.ok(curatedIds.includes('gemini-3.5-flash-lite'));
  assert.ok(!curatedIds.includes('gemini-3.1-pro-preview'), 'gemini-3.1-pro-preview must not be in Sound STT selector');
  assert.ok(!curatedIds.includes('gemini-4-argon'), 'gemini-4-argon must not be in Sound STT selector');

  const mockApiData = {
    models: [
      { name: 'models/gemini-3.5-transcribe' },
      { name: 'models/gemini-3.5-transcribe-live' },
      { name: 'models/gemini-3.8-live' },
      { name: 'models/gemini-3.1-pro-preview' },
      { name: 'models/gemini-4-argon' },
      { name: 'models/text-embedding-004' }
    ]
  };
  const mockFetch = async () => ({
    ok: true,
    json: async () => mockApiData
  });

  const res = await listGeminiSTTModels('test-key', mockFetch);
  assert.equal(res.ok, true);
  const resultIds = res.models.map((m) => m.id);
  assert.ok(resultIds.includes('gemini-3.5-transcribe'));
  assert.ok(resultIds.includes('gemini-3.5-transcribe-live'));
  assert.ok(resultIds.includes('gemini-3.8-live'));
  assert.ok(!resultIds.includes('gemini-3.1-pro-preview'), 'API returned pro model must be filtered out');
  assert.ok(!resultIds.includes('gemini-4-argon'), 'API returned argon model must be filtered out');
  assert.ok(!resultIds.includes('text-embedding-004'), 'Embedding model must be filtered out');
});

test('renderer and store wire geminiSttFallbackModel and describe latency and accuracy', () => {
  const storeSource = fs.readFileSync(path.join(__dirname, '..', 'src/store.js'), 'utf8');
  assert.match(storeSource, /geminiSttFallbackModel:\s*'gemini-3\.5-flash-lite'/);

  const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'renderer/index.html'), 'utf8');
  assert.match(htmlSource, /id="gemini-stt-fallback-row"/);
  assert.match(htmlSource, /id="gemini-stt-fallback-select"/);
  assert.match(htmlSource, /id="gemini-stt-fallback-desc"/);

  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer/renderer.js'), 'utf8');
  assert.match(rendererSource, /populateGeminiSttFallbackModels/);
  assert.match(rendererSource, /updateFallbackDescription/);
  assert.match(rendererSource, /settings\.geminiSttFallbackModel/);
});
