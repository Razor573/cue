// LLM factory — OpenAI, Anthropic, Gemini, Vertex AI, and OpenAI-compatible APIs behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>

const { createCompatibleClientOptions } = require('./openai-compatible');
const publik = require('./publik');
const {
  VERTEX_MODEL_OPTIONS,
  validateServiceAccountJson,
  listVertexModels,
  streamVertexGenerateContent
} = require('./vertex-ai');

const CUSTOM_PROVIDER = 'custom';
const PUBLIK_PROVIDER = publik.PUBLIK_PROVIDER;
// gemini-2.0-flash was Google's default here until it was deprecated (Feb 2026)
// and fully retired (Mar 3 2026) — every request against it now 404s with a
// generic "exception parsing response" body. gemini-3.8-flash is the current
// Flash release (Aug 2026), so it is the single default used everywhere in
// this file and for Gemini transcription in stt.js / stt-streaming.js.
const CURRENT_GEMINI_DEFAULT = 'gemini-3.8-flash';
// Purpose-built speech-to-text model: no thinking tokens, returns nothing on
// silence, and answers with an `audioTranscription` part instead of `text`
// (see extractGeminiTranscript in stt.js). Falls back to
// CURRENT_GEMINI_DEFAULT if Google ever retires it.
const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
// Streaming counterpart over the Live API (bidiGenerateContent): word-by-word
// interim hypotheses plus a final on each pause. Used by GeminiLiveSTT in
// stt-streaming.js; the batch model above is the fallback when it fails.
const GEMINI_TRANSCRIBE_LIVE_MODEL = 'gemini-3.5-transcribe-live';
const GEMINI_STT_MODELS = [
  { id: 'gemini-3.5-transcribe', label: 'Gemini 3.5 Transcribe (Default transcription engine)' },
  { id: 'gemini-3.5-transcribe-live', label: 'Gemini 3.5 Transcribe Live (Streaming low-latency)' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (Multimodal audio transcription)' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash (Multimodal audio transcription)' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (Fast audio transcription)' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (Ultralight transcription)' },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon (High-precision transcription)' }
];

async function listGeminiSTTModels(apiKey, fetchImpl = fetch) {
  const curated = GEMINI_STT_MODELS.map((m) => ({ ...m }));
  const byId = new Map();
  for (const item of curated) {
    byId.set(item.id, item);
  }
  let live = false;
  let warning = '';
  if (apiKey && String(apiKey).trim()) {
    try {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(String(apiKey).trim())}`);
      if (res.ok) {
        const data = await res.json();
        const apiModels = (data.models || [])
          .map((m) => String(m.name || '').replace(/^models\//, '').trim())
          .filter((id) => /^gemini-[34]/i.test(id) && !DEAD_GEMINI_MODEL_RE.test(id))
          .filter((id) => /transcribe|audio|flash|argon/i.test(id) && !/embedding|imagen|veo|tts/i.test(id));
        for (const id of apiModels) {
          if (!byId.has(id)) {
            byId.set(id, { id, label: id });
          }
        }
        live = true;
      } else {
        warning = `Gemini models HTTP ${res.status}`;
      }
    } catch (err) {
      warning = (err && err.message) || String(err);
    }
  }
  return {
    ok: true,
    models: Array.from(byId.values()),
    live,
    ...(warning ? { warning } : {})
  };
}
// claude-3-5-haiku-latest / claude-3-5-sonnet-latest were retired by Anthropic
// (confirmed absent from GET https://api.anthropic.com/v1/models as of Sep 19
// 2026 — every claude-2.x and claude-3.x id 404s with not_found_error).
// claude-haiku-4-5-20251001 / claude-sonnet-4-5-20250929 are current and were
// live-verified with a real request before shipping this default.
const CURRENT_ANTHROPIC_DEFAULT_FAST = 'claude-haiku-4-5-20251001';
const CURRENT_ANTHROPIC_DEFAULT_SMART = 'claude-sonnet-4-5-20250929';
const DEFAULT_MODELS = {
  cerebras: 'qwen-3.8-27b',
  openai: 'gpt-4o-mini',
  anthropic: CURRENT_ANTHROPIC_DEFAULT_FAST,
  gemini: CURRENT_GEMINI_DEFAULT,
  vertex: { fast: 'gemini-3.8-flash', smart: 'gemini-4-argon' },
  ollama: 'llama3.2',
  groq: 'llama-3.1-8b-instant',
  minimax: 'MiniMax-M2.7',
  // deepseek-chat/deepseek-reasoner were retired 2026-07-24 and now 404; the
  // replacement aliases are deepseek-flash (non-thinking) and deepseek-v4-pro
  // (thinking), so those are the defaults used everywhere in this file.
  deepseek: 'deepseek-flash',
  azure: 'gpt-4o-mini',
  publik: publik.DEFAULT_MODELS.fast
};
const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

function buildCatalogEntry(fastList, smartList) {
  const byId = new Map();
  const fast = [];
  const smart = [];
  for (const item of fastList) {
    const entry = { ...item, tier: item.tier || 'fast' };
    fast.push(entry);
    byId.set(entry.id, entry);
  }
  for (const item of smartList) {
    const entry = { ...item, tier: item.tier || 'smart' };
    smart.push(entry);
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return {
    fast,
    smart,
    all: Array.from(byId.values())
  };
}

const PROVIDER_MODEL_CATALOG = {
  publik: buildCatalogEntry(
    [
      { id: 'publik-fast', label: 'publik Fast (Default)' },
      { id: 'publik-balanced', label: 'publik Balanced' }
    ],
    [
      { id: 'publik-balanced', label: 'publik Balanced (Default)' },
      { id: 'publik-smart', label: 'publik Smart' },
      { id: 'publik-fast', label: 'publik Fast' }
    ]
  ),
  vertex: buildCatalogEntry(
    VERTEX_MODEL_OPTIONS.filter((m) => m.tier === 'fast'),
    [
      ...VERTEX_MODEL_OPTIONS.filter((m) => m.tier === 'smart'),
      ...VERTEX_MODEL_OPTIONS.filter((m) => m.tier === 'fast')
    ]
  ),
  gemini: buildCatalogEntry(
    [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (Default)' },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' }
    ],
    [
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview (Default)' },
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' }
    ]
  ),
  openai: buildCatalogEntry(
    [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini (Default)' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
      { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano' },
      { id: 'gpt-4o', label: 'GPT-4o' }
    ],
    [
      { id: 'gpt-4o', label: 'GPT-4o (Default)' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'o3-mini', label: 'o3-mini' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' }
    ]
  ),
  anthropic: buildCatalogEntry(
    [
      { id: CURRENT_ANTHROPIC_DEFAULT_FAST, label: 'Claude Haiku 4.5 (Default)' },
      { id: CURRENT_ANTHROPIC_DEFAULT_SMART, label: 'Claude Sonnet 4.5' }
    ],
    [
      { id: CURRENT_ANTHROPIC_DEFAULT_SMART, label: 'Claude Sonnet 4.5 (Default)' },
      { id: CURRENT_ANTHROPIC_DEFAULT_FAST, label: 'Claude Haiku 4.5' }
    ]
  ),
  groq: buildCatalogEntry(
    [
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant (Default)' },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
      { id: 'qwen-qwq-32b', label: 'Qwen QwQ 32B' }
    ],
    [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile (Default)' },
      { id: 'qwen-qwq-32b', label: 'Qwen QwQ 32B' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' }
    ]
  ),
  cerebras: buildCatalogEntry(
    [
      { id: 'qwen-3.8-27b', label: 'Qwen 3.8 27B (Default)' },
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B' },
      { id: 'llama3.1-8b', label: 'Llama 3.1 8B' }
    ],
    [
      { id: 'qwen-3.8-27b', label: 'Qwen 3.8 27B (Default)' },
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B' }
    ]
  ),
  deepseek: buildCatalogEntry(
    [
      { id: 'deepseek-flash', label: 'DeepSeek Flash (Default)' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }
    ],
    [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro (Default)' },
      { id: 'deepseek-flash', label: 'DeepSeek Flash' }
    ]
  ),
  minimax: buildCatalogEntry(
    [
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7 (Default)' },
      { id: 'MiniMax-M3', label: 'MiniMax M3' }
    ],
    [
      { id: 'MiniMax-M3', label: 'MiniMax M3 (Default)' },
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' }
    ]
  ),
  ollama: buildCatalogEntry(
    [
      { id: 'llama3.2', label: 'Llama 3.2 (Default)' },
      { id: 'llama3.3', label: 'Llama 3.3' },
      { id: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B' },
      { id: 'gemma3:12b', label: 'Gemma 3 12B' }
    ],
    [
      { id: 'llama3.3', label: 'Llama 3.3 (Default)' },
      { id: 'llama3.2', label: 'Llama 3.2' },
      { id: 'qwen2.5-coder:14b', label: 'Qwen 2.5 Coder 14B' },
      { id: 'gemma3:12b', label: 'Gemma 3 12B' }
    ]
  ),
  azure: buildCatalogEntry(
    [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini (Default)' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
      { id: 'gpt-4o', label: 'GPT-4o' }
    ],
    [
      { id: 'gpt-4o', label: 'GPT-4o (Default)' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' }
    ]
  ),
  custom: buildCatalogEntry([], [])
};

// Gemini model ids that Google has since deprecated/retired (the 2.5 family
// went "no longer available to new users" in Sep 2026). A settings file saved
// before this fix can still have one of these persisted on disk, so
// resolveGeminiModel migrates them at read time rather than only fixing the
// default — otherwise an existing user would keep re-hitting the same 404
// forever.
const DEAD_GEMINI_MODEL_RE = /^gemini-(1\.0|1\.5|2\.0|2\.5)(?:-|$)/i;

// Single place that answers "which Gemini model should this request use?".
// Both the chat path (createLLM) and the transcription paths (src/stt.js,
// src/stt-streaming.js) go through here. STT used to skip this and hardcode
// the default instead, so a user who picked a working model in Settings still
// got 404s from a model they had never selected — the app reported a failure
// against a model id that appeared nowhere in their config.
function resolveGeminiModel(settings) {
  const s = settings || {};
  const tier = s.smart ? 'smart' : 'fast';
  const configured = ((s.models || {}).gemini || {})[tier];
  if (!configured || DEAD_GEMINI_MODEL_RE.test(configured)) return CURRENT_GEMINI_DEFAULT;
  return configured;
}

// Same self-heal, for Anthropic: matches every retired claude-2.x/claude-3.x
// id (including the "-latest" aliases), so a settings file saved back when
// claude-3-5-haiku-latest/claude-3-5-sonnet-latest were the shipped defaults
// (store.js's DEFAULTS.models.anthropic, before this fix) gets migrated to a
// live model on next read instead of permanently re-hitting the same 404.
const DEAD_ANTHROPIC_MODEL_RE = /^claude-(2(?:\.\d+)?(?:-|$)|3-)/i;

// Same story for DeepSeek's retired chat/reasoner aliases — map each to its
// closest current replacement rather than collapsing both to one default.
const DEAD_DEEPSEEK_MODEL_RE = /^deepseek-(chat|reasoner)$/i;
const CURRENT_DEEPSEEK_FAST_DEFAULT = 'deepseek-flash';
const CURRENT_DEEPSEEK_SMART_DEFAULT = 'deepseek-v4-pro';

const PROVIDER_LABELS = {
  azure: 'Azure AI Foundry',
  cerebras: 'Cerebras',
  openai: 'OpenAI',
  minimax: 'MiniMax',
  publik: publik.PROVIDER_LABEL,
  deepseek: 'DeepSeek',
  vertex: 'Vertex AI'
};

// DeepSeek is OpenAI-compatible and reuses the OpenAI screenshot/streaming path via baseURL.
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function normalizeProviderName(provider) {
  if (!provider) return 'provider';
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

// A 429 on its own says only "slow down" — it never says the account is out of
// credit. So quota exhaustion is recognised ONLY from an upstream body that
// actually claims it (OpenAI `insufficient_quota`, Gemini `RESOURCE_EXHAUSTED`,
// or plain "exceeded your current quota"/quota/billing wording); every other
// 429 is reported as the rate limit it is. Anthropic's API has no quota concept
// at all — every Anthropic 429 is a per-minute rate_limit_error whose envelope
// is {type:'error', error:{type:'rate_limit_error', message}} (SDKs expose the
// whole envelope as error.error, so the real type sits at error.error.error.type)
// — so under the old `status === 429` rule an Anthropic user could never avoid
// the false "free-tier quota exhausted" message.
function errorSignals(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const upstreamType = error && (error.error?.error?.type || error.error?.type);
  const rawMessage = (error && (error.message || String(error))) || '';
  return { status, code, upstreamType, text: `${rawMessage} ${code || ''} ${upstreamType || ''}`.toLowerCase() };
}

// The two upstream codes that mean "this is a burst/per-minute limit", never
// "your account is empty".
function hasRateLimitSignal({ code, upstreamType }) {
  return code === 'rate_limit_exceeded' || upstreamType === 'rate_limit_error';
}

// Pulled out so both the LLM and STT error paths (llm.js and stt.js) agree on
// what counts as a quota failure instead of drifting independently.
function isQuotaError(error) {
  const signals = errorSignals(error);
  const { code, upstreamType, text } = signals;
  if (code === 'insufficient_quota' || code === 'RESOURCE_EXHAUSTED' ||
      upstreamType === 'insufficient_quota' || upstreamType === 'RESOURCE_EXHAUSTED') return true;
  if (hasRateLimitSignal(signals)) return false;
  return /insufficient_quota|resource_exhausted|exceeded your current quota|\bquota\b|\bbilling\b/i.test(text);
}

// Everything else that 429s (including a bare 429 with no body at all, which is
// what most providers send under load) is a rate limit, not exhaustion.
function isRateLimitError(error) {
  if (isQuotaError(error)) return false;
  const signals = errorSignals(error);
  const { status, code, text } = signals;
  return status === 429 || code === 429 || hasRateLimitSignal(signals) ||
    /\b429\b|too many requests|rate limit/i.test(text);
}

function isNotFoundError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${status || ''} ${code || ''}`.toLowerCase();
  return status === 404 || code === 404 || /\b404\b|is not found for api version|model not found/i.test(text);
}

// Gemini 429 bodies often carry a google.rpc.RetryInfo detail like
// {"retryDelay":"38s"} inside the JSON error text. Not every quota error has
// one (OpenAI/Anthropic don't), so this is best-effort and returns null when
// absent instead of guessing a wait time.
function extractRetryDelaySeconds(rawMessage) {
  const match = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(String(rawMessage || ''));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function formatRetryWait(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Structured errors for publik so main.js can offer a button, not just a sentence.
function publikError(message, action) {
  const e = new Error(message);
  e.action = action || null;
  return e;
}

function isConnectionError(error) {
  const name = error && error.name;
  const text = (error && (error.message || String(error))) || '';
  return name === 'APIConnectionError' || name === 'APIConnectionTimeoutError' ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network|connection error|aborted/i.test(text);
}

// publik gateway failures, mapped BEFORE isQuotaError: its regex matches
// "billing"/"quota" in message text and the generic 429 copy tells the user to
// "add billing to your publik API account", which is wrong for publik. Reads
// the openai SDK's APIError shape (status, error = the envelope's inner
// object, headers) and falls through (null) for anything not publik-specific.
function describePublikError(error, model) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const body = error && (error.error || error.response?.data?.error || null);
  const headers = error && error.headers;
  const retryAfter = headers ? (typeof headers.get === 'function' ? headers.get('retry-after') : (headers['retry-after'] || headers['Retry-After'])) : null;
  if (!status && !isConnectionError(error)) return null;
  const described = publik.describeGatewayError({ status, body, model, retryAfter });
  return described ? publikError(described.message, described.action) : null;
}

function formatProviderErrorMessage(error, provider, model) {
  const label = normalizeProviderName(provider);
  const rawMessage = (error && (error.message || String(error))) || '';

  if (provider === PUBLIK_PROVIDER) {
    const described = describePublikError(error, model);
    if (described) return described;
  }

  if (isQuotaError(error)) {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds ? ` Wait about ${formatRetryWait(retrySeconds)}` : ' Wait a moment';
    return `${label} free-tier quota exhausted (429 Too Many Requests).${waitHint} and try again, or add billing to your ${label} account. You can also switch providers or models in Settings.`;
  }

  if (isRateLimitError(error)) {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds ? ` Wait about ${formatRetryWait(retrySeconds)}` : ' Wait a moment';
    return `${label} is rate-limiting requests right now (429 Too Many Requests).${waitHint} and try again — this is a temporary per-minute/request limit, not your account running out of credit.`;
  }

  if (isNotFoundError(error)) {
    const modelHint = model ? ` "${model}"` : '';
    return `${label} model${modelHint} is unavailable (404) — it may have been renamed, retired by the provider, or misspelled. Open Settings and pick a current model for ${label} (or clear the field to use cue's default), then try again.`;
  }

  return rawMessage || 'Unknown LLM error.';
}

function sanitizeTurns(turns) {
  const valid = new Set(['user', 'assistant']);
  return (turns || []).filter(t => valid.has(t.role)).map(t => ({ role: t.role, text: String(t.text || '') }));
}

// MiniMax is OpenAI-compatible and exposes two regional gateways. MiniMax-M3
// accepts image input, so it reuses the OpenAI screenshot path via baseURL.
const MINIMAX_BASE_URLS = {
  global_en: 'https://api.minimax.io/v1',
  cn_zh: 'https://api.minimaxi.com/v1'
};

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

async function streamOpenAI({ apiKey, baseURL, model, system, turns, imageDataUrl, maxTokens, onToken, onResponse, onThought }) {
  const OpenAI = require('openai');
  const client = new OpenAI(baseURL ? { apiKey, baseURL } : { apiKey });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({
        role: 'user', content: [
          { type: 'text', text: t.text },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const pending = client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens });
  let stream;
  if (typeof onResponse === 'function' && pending && typeof pending.withResponse === 'function') {
    // The gateway stamps x-publik-* headers at admission; hand the raw
    // Response to the caller so the balance line can move before settlement.
    const { data, response } = await pending.withResponse();
    try { onResponse(response); } catch { /* a display hook must never break the answer */ }
    stream = data;
  } else {
    stream = await pending;
  }
  let full = '';
  for await (const part of stream) {
    const delta = part.choices && part.choices[0] && part.choices[0].delta;
    if (delta) {
      if (delta.reasoning_content) {
        if (typeof onThought === 'function') onThought(delta.reasoning_content);
      } else if (delta.reasoning) {
        if (typeof onThought === 'function') onThought(delta.reasoning);
      }
      if (delta.content) {
        full += delta.content;
        onToken(delta.content);
      }
    }
  }
  return full;
}

// Azure AI Foundry Models API (cognitiveservices.azure.com hosts) lives under
// {endpoint}/openai/v1 and authenticates with the `api-key` header.
function normalizeAzureBaseURL(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  if (!u) return '';
  if (/cognitiveservices\.azure\.com/i.test(u) && !/\/openai\/v1$/i.test(u)) {
    u += '/openai/v1';
  }
  return u;
}

async function streamAzure({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, endpoint }) {
  const url = normalizeAzureBaseURL(endpoint);
  if (!url) throw new Error('Missing Azure endpoint. Add your Azure AI Foundry or Azure OpenAI endpoint in Settings.');
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const OpenAI = require('openai');
  let client;
  if (/openai\.azure\.com/i.test(url)) {
    client = new OpenAI.AzureOpenAI({ endpoint: url.replace(/\/openai$/i, ''), apiKey, apiVersion: '2024-10-21' });
  } else {
    // Foundry / OpenAI-compatible base: force the `api-key` header and drop the
    // Authorization header the SDK adds by default (those hosts don't take a Bearer key).
    const azureFetch = async (input, init) => {
      const headers = new Headers(init && init.headers);
      headers.set('api-key', apiKey);
      headers.delete('authorization');
      return fetch(input, { ...init, headers });
    };
    client = new OpenAI({ baseURL: url, apiKey, fetch: azureFetch });
  }
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_completion_tokens: maxTokens });
  let full = '';
  for await (const part of stream) {
    const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, onThought }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true });
  let full = '';
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
        if (typeof onThought === 'function') onThought(ev.delta.thinking);
      } else if (ev.delta.type === 'text_delta' && ev.delta.text) {
        full += ev.delta.text;
        onToken(ev.delta.text);
      }
    }
  }
  return full;
}

// Gemini 3.x counts its internal "thinking" tokens against maxOutputTokens, so
// a 700-token cap was mostly eaten by reasoning and the visible answer came
// back truncated mid-sentence (measured: 3.8-flash spends ~390 thinking tokens
// on a short notes prompt by default). Fast tier: thinkingLevel "low", which
// on flash means no thinking at all (0 thought tokens, ~3x faster). Smart tier:
// leave the model's default reasoning alone. Either way, give the cap headroom
// for thoughts so the visible budget is what maxTokens says.
// (thinkingBudget: 0 is rejected by pro models and "minimal" by flash, so
// "low" is the one setting that works across the family.)
const GEMINI_THINKING_HEADROOM = { fast: 1024, smart: 4096 };
function geminiGenerationConfig({ system, maxTokens, thinking, thinkingLevel, webSearch = false, includeThoughts = false, model = '' }) {
  const config = {
    systemInstruction: system,
    maxOutputTokens: maxTokens + (thinking ? GEMINI_THINKING_HEADROOM.smart : GEMINI_THINKING_HEADROOM.fast)
  };
  const cleanModel = String(model || '').trim();
  const isGemini3or4 = cleanModel ? /^gemini-[34]/i.test(cleanModel) : true;
  const lvl = String(thinkingLevel || (thinking ? 'medium' : 'low')).toLowerCase();

  if (includeThoughts) {
    config.thinkingConfig = isGemini3or4
      ? { thinkingLevel: lvl, includeThoughts: true }
      : { includeThoughts: true, thinkingBudget: -1 };
  } else if (thinkingLevel) {
    config.thinkingConfig = isGemini3or4
      ? { thinkingLevel: lvl }
      : { thinkingBudget: -1 };
  } else if (!thinking) {
    config.thinkingConfig = { thinkingLevel: 'low' };
  }
  if (webSearch) {
    config.tools = [{ googleSearch: {} }];
  }
  return config;
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, thinking, thinkingLevel, webSearch, signal, onToken, onThought }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const config = geminiGenerationConfig({ system, maxTokens, thinking, thinkingLevel, webSearch, includeThoughts: true, model });
  let stream;
  try {
    stream = await ai.models.generateContentStream({ model, contents, config });
  } catch (e) {
    if (!config.thinkingConfig || !/thinking/i.test((e && e.message) || '')) throw e;
    try {
      config.thinkingConfig = { includeThoughts: true, thinkingBudget: -1 };
      stream = await ai.models.generateContentStream({ model, contents, config });
    } catch (e2) {
      if (!/thinking/i.test((e2 && e2.message) || '')) throw e2;
      delete config.thinkingConfig;
      stream = await ai.models.generateContentStream({ model, contents, config });
    }
  }
  let full = '';
  for await (const chunk of stream) {
    if (signal && signal.aborted) {
      throw new Error('Aborted');
    }
    const parts = chunk.candidates?.[0]?.content?.parts;
    if (parts && Array.isArray(parts)) {
      for (const part of parts) {
        if (!part || typeof part.text !== 'string') continue;
        if (part.thought === true) {
          if (typeof onThought === 'function') onThought(part.text);
        } else {
          full += part.text;
          if (typeof onToken === 'function') onToken(part.text);
        }
      }
    } else {
      const t = chunk && chunk.text;
      if (t) {
        full += t;
        if (typeof onToken === 'function') onToken(t);
      }
    }
  }
  return full;
}

async function streamOllama({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const baseUrl = apiKey || 'http://localhost:11434';
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;

  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) {
        messages.push({ role: 'user', content: t.text, images: [img.b64] });
      } else {
        messages.push({ role: 'user', content: t.text });
      }
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true })
    });
  } catch (err) {
    throw new Error(`Ollama fetch failed: ${err.message}. Is Ollama running at ${baseUrl}?`);
  }

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.message && data.message.content) {
          full += data.message.content;
          onToken(data.message.content);
        }
      } catch (e) {
        // ignore
      }
    }
  }
  if (buffer.trim()) {
    try {
      const data = JSON.parse(buffer);
      if (data.message && data.message.content) {
        full += data.message.content;
        onToken(data.message.content);
      }
    } catch (e) { }
  }
  return full;
}

function resolveVertexModel(settings) {
  const s = settings || {};
  const tier = s.smart ? 'smart' : 'fast';
  const configured = ((s.models || {}).vertex || {})[tier];
  const fallback = tier === 'smart' ? 'gemini-4-argon' : CURRENT_GEMINI_DEFAULT;
  if (!configured || DEAD_GEMINI_MODEL_RE.test(configured)) return fallback;
  return configured;
}

function createLLM(settings, fetchImpl = fetch) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  let apiKey = keys[provider];
  let baseURL = '';
  let configurationError = '';
  const tier = settings.smart ? 'smart' : 'fast';
  const models = settings.models || {};
  let model = (models[provider] || {})[tier];
  if (provider === 'gemini') {
    model = resolveGeminiModel(settings);
  }
  if (provider === 'vertex') {
    model = resolveVertexModel(settings);
  }
  if (provider === PUBLIK_PROVIDER && !model) model = publik.DEFAULT_MODELS[tier];
  if (provider === 'anthropic' && DEAD_ANTHROPIC_MODEL_RE.test(model || '')) {
    model = tier === 'smart' ? CURRENT_ANTHROPIC_DEFAULT_SMART : CURRENT_ANTHROPIC_DEFAULT_FAST;
  }
  if (provider === 'deepseek' && DEAD_DEEPSEEK_MODEL_RE.test(model || '')) {
    model = /reasoner/i.test(model) ? CURRENT_DEEPSEEK_SMART_DEFAULT : CURRENT_DEEPSEEK_FAST_DEFAULT;
  }
  if (!model) {
    const def = DEFAULT_MODELS[provider];
    model = (def && typeof def === 'object') ? (def[tier] || def.fast || '') : (def || '');
  }
  const minimaxRegion = settings.minimaxRegion || 'global_en';
  const endpoint = settings.azureEndpoint || '';
  const vertexProject = String(settings.vertexProject || '').trim();
  const vertexLocation = String(settings.vertexLocation || 'global').trim() || 'global';

  if (provider === PUBLIK_PROVIDER) {
    // The packaged-build default: an OpenAI-compatible endpoint with a fixed
    // base URL (the provisioning response's, else the build's) and the key the
    // install minted. Never settings.baseUrl — that is the user's Custom slot.
    const base = (settings.publik && settings.publik.baseUrl) || publik.DEFAULT_BASE_URL;
    try {
      baseURL = createCompatibleClientOptions(apiKey, base).baseURL;
    } catch (error) {
      configurationError = error.message;
    }
    if (!apiKey) configurationError = `${publik.PROVIDER_LABEL} is not set up on this computer yet.`;
  } else if (provider === CUSTOM_PROVIDER) {
    try {
      const clientOptions = createCompatibleClientOptions(apiKey, settings.baseUrl);
      apiKey = clientOptions.apiKey;
      baseURL = clientOptions.baseURL;
    } catch (error) {
      configurationError = error.message;
    }
    if (!model && !configurationError) {
      configurationError = 'Set a Fast or Smart model for the Custom provider.';
    }
  } else if (provider === 'vertex') {
    let saProject = '';
    if (apiKey && String(apiKey).trim()) {
      try {
        const parsedSa = validateServiceAccountJson(apiKey);
        saProject = parsedSa.projectId || '';
      } catch (err) {
        configurationError = err.message;
      }
    }
    const effectiveProject = vertexProject || saProject || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
    if (!configurationError && !effectiveProject && !apiKey) {
      configurationError = 'Add your Vertex AI GCP Project ID or paste a Service Account JSON key in Settings.';
    }
  } else if (provider !== 'ollama' && !apiKey) {
    // Ollama is a local server: the field holds a URL, and no key is required.
    configurationError = `Add your ${provider} API key in Settings.`;
  }

  // Azure needs a second credential: the resource endpoint.
  if (!configurationError && provider === 'azure' && !endpoint) {
    configurationError = 'Add your Azure AI Foundry endpoint in Settings.';
  }

  const ready = !configurationError && !!model;
  const maxTokens = settings.smart ? 12288 : 8192;

  return {
    provider, model, apiKey, baseURL,
    ready,
    configurationError,
    async stream(params) {
      if (!ready) throw new Error(configurationError || `Complete the ${provider} provider settings.`);
      const args = { apiKey, baseURL, endpoint, model, maxTokens, thinking: !!settings.smart, ...params, turns: sanitizeTurns(params.turns) };
      try {
        if (provider === 'vertex') {
          const res = await streamVertexGenerateContent(
            {
              serviceAccountJson: apiKey || '',
              projectId: vertexProject,
              location: vertexLocation,
              thinkingLevel: settings.vertexThinkingLevel || (settings.smart ? 'HIGH' : 'LOW'),
              webSearch: !!settings.vertexWebSearch
            },
            {
              model,
              system: args.system,
              turns: args.turns,
              imageDataUrl: args.imageDataUrl,
              maxTokens: args.maxTokens,
              temperature: args.temperature,
              thinkingLevel: settings.vertexThinkingLevel || (settings.smart ? 'HIGH' : 'LOW'),
              webSearch: !!settings.vertexWebSearch,
              includeThoughts: true,
              signal: args.signal,
              onToken: args.onToken,
              onThought: args.onThought
            },
            fetchImpl
          );
          return res.fullText;
        }
        if (provider === 'openai') return await streamOpenAI(args);
        if (provider === CUSTOM_PROVIDER) return await streamOpenAI(args);
        if (provider === PUBLIK_PROVIDER) return await streamOpenAI(args);
        if (provider === 'ollama') return await streamOllama(args);
        if (provider === 'groq') return await streamOpenAI({ ...args, baseURL: 'https://api.groq.com/openai/v1' });
        if (provider === 'cerebras') return await streamOpenAI({ ...args, baseURL: CEREBRAS_BASE_URL });
        if (provider === 'minimax') return await streamOpenAI({ ...args, baseURL: MINIMAX_BASE_URLS[minimaxRegion] || MINIMAX_BASE_URLS.global_en });
        if (provider === 'deepseek') return await streamOpenAI({ ...args, baseURL: DEEPSEEK_BASE_URL });
        if (provider === 'anthropic') return await streamAnthropic(args);
        if (provider === 'gemini') return await streamGemini({
          ...args,
          thinkingLevel: settings.geminiThinkingLevel || 'MEDIUM',
          webSearch: !!settings.geminiWebSearch,
          onThought: args.onThought
        });
        if (provider === 'azure') return await streamAzure(args);
        throw new Error('unknown provider: ' + provider);
      } catch (error) {
        // publik branches return an Error carrying `.action`; the string
        // branches keep working unchanged.
        const wrapped = formatProviderErrorMessage(error, provider, model);
        throw wrapped instanceof Error ? wrapped : new Error(wrapped);
      }
    }
  };
}

function mergeCatalogModels(curatedEntry, liveModels = []) {
  const base = curatedEntry || { fast: [], smart: [], all: [] };
  const byId = new Map();
  for (const item of base.all) {
    byId.set(item.id, { ...item });
  }
  for (const item of liveModels) {
    const id = typeof item === 'string' ? item.trim() : String(item.id || '').trim();
    if (!id) continue;
    if (DEAD_GEMINI_MODEL_RE.test(id) || DEAD_ANTHROPIC_MODEL_RE.test(id) || DEAD_DEEPSEEK_MODEL_RE.test(id)) continue;
    if (!byId.has(id)) {
      const isSmart = item.tier
        ? item.tier === 'smart'
        : /pro|argon|sonnet|opus|gpt-4o(?!-mini)|gpt-4\.1(?!-mini|-nano)|o1|o3|70b|v4/i.test(id);
      byId.set(id, {
        id,
        label: item.label || id,
        tier: isSmart ? 'smart' : 'fast'
      });
    }
  }
  const all = Array.from(byId.values());
  const fastModels = all.filter((m) => m.tier === 'fast');
  const smartModels = all.filter((m) => m.tier === 'smart');
  return {
    models: all,
    fastModels: fastModels.length ? fastModels : all,
    smartModels: smartModels.length ? smartModels : all
  };
}

async function listProviderModels(settings = {}, override = {}, fetchImpl = fetch) {
  const provider = String(override.provider || settings.provider || 'openai').trim();
  const keys = settings.apiKeys || {};
  const effectiveKey = override.clearKey
    ? ''
    : (override.apiKey !== undefined && String(override.apiKey).trim() !== ''
      ? String(override.apiKey).trim()
      : String(keys[provider] || '').trim());

  const curated = PROVIDER_MODEL_CATALOG[provider] || { fast: [], smart: [], all: [] };
  let liveModels = [];
  let live = false;
  let warning = '';

  try {
    if (provider === 'vertex') {
      const vertexRes = await listVertexModels(
        {
          serviceAccountJson: effectiveKey,
          projectId: override.vertexProject !== undefined ? override.vertexProject : (settings.vertexProject || ''),
          location: override.vertexLocation !== undefined ? override.vertexLocation : (settings.vertexLocation || 'global')
        },
        fetchImpl
      );
      liveModels = vertexRes.models || [];
      live = true;
    } else if (provider === 'gemini' && effectiveKey) {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(effectiveKey)}`);
      if (res.ok) {
        const data = await res.json();
        liveModels = (data.models || [])
          .map((m) => String(m.name || '').replace(/^models\//, '').trim())
          .filter((id) => /^gemini-(3|4)/i.test(id) && !/embedding|imagen|veo|tts|live|transcribe/i.test(id))
          .map((id) => ({ id, label: id, tier: /pro|argon/i.test(id) ? 'smart' : 'fast' }));
        live = true;
      } else {
        warning = `Gemini models HTTP ${res.status}`;
      }
    } else if ((provider === 'openai' || provider === 'groq' || provider === 'cerebras' || provider === 'deepseek') && effectiveKey) {
      const baseMap = {
        openai: 'https://api.openai.com/v1',
        groq: 'https://api.groq.com/openai/v1',
        cerebras: CEREBRAS_BASE_URL,
        deepseek: `${DEEPSEEK_BASE_URL}/v1`
      };
      const res = await fetchImpl(`${baseMap[provider]}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${effectiveKey}` }
      });
      if (res.ok) {
        const data = await res.json();
        liveModels = (data.data || [])
          .map((m) => String(m.id || '').trim())
          .filter((id) => id && !/whisper|tts|embedding|moderation|dall-e|audio|realtime/i.test(id))
          .map((id) => ({ id, label: id }));
        live = true;
      } else {
        warning = `${normalizeProviderName(provider)} models HTTP ${res.status}`;
      }
    } else if (provider === 'ollama') {
      const host = String(override.ollamaHost || effectiveKey || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetchImpl(`${host}/api/tags`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        liveModels = (data.models || [])
          .map((m) => String(m.name || m.model || '').trim())
          .filter(Boolean)
          .map((id) => ({ id, label: id, tier: 'fast' }));
        live = true;
      } else {
        warning = `Ollama tags HTTP ${res.status}`;
      }
    }
  } catch (err) {
    warning = (err && err.message) || String(err);
  }

  const merged = mergeCatalogModels(curated, liveModels);
  return {
    ok: true,
    provider,
    models: merged.models,
    fastModels: merged.fastModels,
    smartModels: merged.smartModels,
    live,
    ...(warning ? { warning } : {})
  };
}

async function testProviderConnection(settings = {}, override = {}, fetchImpl = fetch) {
  const startedAt = Date.now();
  const provider = String(override.provider || settings.provider || 'openai').trim();
  const keys = { ...(settings.apiKeys || {}) };
  if (override.clearKey) {
    keys[provider] = '';
  } else if (override.apiKey !== undefined && String(override.apiKey).trim() !== '') {
    keys[provider] = String(override.apiKey).trim();
  }

  const currentModels = (settings.models && settings.models[provider]) || {};
  const fastModel = override.fastModel !== undefined && String(override.fastModel).trim() !== ''
    ? String(override.fastModel).trim()
    : (currentModels.fast || '');
  const smartModel = override.smartModel !== undefined && String(override.smartModel).trim() !== ''
    ? String(override.smartModel).trim()
    : (currentModels.smart || '');

  const effectiveSettings = {
    ...settings,
    provider,
    smart: false,
    apiKeys: keys,
    baseUrl: override.baseUrl !== undefined ? override.baseUrl : settings.baseUrl,
    azureEndpoint: override.azureEndpoint !== undefined ? override.azureEndpoint : settings.azureEndpoint,
    minimaxRegion: override.minimaxRegion !== undefined ? override.minimaxRegion : settings.minimaxRegion,
    vertexProject: override.vertexProject !== undefined ? override.vertexProject : settings.vertexProject,
    vertexLocation: override.vertexLocation !== undefined ? override.vertexLocation : (settings.vertexLocation || 'global'),
    vertexThinkingLevel: override.vertexThinkingLevel !== undefined ? override.vertexThinkingLevel : (settings.vertexThinkingLevel || 'LOW'),
    vertexWebSearch: override.vertexWebSearch !== undefined ? !!override.vertexWebSearch : !!settings.vertexWebSearch,
    models: {
      ...(settings.models || {}),
      [provider]: {
        fast: fastModel,
        smart: smartModel
      }
    }
  };

  if (provider === 'ollama' && override.ollamaHost) {
    effectiveSettings.apiKeys.ollama = String(override.ollamaHost).trim();
  }

  if (provider === 'vertex') {
    const targetModel = resolveVertexModel(effectiveSettings);
    const vertexConfig = {
      serviceAccountJson: effectiveSettings.apiKeys.vertex || '',
      projectId: effectiveSettings.vertexProject || '',
      location: effectiveSettings.vertexLocation || 'global',
      thinkingLevel: effectiveSettings.vertexThinkingLevel || 'LOW',
      webSearch: false
    };
    try {
      const listRes = await listVertexModels(vertexConfig, fetchImpl);
      if (listRes.projectId && !vertexConfig.projectId) {
        vertexConfig.projectId = listRes.projectId;
      }
      const genRes = await streamVertexGenerateContent(
        vertexConfig,
        {
          model: targetModel,
          turns: [{ role: 'user', text: 'Reply with exactly: OK' }],
          maxTokens: 16,
          temperature: 0
        },
        fetchImpl
      );
      return {
        ok: true,
        provider: 'vertex',
        model: genRes.model || targetModel,
        region: genRes.region || vertexConfig.location,
        reply: (genRes.fullText || 'OK').trim(),
        modelCount: listRes.models.length,
        authMode: listRes.authMode,
        latencyMs: Math.max(1, Date.now() - startedAt)
      };
    } catch (err) {
      const formatted = formatProviderErrorMessage(err, 'vertex', targetModel);
      return {
        ok: false,
        provider: 'vertex',
        model: targetModel,
        error: formatted instanceof Error ? formatted.message : String(formatted),
        latencyMs: Math.max(1, Date.now() - startedAt)
      };
    }
  }

  const llm = createLLM(effectiveSettings, fetchImpl);
  if (!llm.ready) {
    return {
      ok: false,
      provider,
      model: llm.model || '',
      error: llm.configurationError || `Complete the ${normalizeProviderName(provider)} settings first.`,
      latencyMs: Math.max(1, Date.now() - startedAt)
    };
  }

  try {
    let reply = '';
    const streamed = await llm.stream({
      system: 'You are a connectivity check. Reply with the single word OK.',
      turns: [{ role: 'user', text: 'Reply with exactly: OK' }],
      maxTokens: 16,
      onToken: (t) => { reply += t; }
    });
    const finalReply = (streamed || reply || 'OK').trim();
    return {
      ok: true,
      provider,
      model: llm.model,
      reply: finalReply,
      latencyMs: Math.max(1, Date.now() - startedAt)
    };
  } catch (err) {
    return {
      ok: false,
      provider,
      model: llm.model,
      error: (err && err.message) || String(err),
      latencyMs: Math.max(1, Date.now() - startedAt)
    };
  }
}

module.exports = {
  DEFAULT_MODELS,
  createLLM,
  formatProviderErrorMessage,
  isQuotaError,
  isNotFoundError,
  geminiGenerationConfig,
  resolveGeminiModel,
   resolveVertexModel,
  CURRENT_GEMINI_DEFAULT,
  GEMINI_TRANSCRIBE_MODEL,
  GEMINI_TRANSCRIBE_LIVE_MODEL,
  CURRENT_ANTHROPIC_DEFAULT_FAST,
  CURRENT_ANTHROPIC_DEFAULT_SMART,
  PUBLIK_PROVIDER,
  PROVIDER_LABELS,
  PROVIDER_MODEL_CATALOG,
  listProviderModels,
  testProviderConnection,
  isRateLimitError,
  GEMINI_STT_MODELS,
  listGeminiSTTModels
};
