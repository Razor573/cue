// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const { formatProviderErrorMessage, isQuotaError, isRateLimitError, isNotFoundError, resolveGeminiModel, CURRENT_GEMINI_DEFAULT, GEMINI_TRANSCRIBE_MODEL, GEMINI_TRANSCRIBE_FALLBACK_MODEL } = require('./llm');

const BASE_VOCAB = 'CI/CD, Docker, Kubernetes, Terraform, Jenkins, AWS, Azure, GCP, ' +
  'CodeCommit, CodePipeline, CodeBuild, CodeDeploy, DevOps, SRE, microservices, deployment, ' +
  'pipeline, container, orchestration, Ansible, Prometheus, Grafana, Helm, EKS, ECS, Lambda, ' +
  'S3, EC2, IAM, GitHub Actions, GitLab, Kafka, PostgreSQL, Redis, MongoDB, REST API, gRPC';

function looksLikeHallucination(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return true;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) return true;
  const t = trimmed.replace(/[.,!?…]+$/g, '').trim().toLowerCase();
  const artifacts = new Set([
    'thank you', 'thank you very much', 'thank you for watching', 'thanks for watching',
    'please subscribe', 'like and subscribe', 'bye-bye', 'bye bye', 'bye', 'you', 'okay'
  ]);
  return artifacts.has(t);
}

function buildVocabPrompt(settings) {
  const s = settings || {};
  const text = (s.resumeText || '') + ' ' + (s.jobDescription || '');
  const proper = Array.from(new Set(text.match(/\b([A-Z][a-zA-Z0-9+.#]{2,}|[A-Z]{2,6})\b/g) || []));
  let prompt = BASE_VOCAB + (proper.length ? ', ' + proper.slice(0, 60).join(', ') : '');
  if (prompt.length > 850) prompt = prompt.slice(0, 850);
  return prompt;
}

async function transcribeOpenAI(apiKey, wav, model, baseURL, prompt) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey, baseURL });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({
    file,
    model: model || 'whisper-1',
    language: 'en',
    temperature: 0,
    prompt: prompt || ''
  });
  return (res.text || '').trim();
}

// gemini-*-transcribe models answer with { audioTranscription: { text } } parts,
// which the SDK's res.text getter ignores (it only concatenates `text` parts),
// so read both shapes off the raw candidate. Silence comes back as no parts.
function extractGeminiTranscript(res) {
  const parts = (res && res.candidates && res.candidates[0] && res.candidates[0].content &&
    res.candidates[0].content.parts) || [];
  let out = '';
  for (const part of parts) {
    if (!part || part.thought) continue;
    if (part.audioTranscription && typeof part.audioTranscription.text === 'string') out += part.audioTranscription.text;
    else if (typeof part.text === 'string') out += part.text;
  }
  return out.trim();
}

// gemini-3.5-transcribe is capped at 10 requests/min per model on free-tier
// keys, and flushChannel in main.js sends a clip every ~900ms per channel
// while someone is talking — so a 429 from it is routine, not a dead key.
// Park the model for a minute and use the chat model (far higher per-minute
// quota) for the same clip, instead of letting the error reach main.js's
// handleSttError, which switches transcription off for the whole session.
const TRANSCRIBE_MODEL_COOLDOWN_MS = 60000;
let transcribeModelDownUntil = 0;

// Split from transcribeGemini so tests can pass a fake client.
async function transcribeGeminiWith(ai, wav, modelOrNow, maybeNowOrFallback, maybeNow) {
  let primaryModel = GEMINI_TRANSCRIBE_MODEL;
  let fallbackModel = GEMINI_TRANSCRIBE_FALLBACK_MODEL;
  let now = Date.now();
  if (typeof modelOrNow === 'number') {
    now = modelOrNow;
  } else if (typeof modelOrNow === 'string' && modelOrNow) {
    primaryModel = modelOrNow;
  }
  if (typeof maybeNowOrFallback === 'string' && maybeNowOrFallback) {
    fallbackModel = maybeNowOrFallback;
    if (typeof maybeNow === 'number') now = maybeNow;
  } else if (typeof maybeNowOrFallback === 'number') {
    now = maybeNowOrFallback;
  }
  const audio = { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } };
  if (now >= transcribeModelDownUntil) {
    try {
      // Dedicated transcription model (model: GEMINI_TRANSCRIBE_MODEL)
      const res = await ai.models.generateContent({
        model: primaryModel || GEMINI_TRANSCRIBE_MODEL,
        contents: [{ role: 'user', parts: [audio] }]
      });
      return extractGeminiTranscript(res);
    } catch (e) {
      // Same key, same provider — only the model id changes, so a retired or
      // rate-limited transcribe model degrades to the chat model rather than
      // to a 404/429 loop. Anything else (bad key, network) still propagates.
      if (!isNotFoundError(e) && !isQuotaError(e)) throw e;
      transcribeModelDownUntil = now + TRANSCRIBE_MODEL_COOLDOWN_MS;
    }
  }
  const res = await ai.models.generateContent({
    model: fallbackModel || GEMINI_TRANSCRIBE_FALLBACK_MODEL,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      audio
    ] }]
  });
  return extractGeminiTranscript(res);
}

async function transcribeGemini(apiKey, wav, modelId) {
  const { GoogleGenAI } = require('@google/genai');
  return transcribeGeminiWith(new GoogleGenAI({ apiKey }), wav, modelId);
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const vocabPrompt = buildVocabPrompt(settings);
  const chain = [];
  // Each entry carries the model id it actually sends, so a failure can name
  // that id back to the user instead of a hardcoded one they never picked.
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    const model = settings.sttModel || 'whisper-1';
    chain.push({ p: 'openai', m: model, fn: (wav) => transcribeOpenAI(keys.openai, wav, model, undefined, vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'groq') && keys.groq) {
    const model = 'whisper-large-v3-turbo';
    chain.push({ p: 'groq', m: model, fn: (wav) => transcribeOpenAI(keys.groq, wav, model, 'https://api.groq.com/openai/v1', vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'gemini') && keys.gemini) {
    const model = resolveGeminiModel(settings);
    const transcribeModel = settings.geminiSttModel || GEMINI_TRANSCRIBE_MODEL;
    const fallbackModel = settings.geminiSttFallbackModel || GEMINI_TRANSCRIBE_FALLBACK_MODEL;
    chain.push({ p: 'gemini', m: model, fn: (wav) => transcribeGemini(keys.gemini, wav, transcribeModel, fallbackModel) });
  }
  // Custom (OpenAI-compatible) endpoint: same shape as the Groq branch above,
  // just pointed at the user's own Base URL. Deliberately NOT part of 'auto' —
  // unlike a named provider, an arbitrary custom endpoint isn't known to speak
  // the audio-transcription API at all, so this only fires on an explicit
  // choice, and only once both the URL and the key it needs are actually set.
  if (selectedProvider === 'custom' && keys.custom && settings.baseUrl) {
    chain.push({ p: 'custom', fn: (wav) => transcribeOpenAI(keys.custom, wav, settings.sttModel, settings.baseUrl, vocabPrompt) });
  }
  if (keys.openai && chain.length > 1) chain.unshift(chain.splice(chain.findIndex((c) => c.p === 'openai'), 1)[0]);

  let disabledUntil = 0;
  let lastProvider = null;

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    models: chain.map((c) => c.m),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const now = Date.now();
      if (disabledUntil && now < disabledUntil) return { text: '', error: { provider: lastProvider, message: `Temporary ${lastProvider || 'provider'} quota or rate-limit; waiting 30s before retrying.` } };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          disabledUntil = 0;
          lastProvider = c.p;
          if (looksLikeHallucination(text)) return { text: '', provider: c.p };
          return { text, provider: c.p };
        } catch (e) {
          // Shares detection/wording with the LLM error path (src/llm.js) so a
          // 404 (dead/misspelled model) or 429 (quota) reads the same whether it
          // came from a chat request or a transcription request.
          // Both exhaustion and a plain rate limit mean "stop hammering this
          // provider" — the 30s cooldown below covers both (it always did, via
          // the old status===429 catch-all inside isQuotaError; now that a
          // rate limit is classified separately, it has to be named here too).
          const backOff = isQuotaError(e) || isRateLimitError(e);
          const message = formatProviderErrorMessage(e, c.p, c.m);
          lastErr = { status: e && e.status, code: e && e.code, message, provider: c.p, model: c.m };
          if (backOff) {
            lastProvider = c.p;
            disabledUntil = now + 30000;
            break;
          }
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT, looksLikeHallucination, buildVocabPrompt, transcribeGemini, transcribeGeminiWith, extractGeminiTranscript, GEMINI_TRANSCRIBE_FALLBACK_MODEL };
