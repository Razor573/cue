// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const {
  formatProviderErrorMessage,
  isQuotaError,
  isRateLimitError,
  isNotFoundError,
  resolveGeminiModel,
  CURRENT_GEMINI_DEFAULT,
  GEMINI_TRANSCRIBE_MODEL,
  GEMINI_TRANSCRIBE_FALLBACK_MODEL
} = require('./llm');

const BASE_VOCAB = 'CI/CD, Docker, Kubernetes, Terraform, Jenkins, AWS, Azure, GCP, ' +
  'CodeCommit, CodePipeline, CodeBuild, CodeDeploy, DevOps, SRE, microservices, deployment, ' +
  'pipeline, container, orchestration, Ansible, Prometheus, Grafana, Helm, EKS, ECS, Lambda, ' +
  'S3, EC2, IAM, GitHub Actions, GitLab, Kafka, PostgreSQL, Redis, MongoDB, REST API, gRPC';

// ============================================================================
// Step 5.1: STT Failure Clarity (quota / auth / no mic)
// ============================================================================

const STT_QUOTA_RE = /\b(402|429|quota|credit|credits|balance|billing|insufficient[_\s-]?quota|payment[_\s-]?required|rate[_\s-]?limit|too many requests|exceeded your current quota|resource[_\s-]?exhausted)\b/i;
const STT_AUTH_RE = /\b(401|403|unauthori[sz]ed|forbidden|invalid[_\s-]?(?:api[_\s-]?)?key|invalid[_\s-]?token|authentication|permission[_\s-]?denied|bad credentials|api key not valid)\b/i;
const STT_NO_MIC_RE = /\b(no[_\s-]?mic|no[_\s-]?microphone|notfounderror|devicesnotfounderror|notallowederror|permissiondeniederror|requested device not found|no audio input|microphone (?:not found|unavailable|disconnected|permission|access denied)|audio capture failed)\b/i;

function extractSttErrorStatus(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (!input || typeof input !== 'object') return null;
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const val = input[key];
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string' && /^\d{3}$/.test(val.trim())) return Number(val.trim());
  }
  if (input.error && typeof input.error === 'object') {
    const nested = extractSttErrorStatus(input.error);
    if (nested !== null) return nested;
  }
  return null;
}

function extractSttErrorText(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number') return String(input);
  if (typeof input === 'object') {
    const parts = [];
    for (const key of ['name', 'code', 'status', 'statusCode', 'httpStatus', 'variant', 'message', 'description', 'reason']) {
      if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'object') {
        parts.push(String(input[key]));
      }
    }
    if (input.error) parts.push(extractSttErrorText(input.error));
    if (input.cause) parts.push(extractSttErrorText(input.cause));
    return parts.filter(Boolean).join(' ');
  }
  return String(input);
}

function classifySttError(input) {
  const status = extractSttErrorStatus(input);
  const text = extractSttErrorText(input);
  if (STT_NO_MIC_RE.test(text)) return 'no mic';
  if (status === 402 || status === 429) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (STT_QUOTA_RE.test(text)) return 'quota';
  if (STT_AUTH_RE.test(text)) return 'auth';
  return 'unknown';
}

function formatSttProviderLabel(provider) {
  const raw = String(provider || 'STT').trim().toLowerCase();
  const labels = {
    deepgram: 'Deepgram',
    openai: 'OpenAI',
    'openai-realtime': 'OpenAI Realtime',
    groq: 'Groq',
    gemini: 'Gemini',
    'gemini-live': 'Gemini Live',
    soniox: 'Soniox',
    google: 'Google Cloud Speech',
    'google-cloud': 'Google Cloud Speech',
    custom: 'Custom STT',
    mic: 'Microphone',
    audio: 'Audio'
  };
  return labels[raw] || (provider ? String(provider) : 'STT');
}

function describeSttError(providerOrInput, maybeInput) {
  const hasTwoArgs = maybeInput !== undefined;
  const provider = hasTwoArgs ? providerOrInput : (providerOrInput && typeof providerOrInput === 'object' ? providerOrInput.provider : 'STT');
  const input = hasTwoArgs ? maybeInput : providerOrInput;
  const cause = classifySttError(input);
  const label = formatSttProviderLabel(provider);
  const raw = extractSttErrorText(input).replace(/\s+/g, ' ').trim();
  const detailSuffix = raw ? ` (${raw.slice(0, 140)})` : '';

  if (cause === 'quota') {
    return `failed (quota): ${label} quota or credits exhausted${detailSuffix}`;
  }
  if (cause === 'auth') {
    return `failed (auth): ${label} API key rejected${detailSuffix}`;
  }
  if (cause === 'no mic') {
    return `failed (no mic): Microphone unavailable or permission denied${detailSuffix}`;
  }
  if (raw && /^failed\b/i.test(raw)) return raw;
  return raw ? `failed: ${label} error (${raw.slice(0, 140)})` : `failed: ${label} connection failed`;
}

function formatSttFailureStatus(providerOrInput, maybeInput, channel = undefined) {
  const hasTwoArgs = maybeInput !== undefined;
  const provider = hasTwoArgs ? providerOrInput : (providerOrInput && typeof providerOrInput === 'object' ? providerOrInput.provider : 'STT');
  const input = hasTwoArgs ? maybeInput : providerOrInput;
  const cause = classifySttError(input);
  const message = describeSttError(provider, input);
  return {
    ...(channel ? { channel } : {}),
    state: 'failed',
    status: 'failed',
    cause,
    provider,
    message,
    toString() {
      return message;
    },
    valueOf() {
      return message;
    }
  };
}

// ============================================================================
// Step 5.2: User Dictionary (up to 100 terms) + Provider Hint Helpers
// ============================================================================

const MAX_STT_DICTIONARY_TERMS = 100;
const MAX_STT_TERM_LENGTH = 40;

function sanitizeSttTerms(raw, maxTerms = MAX_STT_DICTIONARY_TERMS) {
  const cap = typeof maxTerms === 'number' && maxTerms > 0 ? Math.min(maxTerms, MAX_STT_DICTIONARY_TERMS) : MAX_STT_DICTIONARY_TERMS;
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    items = raw.split(/[\r\n,;]+/);
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.sttDictionary)) {
    items = raw.sttDictionary;
  } else {
    return [];
  }

  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const cleaned = item
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_STT_TERM_LENGTH)
      .trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= cap) break;
  }
  return out;
}

function deepgramHintParams(model, terms) {
  const cleanTerms = sanitizeSttTerms(terms);
  if (!cleanTerms.length) return [];
  const modelStr = String(model || 'nova-3').trim().toLowerCase();
  const key = modelStr.startsWith('nova-3') ? 'keyterm' : 'keywords';
  return cleanTerms.map((term) => [key, term]);
}

function whisperGlossaryPrompt(terms) {
  const cleanTerms = sanitizeSttTerms(terms);
  if (!cleanTerms.length) return '';
  return `Glossary: ${cleanTerms.join(', ')}.`;
}

function isGlossaryEcho(text, prompt) {
  if (!prompt || !text) return false;
  const cleanText = String(text).trim().replace(/[.!,?;:]+$/g, '').trim().toLowerCase();
  if (!cleanText) return false;
  if (cleanText.startsWith('glossary:')) return true;

  const terms = Array.isArray(prompt)
    ? sanitizeSttTerms(prompt).map((t) => t.toLowerCase())
    : String(prompt)
        .replace(/^glossary:\s*/i, '')
        .replace(/\.$/, '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
  if (!terms.length) return false;

  const matchedTerms = terms.filter((t) => cleanText.includes(t));
  if (matchedTerms.length >= 3 || (terms.length < 3 && matchedTerms.length === terms.length)) {
    const words = cleanText.split(/[\s,]+/).filter(Boolean);
    if (!words.length) return false;
    const termWords = new Set(terms.flatMap((t) => t.split(/\s+/)).filter(Boolean));
    const hits = words.filter((w) => termWords.has(w)).length;
    if (hits / words.length >= 0.8) return true;
  }
  return false;
}

// ============================================================================
// Step 5.3: Hallucination Filtering (Groq verbose_json + bracketed-tag blocklist)
// ============================================================================

const NO_SPEECH_PROB_THRESHOLD = 0.6;
const LOW_CONFIDENCE_LOGPROB = -1.0;
const BRACKET_TOKEN_RE = /^\[.*\]$/;
const INLINE_BRACKET_TAG_RE = /\[(?:music|blank[_\s-]?audio|applause|laughter|noise|silence|inaudible|sound|bell|cough|sigh|cheering|singing|speaking foreign language)\]|\((?:music|applause|laughter|silence|inaudible|noise)\)/gi;

const SILENCE_HALLUCINATIONS = new Set([
  'thank you',
  'thank you.',
  'thanks for watching',
  'thanks for watching.',
  'thank you for watching',
  'thank you for watching.',
  'thank you very much',
  'you',
  'you.',
  'bye',
  'bye.',
  'bye-bye',
  'bye bye',
  '...',
  '..',
  '.',
  'subtitle',
  'subtitles',
  'okay'
]);

const EXACT_BLOCKS = new Set([
  'thank you',
  'thank you very much',
  'thank you for watching',
  'thanks for watching',
  'thank you for listening',
  'thanks for listening',
  'please subscribe',
  'like and subscribe',
  'subscribe to my channel',
  'subtitles by the amara.org community',
  'amara.org',
  'transcribed by',
  'bye-bye',
  'bye bye',
  'bye',
  'you',
  'okay',
  'subtitle',
  'subtitles',
  '.',
  '..',
  '...',
  '[music]',
  '[blank_audio]',
  '[applause]',
  '[laughter]',
  '[noise]',
  '[silence]',
  '[inaudible]'
]);

function filterHallucination(raw) {
  if (typeof raw !== 'string') return '';
  let trimmed = raw.trim();
  if (!trimmed) return '';

  // Single bracketed tag e.g. "[Music]" or "[BLANK_AUDIO]"
  if (BRACKET_TOKEN_RE.test(trimmed)) return '';

  // Strip inline bracketed hallucination tags
  trimmed = trimmed.replace(INLINE_BRACKET_TAG_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  if (BRACKET_TOKEN_RE.test(trimmed)) return '';

  // Emoji-only strings
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) return '';

  const lower = trimmed.toLowerCase();
  if (EXACT_BLOCKS.has(lower) || SILENCE_HALLUCINATIONS.has(lower)) return '';

  const norm = lower.replace(/[.,!?…]+$/g, '').trim();
  if (!norm) return '';
  if (EXACT_BLOCKS.has(norm) || SILENCE_HALLUCINATIONS.has(norm)) return '';

  return trimmed;
}

function looksLikeHallucination(raw) {
  return filterHallucination(raw) === '';
}

function whisperTextWithoutHallucinations(data, glossaryPrompt = '') {
  if (data === null || data === undefined) return '';

  let parsed = data;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch (_) {
        parsed = { text: trimmed };
      }
    } else {
      parsed = { text: trimmed };
    }
  }

  let candidateText = '';
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.segments) && parsed.segments.length > 0) {
      const validSegments = [];
      for (const seg of parsed.segments) {
        if (!seg || typeof seg.text !== 'string') continue;
        const noSpeech = typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : 0;
        const avgLogprob = typeof seg.avg_logprob === 'number' ? seg.avg_logprob : 0;
        const rawSeg = seg.text.trim();
        const cleanSeg = rawSeg.toLowerCase().replace(/[.,!?…]+$/g, '').trim();

        if (noSpeech > NO_SPEECH_PROB_THRESHOLD && avgLogprob < LOW_CONFIDENCE_LOGPROB) {
          continue;
        }
        if (noSpeech > NO_SPEECH_PROB_THRESHOLD && (SILENCE_HALLUCINATIONS.has(rawSeg.toLowerCase()) || SILENCE_HALLUCINATIONS.has(cleanSeg))) {
          continue;
        }
        const filteredSeg = filterHallucination(rawSeg);
        if (!filteredSeg) continue;
        validSegments.push(filteredSeg);
      }
      candidateText = validSegments.join(' ').trim();
    } else if (typeof parsed.text === 'string') {
      candidateText = parsed.text.trim();
    }
  }

  const cleaned = filterHallucination(candidateText);
  if (!cleaned) return '';
  if (glossaryPrompt && isGlossaryEcho(cleaned, glossaryPrompt)) return '';
  return cleaned;
}

function buildVocabPrompt(settings) {
  const s = settings || {};
  const dictTerms = sanitizeSttTerms(s.sttDictionary);
  if (dictTerms.length > 0) {
    return whisperGlossaryPrompt(dictTerms);
  }
  const text = (s.resumeText || '') + ' ' + (s.jobDescription || '');
  const proper = Array.from(new Set(text.match(/\b([A-Z][a-zA-Z0-9+.#]{2,}|[A-Z]{2,6})\b/g) || []));
  let prompt = BASE_VOCAB + (proper.length ? ', ' + proper.slice(0, 60).join(', ') : '');
  if (prompt.length > 850) prompt = prompt.slice(0, 850);
  return prompt;
}

function buildMultipartFormData(wavBuffer, fields = {}) {
  const boundary = '----CueSTTBoundary' + Math.random().toString(36).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      'utf8'
    ));
  }
  const fileBuffer = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer || []);
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    'utf8'
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return {
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(parts),
    fields: { ...fields }
  };
}

function resolveWhisperCallArgs(apiKeyOrOpts, wav, modelOrOpts, baseURL, prompt, maybeOpts) {
  if (apiKeyOrOpts && typeof apiKeyOrOpts === 'object' && !Buffer.isBuffer(apiKeyOrOpts)) {
    const o = apiKeyOrOpts;
    const terms = sanitizeSttTerms(o.terms || o.sttDictionary || o.settings?.sttDictionary);
    const glossaryPrompt = o.prompt !== undefined ? o.prompt : (terms.length ? whisperGlossaryPrompt(terms) : '');
    return {
      apiKey: o.apiKey || '',
      wav: o.wav || o.audio || o.file || Buffer.alloc(0),
      model: o.model || '',
      baseURL: o.baseURL || o.baseUrl || undefined,
      prompt: glossaryPrompt,
      responseFormat: o.responseFormat || o.response_format,
      fetchImpl: o.fetchImpl || o.fetch || null,
      useFetch: Boolean(o.fetchImpl || o.fetch || o.useFetch)
    };
  }
  const opts = (modelOrOpts && typeof modelOrOpts === 'object') ? modelOrOpts : (maybeOpts && typeof maybeOpts === 'object' ? maybeOpts : {});
  const model = typeof modelOrOpts === 'string' ? modelOrOpts : (opts.model || '');
  const terms = sanitizeSttTerms(opts.terms || opts.sttDictionary || opts.settings?.sttDictionary);
  const resolvedPrompt = prompt !== undefined
    ? prompt
    : (opts.prompt !== undefined ? opts.prompt : (terms.length ? whisperGlossaryPrompt(terms) : ''));
  return {
    apiKey: apiKeyOrOpts,
    wav,
    model,
    baseURL: baseURL || opts.baseURL || opts.baseUrl,
    prompt: resolvedPrompt,
    responseFormat: opts.responseFormat || opts.response_format,
    fetchImpl: opts.fetchImpl || opts.fetch || null,
    useFetch: Boolean(opts.fetchImpl || opts.fetch || opts.useFetch)
  };
}

async function transcribeOpenAI(apiKeyOrOpts, wav, modelOrOpts, baseURL, prompt, maybeOpts) {
  const args = resolveWhisperCallArgs(apiKeyOrOpts, wav, modelOrOpts, baseURL, prompt, maybeOpts);
  const model = args.model || 'whisper-1';
  const glossaryPrompt = args.prompt || '';

  if (args.useFetch && typeof (args.fetchImpl || global.fetch) === 'function') {
    const fetchFn = args.fetchImpl || global.fetch;
    const fields = {
      model,
      language: 'en',
      temperature: '0',
      response_format: args.responseFormat || 'json'
    };
    if (glossaryPrompt) fields.prompt = glossaryPrompt;
    const form = buildMultipartFormData(args.wav, fields);
    const endpoint = `${(args.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/audio/transcriptions`;
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': form.contentType
      },
      body: form.body,
      fields: form.fields
    });
    if (!res.ok) {
      const errText = typeof res.text === 'function' ? await res.text() : '';
      const err = new Error(`OpenAI Whisper HTTP ${res.status}: ${errText.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = typeof res.json === 'function' ? await res.json() : await res.text();
    return whisperTextWithoutHallucinations(data, glossaryPrompt);
  }

  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey: args.apiKey, baseURL: args.baseURL });
  const file = await toFile(args.wav, 'audio.wav', { type: 'audio/wav' });
  const req = {
    file,
    model,
    language: 'en',
    temperature: 0,
    prompt: glossaryPrompt
  };
  if (args.responseFormat) req.response_format = args.responseFormat;
  const res = await client.audio.transcriptions.create(req);
  return whisperTextWithoutHallucinations(res, glossaryPrompt);
}

async function transcribeGroq(apiKeyOrOpts, wav, modelOrOpts, promptOrOpts, maybeOpts) {
  const isObj = apiKeyOrOpts && typeof apiKeyOrOpts === 'object' && !Buffer.isBuffer(apiKeyOrOpts);
  const opts = isObj
    ? apiKeyOrOpts
    : (modelOrOpts && typeof modelOrOpts === 'object'
        ? modelOrOpts
        : (promptOrOpts && typeof promptOrOpts === 'object' ? promptOrOpts : (maybeOpts || {})));
  const apiKey = isObj ? opts.apiKey : apiKeyOrOpts;
  const audioWav = isObj ? (opts.wav || opts.audio || opts.file || Buffer.alloc(0)) : wav;
  const model = (typeof modelOrOpts === 'string' && modelOrOpts) || opts.model || 'whisper-large-v3-turbo';
  const terms = sanitizeSttTerms(opts.terms || opts.sttDictionary || opts.settings?.sttDictionary);
  const glossaryPrompt = typeof promptOrOpts === 'string'
    ? promptOrOpts
    : (opts.prompt !== undefined ? opts.prompt : (terms.length ? whisperGlossaryPrompt(terms) : ''));

  const fields = {
    model,
    language: opts.language || 'en',
    temperature: '0',
    response_format: 'verbose_json'
  };
  if (glossaryPrompt) fields.prompt = glossaryPrompt;

  const fetchFn = opts.fetchImpl || opts.fetch || (opts.useOpenAISdk ? null : global.fetch);
  if (typeof fetchFn === 'function' && !opts.useOpenAISdk) {
    const form = buildMultipartFormData(audioWav, fields);
    const base = (opts.baseURL || opts.baseUrl || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
    const res = await fetchFn(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': form.contentType
      },
      body: form.body,
      fields: form.fields
    });
    if (!res.ok) {
      const errText = typeof res.text === 'function' ? await res.text() : '';
      const err = new Error(`Groq Whisper HTTP ${res.status}: ${errText.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    let payload;
    if (typeof res.text === 'function') {
      const rawText = await res.text();
      try {
        payload = JSON.parse(rawText);
      } catch (_) {
        payload = rawText;
      }
    } else if (typeof res.json === 'function') {
      payload = await res.json();
    } else {
      payload = res;
    }
    return whisperTextWithoutHallucinations(payload, glossaryPrompt);
  }

  return transcribeOpenAI({
    apiKey,
    wav: audioWav,
    model,
    baseURL: opts.baseURL || 'https://api.groq.com/openai/v1',
    prompt: glossaryPrompt,
    responseFormat: 'verbose_json'
  });
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

async function transcribeGemini(apiKey, wav, modelId, fallbackModelId) {
  const { GoogleGenAI } = require('@google/genai');
  return transcribeGeminiWith(new GoogleGenAI({ apiKey }), wav, modelId, fallbackModelId);
}

function createSTT(settings = {}) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const terms = sanitizeSttTerms(settings.sttDictionary || settings.terms);
  const glossaryPrompt = terms.length > 0 ? whisperGlossaryPrompt(terms) : buildVocabPrompt(settings);
  const chain = [];
  // Each entry carries the model id it actually sends, so a failure can name
  // that id back to the user instead of a hardcoded one they never picked.
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    const model = settings.sttModel || 'whisper-1';
    chain.push({ p: 'openai', m: model, fn: (wav) => transcribeOpenAI(keys.openai, wav, model, undefined, glossaryPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'groq') && keys.groq) {
    const model = 'whisper-large-v3-turbo';
    chain.push({ p: 'groq', m: model, fn: (wav) => transcribeGroq(keys.groq, wav, model, glossaryPrompt) });
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
    chain.push({ p: 'custom', fn: (wav) => transcribeOpenAI(keys.custom, wav, settings.sttModel, settings.baseUrl, glossaryPrompt) });
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
      if (disabledUntil && now < disabledUntil) {
        return {
          text: '',
          error: {
            provider: lastProvider,
            cause: 'quota',
            message: describeSttError(lastProvider, { status: 429, message: 'quota or rate-limit cooldown' })
          }
        };
      }
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          disabledUntil = 0;
          lastProvider = c.p;
          const filtered = filterHallucination(text);
          if (!filtered || (terms.length > 0 && isGlossaryEcho(filtered, glossaryPrompt))) {
            return { text: '', provider: c.p };
          }
          return { text: filtered, provider: c.p };
        } catch (e) {
          const backOff = isQuotaError(e) || isRateLimitError(e);
          const cause = classifySttError(e);
          const statusMsg = describeSttError(c.p, e);
          const detailMsg = formatProviderErrorMessage(e, c.p, c.m);
          const message = cause !== 'unknown' ? `${statusMsg} (${detailMsg})` : detailMsg;
          lastErr = {
            status: e && e.status,
            code: e && e.code,
            cause,
            state: 'failed',
            message,
            provider: c.p,
            model: c.m
          };
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

module.exports = {
  createSTT,
  looksLikeHallucination,
  filterHallucination,
  whisperTextWithoutHallucinations,
  NO_SPEECH_PROB_THRESHOLD,
  LOW_CONFIDENCE_LOGPROB,
  SILENCE_HALLUCINATIONS,
  EXACT_BLOCKS,
  BRACKET_TOKEN_RE,
  MAX_STT_DICTIONARY_TERMS,
  MAX_STT_TERM_LENGTH,
  sanitizeSttTerms,
  deepgramHintParams,
  whisperGlossaryPrompt,
  isGlossaryEcho,
  classifySttError,
  describeSttError,
  formatSttFailureStatus,
  buildVocabPrompt,
  buildMultipartFormData,
  transcribeOpenAI,
  transcribeGroq,
  transcribeGemini,
  transcribeGeminiWith,
  extractGeminiTranscript,
  GEMINI_TRANSCRIBE_FALLBACK_MODEL
};
