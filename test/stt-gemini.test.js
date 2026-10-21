const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { extractGeminiTranscript, transcribeGeminiWith } = require('../src/stt');
const { GEMINI_TRANSCRIBE_MODEL, CURRENT_GEMINI_DEFAULT, GEMINI_TRANSCRIBE_FALLBACK_MODEL } = require('../src/llm');

const candidate = (parts) => ({ candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP' }] });

test('extractGeminiTranscript reads the audioTranscription part gemini-*-transcribe models return', () => {
  const res = candidate([{ audioTranscription: { text: '  We deployed the cluster on Tuesday.  ' } }]);
  assert.equal(extractGeminiTranscript(res), 'We deployed the cluster on Tuesday.');
});

test('extractGeminiTranscript still reads plain text parts from the chat-model fallback', () => {
  const res = candidate([
    { text: 'thinking…', thought: true, thoughtSignature: 'abc' },
    { text: 'Hello ', thoughtSignature: 'abc' },
    { text: 'world.' }
  ]);
  assert.equal(extractGeminiTranscript(res), 'Hello world.');
});

test('extractGeminiTranscript returns an empty string for silence and malformed responses', () => {
  assert.equal(extractGeminiTranscript(candidate([])), '');
  assert.equal(extractGeminiTranscript({ candidates: [] }), '');
  assert.equal(extractGeminiTranscript(undefined), '');
  assert.equal(extractGeminiTranscript({ candidates: [{ content: {} }] }), '');
});

test('GEMINI_TRANSCRIBE_MODEL is a dedicated transcribe model distinct from the chat default', () => {
  assert.match(GEMINI_TRANSCRIBE_MODEL, /^gemini-[\d.]+-transcribe$/);
  assert.notEqual(GEMINI_TRANSCRIBE_MODEL, CURRENT_GEMINI_DEFAULT);
});

test('both Gemini transcription paths go through the shared transcribeGemini', () => {
  const stt = fs.readFileSync(path.join(__dirname, '..', 'src/stt.js'), 'utf8');
  const streaming = fs.readFileSync(path.join(__dirname, '..', 'src/stt-streaming.js'), 'utf8');
  assert.ok(stt.includes('model: GEMINI_TRANSCRIBE_MODEL'), 'stt.js does not use GEMINI_TRANSCRIBE_MODEL');
  assert.ok(streaming.includes('const transcribeBatchGemini = transcribeGemini'), 'stt-streaming.js has drifted from stt.js');
  assert.ok(!streaming.includes('generateContent('), 'stt-streaming.js should not make its own batch Gemini calls');
});

// Fake @google/genai client: per-model behaviour, records every call.
function fakeClient(behaviour) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(req) {
        calls.push(req);
        const b = behaviour[req.model];
        if (b instanceof Error) throw b;
        return b;
      }
    }
  };
}
const quota429 = Object.assign(new Error('429 Too Many Requests: RESOURCE_EXHAUSTED'), { status: 429 });
const gone404 = Object.assign(new Error('404 model not found'), { status: 404 });
const transcribed = candidate([{ audioTranscription: { text: 'from transcribe' } }]);
const chatted = candidate([{ text: 'from flash' }]);
const wav = Buffer.from('RIFF');
// The cooldown is module state; keep each scenario in its own minute.
let clock = 10 ** 12;
const nextMinute = () => (clock += 120000);

test('transcribeGemini uses the transcribe model with no instruction prompt when it is healthy', async () => {
  const ai = fakeClient({ [GEMINI_TRANSCRIBE_MODEL]: transcribed });
  assert.equal(await transcribeGeminiWith(ai, wav, nextMinute()), 'from transcribe');
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, GEMINI_TRANSCRIBE_MODEL);
  assert.deepEqual(ai.calls[0].contents[0].parts.map((p) => Object.keys(p)[0]), ['inlineData']);
});

test('a 429 on the transcribe model falls through to the chat model for the same clip, then stays there for a minute', async () => {
  const ai = fakeClient({ [GEMINI_TRANSCRIBE_MODEL]: quota429, [GEMINI_TRANSCRIBE_FALLBACK_MODEL]: chatted });
  const t0 = nextMinute();
  assert.equal(await transcribeGeminiWith(ai, wav, t0), 'from flash');
  assert.deepEqual(ai.calls.map((c) => c.model), [GEMINI_TRANSCRIBE_MODEL, GEMINI_TRANSCRIBE_FALLBACK_MODEL]);
  // Chat model path carries the instruction prompt in front of the audio.
  assert.equal(typeof ai.calls[1].contents[0].parts[0].text, 'string');

  ai.calls.length = 0;
  assert.equal(await transcribeGeminiWith(ai, wav, t0 + 30000), 'from flash');
  assert.deepEqual(ai.calls.map((c) => c.model), [GEMINI_TRANSCRIBE_FALLBACK_MODEL], 'must not re-hit the parked model inside the cooldown');

  ai.calls.length = 0;
  ai.models.generateContent = async (req) => { ai.calls.push(req); return req.model === GEMINI_TRANSCRIBE_MODEL ? transcribed : chatted; };
  assert.equal(await transcribeGeminiWith(ai, wav, t0 + 61000), 'from transcribe', 'retries the transcribe model once the cooldown lapses');
});

test('a 404 on the transcribe model also degrades to the chat model', async () => {
  const ai = fakeClient({ [GEMINI_TRANSCRIBE_MODEL]: gone404, [GEMINI_TRANSCRIBE_FALLBACK_MODEL]: chatted });
  assert.equal(await transcribeGeminiWith(ai, wav, nextMinute()), 'from flash');
});

test('other transcribe-model failures propagate instead of being masked by the fallback', async () => {
  const badKey = Object.assign(new Error('API key not valid'), { status: 400 });
  const ai = fakeClient({ [GEMINI_TRANSCRIBE_MODEL]: badKey, [GEMINI_TRANSCRIBE_FALLBACK_MODEL]: chatted });
  await assert.rejects(() => transcribeGeminiWith(ai, wav, nextMinute()), /API key not valid/);
  assert.deepEqual(ai.calls.map((c) => c.model), [GEMINI_TRANSCRIBE_MODEL]);
});
