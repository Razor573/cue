// LLM factory — OpenAI, Anthropic, Gemini, Vertex AI, and OpenAI-compatible APIs behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>

const crypto = require('crypto');
const { createCompatibleClientOptions } = require('./openai-compatible');
const publik = require('./publik');
const {
  VERTEX_MODEL_OPTIONS,
  validateServiceAccountJson,
  listVertexModels,
  streamVertexGenerateContent
} = require('./vertex-ai');
const {
  getAntigravityStatus,
  listAntigravityModels,
  resolveAntigravityWireModel,
  streamAntigravity
} = require('./antigravity');
const {
  CODEX_MODEL_OPTIONS,
  getCodexStatus,
  streamCodexResponses
} = require('./codex');

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
const GEMINI_TRANSCRIBE_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_STT_MODELS = [
  { id: 'gemini-3.5-transcribe', label: 'Gemini 3.5 Transcribe · Fast (~400ms) · Dedicated ASR word-level accuracy · $0.31/hr (10 RPM)' },
  { id: 'gemini-3.5-transcribe-live', label: 'Gemini 3.5 Transcribe Live · Sub-second streaming · Real-time live accuracy · $0.54/hr' },
  { id: 'gemini-3.8-live', label: 'Gemini 3.8 Live · Instant (~200ms) · Conversational voice audio · $1.35/hr' },
  { id: 'gemini-3.8-live-extended-thinking', label: 'Gemini 3.8 Live Extended Thinking · Instant (~200ms) + reasoning · Deep voice comprehension · $2.10/hr' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite · Ultra-fast (~300ms) · Good accuracy · $0.05/hr (4,000 RPM, safest against 429s)' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash · Very fast (~500ms) · High accuracy & context understanding · $0.11/hr' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash · Fast (~450ms) · Balanced accuracy & speed · $0.08/hr' },
  { id: 'gemini-3.5-live-translate-preview', label: 'Gemini 3.5 Live Translate · Low latency · Speech translation & multilingual voice · $0.54/hr' }
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
          .filter((id) => /transcribe|audio|live/i.test(id) && !/pro|argon|embedding|imagen|veo|tts/i.test(id));
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
  gemini: { fast: 'gemini-4-hydrogen', smart: 'gemini-3.1-pro-preview' },
  vertex: { fast: 'gemini-4-hydrogen', smart: 'gemini-4-argon' },
  antigravity: { fast: 'gemini-4-hydrogen', smart: 'gemini-3.1-pro-high' },
  codex: { fast: 'gpt-5.5', smart: 'gpt-5.5-codex' },
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
  antigravity: buildCatalogEntry(
    [
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (Default)' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' }
    ],
    [
      { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro High (Default)' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' }
    ]
  ),
  codex: buildCatalogEntry(
    [
      { id: 'gpt-5.5', label: 'gpt-5.5 (Default)' },
      { id: 'gpt-5.5-codex', label: 'gpt-5.5-codex' },
      { id: 'gpt-5.4-codex', label: 'gpt-5.4-codex' },
      { id: 'gpt-5.2-codex', label: 'gpt-5.2-codex' },
      { id: 'gpt-5.2', label: 'gpt-5.2' },
      { id: 'gpt-5.1-codex', label: 'gpt-5.1-codex' }
    ],
    [
      { id: 'gpt-5.5-codex', label: 'gpt-5.5-codex (Default)' },
      { id: 'gpt-5.4-codex', label: 'gpt-5.4-codex' },
      { id: 'gpt-5.5', label: 'gpt-5.5' },
      { id: 'gpt-5.2-codex', label: 'gpt-5.2-codex' },
      { id: 'gpt-5.2', label: 'gpt-5.2' },
      { id: 'gpt-5.1-codex', label: 'gpt-5.1-codex' }
    ]
  ),
  gemini: buildCatalogEntry(
    [
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (Default)' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
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
  vertex: 'Vertex AI',
  antigravity: 'Antigravity',
  codex: 'Codex'
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

  if (provider === 'codex') {
    const status = error && (error.status || error.statusCode || error.response?.status);
    if (status === 429 || (error && error.code === 'plan_limit') || /chatgpt plan limit|usage_limit|rate_limit/i.test(rawMessage)) {
      return /chatgpt plan limit/i.test(rawMessage)
        ? rawMessage
        : 'ChatGPT plan limit reached (429). Please wait for your ChatGPT subscription window to reset or switch providers.';
    }
    if (/session expired/i.test(rawMessage)) {
      return rawMessage;
    }
  }

  if (provider === 'antigravity' && /session expired/i.test(rawMessage)) {
    return rawMessage;
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

// ============================================================================
// Step 9.2: Claude Prompt Caching (cache_control: { type: 'ephemeral' })
// ============================================================================

function getClaudeCacheMinChars(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  if (/^claude-opus-4-[01](-|$)/i.test(id)) return 1024 * 4;
  if (/^claude-opus-4-/i.test(id) || /^claude-haiku-4-5/i.test(id)) return 4096 * 4;
  if (/^claude-sonnet-4-6/i.test(id)) return 2048 * 4;
  if (/^claude-3-5-haiku/i.test(id) || /^claude-haiku-3-5/i.test(id)) return 2048 * 4;
  if (/^claude-/i.test(id)) return 1024 * 4;
  return 4096 * 4;
}

function buildClaudeSystemBlocks(systemPrompt, modelId) {
  if (!systemPrompt) return undefined;
  const text = String(systemPrompt);
  if (text.length >= getClaudeCacheMinChars(modelId)) {
    return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  }
  return [{ type: 'text', text }];
}

function buildAnthropicMessages(turns = [], imageDataUrl = null) {
  const list = Array.isArray(turns) ? turns : [];
  return list.map((t, i) => {
    const last = i === list.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
}

async function streamAnthropic({ apiKey, client: injectedClient, model, system, turns, imageDataUrl, maxTokens, onToken, onThought }) {
  const client = injectedClient || new (require('@anthropic-ai/sdk'))({ apiKey });
  const messages = buildAnthropicMessages(turns, imageDataUrl);
  const useCacheBlocks = typeof system === 'string' && system.length >= getClaudeCacheMinChars(model);
  const systemParam = useCacheBlocks ? buildClaudeSystemBlocks(system, model) : system;

  const consumeStream = async (sysValue) => {
    const createFn = (client.messages && typeof client.messages.create === 'function' && (!client.messages.stream || client.messages.create.length > 0))
      ? (req) => client.messages.create({ ...req, stream: true })
      : null;
    let stream;
    if (client.messages && typeof client.messages.stream === 'function' && (!client.messages.create || client.messages._preferStreamMethod)) {
      stream = await client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: sysValue,
        messages
      });
    } else if (client.messages && typeof client.messages.create === 'function') {
      const maybeStream = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: sysValue,
        messages,
        stream: true
      });
      if (maybeStream && typeof maybeStream[Symbol.asyncIterator] === 'function') {
        stream = maybeStream;
      } else if (client.messages && typeof client.messages.stream === 'function') {
        stream = await client.messages.stream({
          model,
          max_tokens: maxTokens,
          system: sysValue,
          messages
        });
      } else {
        stream = maybeStream;
      }
    } else if (client.messages && typeof client.messages.stream === 'function') {
      stream = await client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: sysValue,
        messages
      });
    }
    let full = '';
    let yieldedAny = false;
    try {
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
            yieldedAny = true;
            if (typeof onThought === 'function') onThought(ev.delta.thinking);
          } else if (ev.delta.type === 'text_delta' && ev.delta.text) {
            yieldedAny = true;
            full += ev.delta.text;
            if (typeof onToken === 'function') onToken(ev.delta.text);
          }
        }
      }
      return full;
    } catch (err) {
      err._yieldedAny = yieldedAny;
      throw err;
    }
  };

  try {
    return await consumeStream(systemParam);
  } catch (err) {
    if (useCacheBlocks && !err._yieldedAny) {
      return await consumeStream(system);
    }
    throw err;
  }
}

async function askAnthropic({ apiKey, client: injectedClient, model, system, turns, imageDataUrl, maxTokens = 4096 }) {
  const client = injectedClient || new (require('@anthropic-ai/sdk'))({ apiKey });
  const messages = buildAnthropicMessages(turns, imageDataUrl);
  const useCacheBlocks = typeof system === 'string' && system.length >= getClaudeCacheMinChars(model);
  const systemParam = useCacheBlocks ? buildClaudeSystemBlocks(system, model) : system;

  let res;
  try {
    res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemParam,
      messages
    });
  } catch (err) {
    if (!useCacheBlocks) throw err;
    res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages
    });
  }
  const blocks = Array.isArray(res && res.content) ? res.content : [];
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

// ============================================================================
// Step 9.1: Gemini Prompt Cache (GeminiPromptCache)
// ============================================================================

const GEMINI_CACHE_MIN_PROMPT_CHARS = 4500;
const GEMINI_CACHE_TTL_SECONDS = 3600;
const GEMINI_CACHE_RENEWAL_WINDOW_MS = 5 * 60 * 1000;
const GEMINI_CACHE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

class GeminiPromptCache {
  constructor() {
    this.entries = new Map();
    this.inFlight = new Map();
    this.failures = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  _computeKey(model, systemPrompt) {
    return crypto
      .createHash('sha1')
      .update(`${String(model || '').trim()}\0${String(systemPrompt || '')}`)
      .digest('hex');
  }

  async getOrCreate(ai, model, systemPrompt) {
    if (
      typeof systemPrompt !== 'string' ||
      systemPrompt.length < GEMINI_CACHE_MIN_PROMPT_CHARS ||
      !ai ||
      !ai.caches ||
      typeof ai.caches.create !== 'function'
    ) {
      return null;
    }

    const cleanModel = String(model || '').trim();
    const key = this._computeKey(cleanModel, systemPrompt);
    const now = Date.now();

    const cooldownUntil = this.failures.get(key);
    if (cooldownUntil && now < cooldownUntil) {
      return null;
    }

    const existing = this.entries.get(key);
    if (existing && existing.expiresAt - now > GEMINI_CACHE_RENEWAL_WINDOW_MS) {
      this.hits += 1;
      return existing.name;
    }
    this.misses += 1;

    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    const promise = (async () => {
      try {
        const created = await ai.caches.create({
          model: cleanModel,
          config: {
            contents: [{ role: 'user', parts: [{ text: '_' }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            ttl: `${GEMINI_CACHE_TTL_SECONDS}s`,
            displayName: `cue-sys-${key.slice(0, 8)}`
          }
        });
        const name = created && typeof created.name === 'string' ? created.name.trim() : '';
        if (!name) {
          this.failures.set(key, Date.now() + GEMINI_CACHE_FAILURE_COOLDOWN_MS);
          return null;
        }
        this.failures.delete(key);
        this.entries.set(key, {
          key,
          name,
          model: cleanModel,
          expiresAt: Date.now() + GEMINI_CACHE_TTL_SECONDS * 1000
        });
        return name;
      } catch (_) {
        this.failures.set(key, Date.now() + GEMINI_CACHE_FAILURE_COOLDOWN_MS);
        return null;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  getCachedOrWarmInBackground(ai, model, systemPrompt) {
    if (
      typeof systemPrompt !== 'string' ||
      systemPrompt.length < GEMINI_CACHE_MIN_PROMPT_CHARS ||
      !ai ||
      !ai.caches ||
      typeof ai.caches.create !== 'function'
    ) {
      return null;
    }

    const cleanModel = String(model || '').trim();
    const key = this._computeKey(cleanModel, systemPrompt);
    const now = Date.now();
    const existing = this.entries.get(key);

    if (existing && existing.expiresAt > now) {
      if (existing.expiresAt - now <= GEMINI_CACHE_RENEWAL_WINDOW_MS) {
        this.getOrCreate(ai, cleanModel, systemPrompt).catch(() => {});
      }
      return existing.name;
    }

    this.getOrCreate(ai, cleanModel, systemPrompt).catch(() => {});
    return null;
  }

  invalidate(cacheNameOrKey) {
    if (!cacheNameOrKey) return;
    if (this.entries.has(cacheNameOrKey)) {
      this.entries.delete(cacheNameOrKey);
      return;
    }
    for (const [k, entry] of this.entries.entries()) {
      if (entry.name === cacheNameOrKey) {
        this.entries.delete(k);
      }
    }
  }

  getStats() {
    return {
      size: this.entries.size,
      inFlight: this.inFlight.size,
      hits: this.hits,
      misses: this.misses
    };
  }

  clear() {
    this.entries.clear();
    this.inFlight.clear();
    this.failures.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

const geminiPromptCache = new GeminiPromptCache();

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
function geminiGenerationConfig({ system, maxTokens, thinking, thinkingLevel, webSearch = false, includeThoughts = false, model = '', cachedContent = null }) {
  const config = {
    maxOutputTokens: maxTokens + (thinking ? GEMINI_THINKING_HEADROOM.smart : GEMINI_THINKING_HEADROOM.fast)
  };
  if (cachedContent) {
    config.cachedContent = cachedContent;
  } else {
    config.systemInstruction = system;
  }
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

function buildGeminiContents(turns = [], imageDataUrl = null) {
  const list = Array.isArray(turns) ? turns : [];
  return list.map((t, i) => {
    const last = i === list.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
}

async function resolveGeminiCacheName({ ai, model, system, webSearch, awaitPromptCache, cacheInstance = geminiPromptCache }) {
  if (webSearch || typeof system !== 'string' || system.length < GEMINI_CACHE_MIN_PROMPT_CHARS) {
    return null;
  }
  if (awaitPromptCache) {
    return cacheInstance.getOrCreate(ai, model, system);
  }
  return cacheInstance.getCachedOrWarmInBackground(ai, model, system);
}

async function streamGemini({
  apiKey,
  ai: injectedAi,
  promptCache = geminiPromptCache,
  awaitPromptCache = false,
  model,
  system,
  turns,
  imageDataUrl,
  maxTokens,
  thinking,
  thinkingLevel,
  webSearch,
  signal,
  onToken,
  onThought
}) {
  const ai = injectedAi || new (require('@google/genai').GoogleGenAI)({ apiKey });
  const contents = buildGeminiContents(turns, imageDataUrl);
  const cacheName = await resolveGeminiCacheName({
    ai,
    model,
    system,
    webSearch,
    awaitPromptCache,
    cacheInstance: promptCache
  });

  const openStreamWithConfig = async (cfg) => {
    try {
      return await ai.models.generateContentStream({ model, contents, config: cfg });
    } catch (e) {
      if (!cfg.thinkingConfig || !/thinking/i.test((e && e.message) || '')) throw e;
      try {
        cfg.thinkingConfig = { includeThoughts: true, thinkingBudget: -1 };
        return await ai.models.generateContentStream({ model, contents, config: cfg });
      } catch (e2) {
        if (!/thinking/i.test((e2 && e2.message) || '')) throw e2;
        delete cfg.thinkingConfig;
        return await ai.models.generateContentStream({ model, contents, config: cfg });
      }
    }
  };

  const runStreamAttempt = async (activeCacheName) => {
    const config = geminiGenerationConfig({
      system,
      maxTokens,
      thinking,
      thinkingLevel,
      webSearch,
      includeThoughts: true,
      model,
      cachedContent: activeCacheName
    });
    const stream = await openStreamWithConfig(config);
    let full = '';
    let yieldedAny = false;
    try {
      for await (const chunk of stream) {
        if (signal && signal.aborted) {
          throw new Error('Aborted');
        }
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (parts && Array.isArray(parts)) {
          for (const part of parts) {
            if (!part || typeof part.text !== 'string') continue;
            if (part.thought === true) {
              yieldedAny = true;
              if (typeof onThought === 'function') onThought(part.text);
            } else {
              yieldedAny = true;
              full += part.text;
              if (typeof onToken === 'function') onToken(part.text);
            }
          }
        } else {
          const t = chunk && chunk.text;
          if (t) {
            yieldedAny = true;
            full += t;
            if (typeof onToken === 'function') onToken(t);
          }
        }
      }
      return full;
    } catch (err) {
      err._yieldedAny = yieldedAny;
      throw err;
    }
  };

  if (cacheName) {
    try {
      return await runStreamAttempt(cacheName);
    } catch (err) {
      if (err && err.message === 'Aborted') throw err;
      if (!err._yieldedAny) {
        promptCache.invalidate(cacheName);
        return await runStreamAttempt(null);
      }
      throw err;
    }
  }

  return runStreamAttempt(null);
}

async function askGemini({
  apiKey,
  ai: injectedAi,
  promptCache = geminiPromptCache,
  awaitPromptCache = false,
  model,
  system,
  turns,
  imageDataUrl,
  maxTokens = 4096,
  thinking = false,
  thinkingLevel,
  webSearch = false
}) {
  const ai = injectedAi || new (require('@google/genai').GoogleGenAI)({ apiKey });
  const contents = buildGeminiContents(turns, imageDataUrl);
  const cacheName = await resolveGeminiCacheName({
    ai,
    model,
    system,
    webSearch,
    awaitPromptCache,
    cacheInstance: promptCache
  });

  const callGenerate = async (activeCacheName) => {
    const config = geminiGenerationConfig({
      system,
      maxTokens,
      thinking,
      thinkingLevel,
      webSearch,
      includeThoughts: false,
      model,
      cachedContent: activeCacheName
    });
    if (ai.models && typeof ai.models.generateContent === 'function') {
      const res = await ai.models.generateContent({ model, contents, config });
      const parts = res?.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        return parts
          .filter((p) => p && !p.thought && typeof p.text === 'string')
          .map((p) => p.text)
          .join('');
      }
      return (res && res.text) || '';
    }
    let out = '';
    await streamGemini({
      apiKey,
      ai,
      promptCache,
      awaitPromptCache,
      model,
      system,
      turns,
      imageDataUrl,
      maxTokens,
      thinking,
      thinkingLevel,
      webSearch,
      onToken: (t) => { out += t; }
    });
    return out;
  };

  if (cacheName) {
    try {
      return await callGenerate(cacheName);
    } catch (_) {
      promptCache.invalidate(cacheName);
      return await callGenerate(null);
    }
  }
  return callGenerate(null);
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
  } else if (provider === 'antigravity') {
    const status = getAntigravityStatus(settings.oauthStorageOptions);
    if (!status.authenticated) {
      configurationError = 'Sign in with Google in Settings to use Antigravity.';
    }
  } else if (provider === 'codex') {
    const status = getCodexStatus(settings.oauthStorageOptions);
    if (!status.authenticated) {
      configurationError = 'Sign in with ChatGPT in Settings to use Codex.';
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
        if (provider === 'antigravity') {
          const res = await streamAntigravity(
            {
              thinkingLevel: settings.antigravityThinkingLevel || (settings.smart ? 'HIGH' : 'LOW'),
              googleSearch: !!settings.antigravityWebSearch,
              oauthStorageOptions: settings.oauthStorageOptions
            },
            {
              model,
              system: args.system,
              turns: args.turns,
              imageDataUrl: args.imageDataUrl,
              maxTokens: args.maxTokens,
              signal: args.signal,
              onToken: args.onToken,
              onThought: args.onThought
            },
            fetchImpl
          );
          return res.fullText;
        }
        if (provider === 'codex') {
          const res = await streamCodexResponses(
            {
              reasoningEffort: settings.smart ? 'high' : 'low',
              oauthStorageOptions: settings.oauthStorageOptions
            },
            {
              model,
              system: args.system,
              turns: args.turns,
              imageDataUrl: args.imageDataUrl,
              maxTokens: args.maxTokens,
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
        if (provider === 'anthropic') return await streamAnthropic({ ...args, client: args.client || settings.anthropicClient });
        if (provider === 'gemini') return await streamGemini({
          ...args,
          ai: args.ai || settings.geminiClient,
          thinkingLevel: settings.geminiThinkingLevel || 'MEDIUM',
          webSearch: args.webSearch !== undefined ? !!args.webSearch : !!settings.geminiWebSearch,
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
    },
    async ask(params = {}) {
      if (!ready) throw new Error(configurationError || `Complete the ${provider} provider settings.`);
      const args = { apiKey, baseURL, endpoint, model, maxTokens, thinking: !!settings.smart, ...params, turns: sanitizeTurns(params.turns) };
      try {
        if (provider === 'gemini') {
          return await askGemini({
            ...args,
            ai: args.ai || settings.geminiClient,
            thinkingLevel: settings.geminiThinkingLevel || 'MEDIUM',
            webSearch: args.webSearch !== undefined ? !!args.webSearch : !!settings.geminiWebSearch
          });
        }
        if (provider === 'anthropic') {
          return await askAnthropic({ ...args, client: args.client || settings.anthropicClient });
        }
        let collected = '';
        const streamed = await this.stream({
          ...params,
          onToken: (t) => {
            collected += t;
            if (typeof params.onToken === 'function') params.onToken(t);
          }
        });
        return streamed || collected;
      } catch (error) {
        const wrapped = formatProviderErrorMessage(error, provider, model);
        throw wrapped instanceof Error ? wrapped : new Error(wrapped);
      }
    }
  };
}

// ============================================================================
// Step 10: Retired-Model Migration + Live Catalogue + 24-Hour Cache
// ============================================================================

const RETIRED_GEMINI_PREFIXES = ['1.0', '1.5', '2.0', '2.5'].map((v) => `gemini-${v}`);
const RETIRED_CLAUDE3_PREFIX = ['claude', '3'].join('-');

const RETIRED_MODEL_MIGRATIONS = {
  gemini: Object.fromEntries([
    ...RETIRED_GEMINI_PREFIXES.flatMap((prefix) => [
      [`${prefix}-flash`, 'gemini-3-flash-preview'],
      [`${prefix}-flash-8b`, 'gemini-3-flash-preview'],
      [`${prefix}-flash-lite`, 'gemini-3-flash-preview'],
      [`${prefix}-flash-preview`, 'gemini-3-flash-preview'],
      [`${prefix}-pro`, prefix.endsWith('2.5') ? 'gemini-3.1-pro-preview' : 'gemini-3-flash-preview'],
      [`${prefix}-pro-preview`, 'gemini-3.1-pro-preview']
    ])
  ]),
  openai: {
    'gpt-3.5-turbo': 'gpt-5.4-mini',
    'gpt-3.5-turbo-0125': 'gpt-5.4-mini',
    'gpt-4-turbo': 'gpt-5.4-mini',
    'gpt-4-turbo-preview': 'gpt-5.4-mini'
  },
  anthropic: Object.fromEntries([
    [`${RETIRED_CLAUDE3_PREFIX}-haiku-20240307`, 'claude-haiku-4-5'],
    [`${RETIRED_CLAUDE3_PREFIX}-5-haiku-latest`, 'claude-haiku-4-5'],
    [`${RETIRED_CLAUDE3_PREFIX}-5-haiku-20241022`, 'claude-haiku-4-5'],
    [`${RETIRED_CLAUDE3_PREFIX}-sonnet-20240229`, 'claude-sonnet-4-6'],
    [`${RETIRED_CLAUDE3_PREFIX}-opus-20240229`, 'claude-sonnet-4-6'],
    [`${RETIRED_CLAUDE3_PREFIX}-5-sonnet-latest`, 'claude-sonnet-4-6'],
    [`${RETIRED_CLAUDE3_PREFIX}-5-sonnet-20241022`, 'claude-sonnet-4-6'],
    [`${RETIRED_CLAUDE3_PREFIX}-7-sonnet-latest`, 'claude-sonnet-4-6'],
    [`${RETIRED_CLAUDE3_PREFIX}-7-sonnet-20250219`, 'claude-sonnet-4-6']
  ]),
  deepseek: {
    'deepseek-chat': 'deepseek-v4',
    'deepseek-v4-flash': 'deepseek-v4',
    'deepseek-reasoner': 'deepseek-r2'
  },
  groq: {
    'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
    'meta-llama/llama-4-scout-17b-16e-instruct': 'openai/gpt-oss-120b',
    'qwen/qwen3.6-27b': 'openai/gpt-oss-120b'
  }
};

function resolveStaticRetiredSuccessor(providerId, modelId, tier = 'fast') {
  const p = String(providerId || '').trim().toLowerCase();
  const id = String(modelId || '').trim();
  if (!id) return null;

  const providerMap = RETIRED_MODEL_MIGRATIONS[p];
  if (providerMap && typeof providerMap === 'object' && typeof providerMap[id] === 'string') {
    return providerMap[id];
  }

  if (p === 'gemini') {
    if (/^gemini-2\.5-pro/i.test(id)) return 'gemini-3.1-pro-preview';
    if (/^gemini-(?:1\.[05]|2\.[05])-/i.test(id)) return 'gemini-3-flash-preview';
  }
  if (p === 'antigravity') {
    return null;
  }
  if (p === 'openai' || p === 'azure' || !p) {
    if (/^gpt-3\.5/i.test(id) || /^gpt-4-turbo/i.test(id)) return 'gpt-5.4-mini';
  }
  if (p === 'anthropic' || !p) {
    if (/^claude-(?:2|3(?:-[57])?-)/i.test(id)) {
      return /haiku/i.test(id) ? 'claude-haiku-4-5' : 'claude-sonnet-4-6';
    }
  }
  if (p === 'deepseek' || !p) {
    if (/^deepseek-reasoner$/i.test(id)) return 'deepseek-r2';
    if (/^deepseek-(?:chat|v4-flash)$/i.test(id)) return 'deepseek-v4';
  }
  if (p === 'groq' || !p) {
    if (
      id === 'llama-3.3-70b-versatile' ||
      id === 'meta-llama/llama-4-scout-17b-16e-instruct' ||
      id === 'qwen/qwen3.6-27b'
    ) {
      return 'openai/gpt-oss-120b';
    }
  }

  if (typeof RETIRED_MODEL_MIGRATIONS[id] === 'string') {
    return RETIRED_MODEL_MIGRATIONS[id];
  }
  return null;
}

function inferModelTier(id, explicitTier) {
  if (explicitTier === 'smart' || explicitTier === 'fast') return explicitTier;
  return /pro|argon|sonnet|opus|gpt-5\.4(?!-mini|-nano)|gpt-4o(?!-mini)|gpt-4\.1(?!-mini|-nano)|o1|o3|70b|120b|v4|r2|codex|agent/i.test(String(id || '')) && !/flash|lite|mini|nano|instant/i.test(String(id || ''))
    ? 'smart'
    : 'fast';
}

function migrateRetiredModel(providerIdOrModelId, modelIdOrLiveModels, liveModels = null, tier = 'fast') {
  let providerId = providerIdOrModelId;
  let modelId = modelIdOrLiveModels;
  let effectiveLive = liveModels;
  let effectiveTier = tier;

  // Support 1-arg or 2-arg call migrateRetiredModel(modelId, liveModels?, tier?)
  if (modelIdOrLiveModels === undefined || Array.isArray(modelIdOrLiveModels)) {
    providerId = '';
    modelId = providerIdOrModelId;
    effectiveLive = Array.isArray(modelIdOrLiveModels) ? modelIdOrLiveModels : null;
    if (typeof liveModels === 'string') effectiveTier = liveModels;
  } else if (typeof liveModels === 'string') {
    effectiveTier = liveModels;
    effectiveLive = Array.isArray(tier) ? tier : null;
  }

  const cleanModelId = String(modelId || '').trim();
  if (String(providerId || '').trim().toLowerCase() === 'antigravity') {
    return cleanModelId;
  }
  const normalizedLive = Array.isArray(effectiveLive)
    ? effectiveLive
        .map((m) => {
          if (typeof m === 'string') {
            const id = m.trim();
            return id ? { id, tier: inferModelTier(id) } : null;
          }
          if (m && typeof m === 'object' && m.id) {
            const id = String(m.id).trim();
            return id ? { ...m, id, tier: inferModelTier(id, m.tier) } : null;
          }
          return null;
        })
        .filter(Boolean)
    : null;

  if (normalizedLive && normalizedLive.length > 0) {
    if (cleanModelId && normalizedLive.some((m) => m.id === cleanModelId)) {
      return cleanModelId;
    }
    const successor = resolveStaticRetiredSuccessor(providerId, cleanModelId, effectiveTier);
    if (successor) {
      const exactMatch = normalizedLive.find((m) => m.id === successor);
      if (exactMatch) return exactMatch.id;
      const prefixMatch = normalizedLive.find((m) => m.id.startsWith(successor) || successor.startsWith(m.id));
      if (prefixMatch) return prefixMatch.id;
    }
    const tierMatch = normalizedLive.find((m) => m.tier === effectiveTier);
    if (tierMatch) return tierMatch.id;
    return normalizedLive[0].id;
  }

  if (!cleanModelId) return cleanModelId;
  const successor = resolveStaticRetiredSuccessor(providerId, cleanModelId, effectiveTier);
  return successor || cleanModelId;
}

function migrateSettingsModels(settings, providerId = null, liveModels = null) {
  if (!settings || typeof settings !== 'object') return settings;
  const targetProvider = providerId ? String(providerId).trim() : null;
  const activeProvider = targetProvider || String(settings.provider || 'openai').trim();
  if (targetProvider === 'antigravity' || activeProvider === 'antigravity') {
    return settings;
  }
  let changed = false;

  if (typeof settings.fastModel === 'string' && settings.fastModel.trim()) {
    const nextFast = migrateRetiredModel(
      activeProvider,
      settings.fastModel,
      !targetProvider || targetProvider === activeProvider ? liveModels : null,
      'fast'
    );
    if (nextFast && nextFast !== settings.fastModel) {
      settings.fastModel = nextFast;
      changed = true;
    }
  }

  if (typeof settings.smartModel === 'string' && settings.smartModel.trim()) {
    const nextSmart = migrateRetiredModel(
      activeProvider,
      settings.smartModel,
      !targetProvider || targetProvider === activeProvider ? liveModels : null,
      'smart'
    );
    if (nextSmart && nextSmart !== settings.smartModel) {
      settings.smartModel = nextSmart;
      changed = true;
    }
  }

  if (settings.providerModels && typeof settings.providerModels === 'object') {
    const providers = targetProvider ? [targetProvider] : Object.keys(settings.providerModels);
    for (const p of providers) {
      const val = settings.providerModels[p];
      const pLive = !targetProvider || targetProvider === p ? liveModels : null;
      if (typeof val === 'string' && val.trim()) {
        const migrated = migrateRetiredModel(p, val, pLive, 'fast');
        if (migrated && migrated !== val) {
          settings.providerModels[p] = migrated;
          changed = true;
        }
      } else if (val && typeof val === 'object') {
        if (typeof val.fast === 'string' && val.fast.trim()) {
          const nextFast = migrateRetiredModel(p, val.fast, pLive, 'fast');
          if (nextFast && nextFast !== val.fast) {
            val.fast = nextFast;
            changed = true;
          }
        }
        if (typeof val.smart === 'string' && val.smart.trim()) {
          const nextSmart = migrateRetiredModel(p, val.smart, pLive, 'smart');
          if (nextSmart && nextSmart !== val.smart) {
            val.smart = nextSmart;
            changed = true;
          }
        }
      }
    }
  }

  if (settings.models && typeof settings.models === 'object') {
    const providers = targetProvider ? [targetProvider] : Object.keys(settings.models);
    for (const p of providers) {
      const entry = settings.models[p];
      if (!entry || typeof entry !== 'object') continue;
      const pLive = !targetProvider || targetProvider === p ? liveModels : null;
      // When liveModels is explicitly passed, migrate any model absent from liveModels;
      // during static load (liveModels === null), only migrate models that match explicit retired rules
      if (typeof entry.fast === 'string' && entry.fast.trim()) {
        const nextFast = pLive
          ? migrateRetiredModel(p, entry.fast, pLive, 'fast')
          : (resolveStaticRetiredSuccessor(p, entry.fast, 'fast') || entry.fast);
        if (nextFast && nextFast !== entry.fast) {
          entry.fast = nextFast;
          changed = true;
        }
      }
      if (typeof entry.smart === 'string' && entry.smart.trim()) {
        const nextSmart = pLive
          ? migrateRetiredModel(p, entry.smart, pLive, 'smart')
          : (resolveStaticRetiredSuccessor(p, entry.smart, 'smart') || entry.smart);
        if (nextSmart && nextSmart !== entry.smart) {
          entry.smart = nextSmart;
          changed = true;
        }
      }
    }
  }

  try {
    Object.defineProperty(settings, '_migrated', {
      value: changed,
      enumerable: false,
      configurable: true,
      writable: true
    });
    Object.defineProperty(settings, 'changed', {
      value: changed,
      enumerable: false,
      configurable: true,
      writable: true
    });
  } catch (_) {}

  return settings;
}

function mergeCatalogModels(curatedEntry, liveModels = [], provider = '') {
  const curatedAll = Array.isArray(curatedEntry)
    ? curatedEntry
    : (curatedEntry && Array.isArray(curatedEntry.all) ? curatedEntry.all : []);
  const curatedById = new Map();
  for (const item of curatedAll) {
    if (!item) continue;
    const id = typeof item === 'string' ? item.trim() : String(item.id || '').trim();
    if (!id) continue;
    curatedById.set(id, typeof item === 'object' ? { ...item, id } : { id, label: id, tier: inferModelTier(id) });
  }

  const normalizedLive = [];
  const seenLive = new Set();
  if (Array.isArray(liveModels)) {
    for (const item of liveModels) {
      if (!item) continue;
      const id = typeof item === 'string' ? item.trim() : String(item.id || '').trim();
      if (!id || seenLive.has(id)) continue;
      seenLive.add(id);
      const curatedMeta = curatedById.get(id);
      const tier = (typeof item === 'object' && item.tier) || (curatedMeta && curatedMeta.tier) || inferModelTier(id);
      const label = (typeof item === 'object' && (item.label || item.name)) || (curatedMeta && curatedMeta.label) || id;
      const entry = {
        ...(curatedMeta || {}),
        ...(typeof item === 'object' ? item : {}),
        id,
        label,
        tier
      };
      normalizedLive.push(entry);
    }
  }

  // For antigravity, return exactly the way it was before (curated models preserved, merging any extra live models)
  let all;
  if (provider === 'antigravity') {
    const byId = new Map(curatedById);
    for (const entry of normalizedLive) {
      if (!byId.has(entry.id)) {
        byId.set(entry.id, entry);
      }
    }
    all = Array.from(byId.values());
  } else {
    all = normalizedLive.length > 0 ? normalizedLive : Array.from(curatedById.values());
  }

  const fastModels = all.filter((m) => m.tier === 'fast');
  const smartModels = all.filter((m) => m.tier === 'smart');

  const result = all.slice();
  Object.defineProperty(result, 'models', { value: all, enumerable: true });
  Object.defineProperty(result, 'fastModels', { value: fastModels.length ? fastModels : all, enumerable: true });
  Object.defineProperty(result, 'smartModels', { value: smartModels.length ? smartModels : all, enumerable: true });
  return result;
}

const GEMINI_LIVE_MODEL_ALLOW_RE = /^gemini-[34](?:[.-]|$)/i;
const GEMINI_LIVE_MODEL_EXCLUDE_RE = /embedding|tts|image|vision|aqa|nano|banana|computer-use|custom|imagen|veo|live|transcribe/i;

function filterGeminiApiModels(rawModels = []) {
  const list = Array.isArray(rawModels) ? rawModels : [];
  const out = [];
  const seen = new Set();
  for (const m of list) {
    if (!m) continue;
    const rawName = typeof m === 'string' ? m : (m.id || m.name || '');
    const id = String(rawName).replace(/^models\//i, '').trim();
    if (!id || seen.has(id)) continue;
    if (!GEMINI_LIVE_MODEL_ALLOW_RE.test(id)) continue;
    if (GEMINI_LIVE_MODEL_EXCLUDE_RE.test(id)) continue;
    if (
      typeof m === 'object' &&
      Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.length > 0 &&
      !m.supportedGenerationMethods.includes('generateContent')
    ) {
      continue;
    }
    seen.add(id);
    const label = (typeof m === 'object' && (m.displayName || m.label)) || id;
    const tier = /pro|argon/i.test(id) && !/flash|lite/i.test(id) ? 'smart' : 'fast';
    out.push({ id, label, tier });
  }
  return out;
}

async function listGeminiModels(apiKeyOrOptions, fetchImpl = fetch) {
  const apiKey = typeof apiKeyOrOptions === 'string'
    ? apiKeyOrOptions.trim()
    : String((apiKeyOrOptions && (apiKeyOrOptions.apiKey || apiKeyOrOptions.key || apiKeyOrOptions.settings?.apiKeys?.gemini)) || '').trim();
  const effectiveFetch = (apiKeyOrOptions && typeof apiKeyOrOptions === 'object' && typeof apiKeyOrOptions.fetchImpl === 'function')
    ? apiKeyOrOptions.fetchImpl
    : fetchImpl;
  if (!apiKey) return [];
  const res = await effectiveFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
  if (!res.ok) {
    const err = new Error(`Gemini models HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return filterGeminiApiModels(data && data.models);
}

const MODEL_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const modelCatalogCache = new Map();

function clearModelCatalogCache() {
  modelCatalogCache.clear();
}

function buildModelCatalogCacheKey(provider, effectiveKey, settings = {}, override = {}) {
  const rawMaterial = [
    provider,
    effectiveKey || '',
    override.baseUrl !== undefined ? override.baseUrl : (settings.baseUrl || ''),
    override.vertexProject !== undefined ? override.vertexProject : (settings.vertexProject || ''),
    override.vertexLocation !== undefined ? override.vertexLocation : (settings.vertexLocation || 'global'),
    override.azureEndpoint !== undefined ? override.azureEndpoint : (settings.azureEndpoint || ''),
    override.ollamaHost || ''
  ].join('|');
  const hash = crypto.createHash('sha1').update(rawMaterial).digest('hex').slice(0, 16);
  return `${provider}:${hash}`;
}

async function listProviderModels(arg1 = {}, arg2 = {}, arg3 = undefined) {
  let settings = {};
  let override = {};
  let fetchImpl = fetch;

  if (typeof arg1 === 'string') {
    settings = (arg2 && typeof arg2 === 'object') ? arg2 : {};
    if (typeof arg3 === 'function') {
      fetchImpl = arg3;
      override = { provider: arg1 };
    } else {
      override = { ...(arg3 && typeof arg3 === 'object' ? arg3 : {}), provider: arg1 };
      if (typeof override.fetchImpl === 'function') fetchImpl = override.fetchImpl;
      else if (typeof override.fetch === 'function') fetchImpl = override.fetch;
    }
  } else {
    settings = (arg1 && typeof arg1 === 'object') ? arg1 : {};
    if (typeof arg2 === 'function') {
      fetchImpl = arg2;
    } else if (arg2 && typeof arg2 === 'object') {
      override = arg2;
      if (typeof override.fetchImpl === 'function') fetchImpl = override.fetchImpl;
      else if (typeof override.fetch === 'function') fetchImpl = override.fetch;
    }
    if (typeof arg3 === 'function') {
      fetchImpl = arg3;
    } else if (arg3 && typeof arg3 === 'object') {
      override = { ...override, ...arg3 };
      if (typeof override.fetchImpl === 'function') fetchImpl = override.fetchImpl;
      else if (typeof override.fetch === 'function') fetchImpl = override.fetch;
    }
  }

  const provider = String(override.provider || settings.provider || 'openai').trim();
  const keys = settings.apiKeys || {};
  const effectiveKey = override.clearKey
    ? ''
    : (override.apiKey !== undefined && String(override.apiKey).trim() !== ''
      ? String(override.apiKey).trim()
      : String(keys[provider] || '').trim());

  const now = typeof override.now === 'number' ? override.now : Date.now();
  const forceRefresh = Boolean(override.forceRefresh);
  const cacheKey = buildModelCatalogCacheKey(provider, effectiveKey, settings, override);

  if (!forceRefresh) {
    const cached = modelCatalogCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < MODEL_CATALOG_CACHE_TTL_MS) {
      if (cached.result.live && cached.result.models.length > 0) {
        migrateSettingsModels(settings, provider, cached.result.models);
      }
      return {
        ...cached.result,
        cached: true
      };
    }
  }

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
      live = liveModels.length > 0;
    } else if (provider === 'antigravity') {
      const ids = await listAntigravityModels(settings.oauthStorageOptions || {}, fetchImpl);
      liveModels = (ids || []).map((id) => {
        const cleanId = typeof id === 'string' ? id.trim() : String((id && id.id) || '').trim();
        return {
          id: cleanId,
          label: (id && typeof id === 'object' && id.label) || cleanId,
          tier: /pro/i.test(cleanId) ? 'smart' : 'fast'
        };
      });
      live = true;
    } else if (provider === 'codex') {
      liveModels = CODEX_MODEL_OPTIONS.map((m) => ({
        id: m.id,
        label: m.label,
        tier: /codex/i.test(m.id) ? 'smart' : 'fast'
      }));
      live = liveModels.length > 0;
    } else if (provider === 'gemini' && effectiveKey) {
      liveModels = await listGeminiModels(effectiveKey, fetchImpl);
      live = liveModels.length > 0;
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
        liveModels = (data.data || data.models || [])
          .map((m) => (typeof m === 'string' ? m.trim() : String((m && m.id) || '').trim()))
          .filter((id) => id && !/whisper|tts|embedding|moderation|dall-e|audio|realtime/i.test(id))
          .map((id) => ({ id, label: id, tier: inferModelTier(id) }));
        live = liveModels.length > 0;
      } else {
        warning = `${normalizeProviderName(provider)} models HTTP ${res.status}`;
      }
    } else if (provider === 'anthropic' && effectiveKey) {
      const res = await fetchImpl('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': effectiveKey,
          'anthropic-version': '2023-06-01'
        }
      });
      if (res.ok) {
        const data = await res.json();
        liveModels = (data.data || data.models || [])
          .map((m) => {
            const id = typeof m === 'string' ? m.trim() : String((m && m.id) || '').trim();
            const label = (m && typeof m === 'object' && (m.display_name || m.label)) || id;
            return id ? { id, label, tier: /haiku/i.test(id) ? 'fast' : 'smart' } : null;
          })
          .filter(Boolean);
        live = liveModels.length > 0;
      } else {
        warning = `Anthropic models HTTP ${res.status}`;
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
        live = liveModels.length > 0;
      } else {
        warning = `Ollama tags HTTP ${res.status}`;
      }
    }
  } catch (err) {
    warning = (err && err.message) || String(err);
  }

  const merged = mergeCatalogModels(curated, liveModels, provider);
  const result = {
    ok: true,
    provider,
    models: merged.models,
    fastModels: merged.fastModels,
    smartModels: merged.smartModels,
    live,
    cached: false,
    ...(warning ? { warning } : {})
  };

  if (live && merged.models.length > 0) {
    modelCatalogCache.set(cacheKey, { timestamp: now, result });
    if (provider !== 'antigravity') {
      migrateSettingsModels(settings, provider, merged.models);
    }
  }

  return result;
}

async function refreshProviderModelCatalog(providerIdOrSettings, maybeSettings = {}, maybeOptions = {}) {
  if (typeof providerIdOrSettings === 'string') {
    const opts = typeof maybeOptions === 'function'
      ? { fetchImpl: maybeOptions, forceRefresh: true }
      : { ...(maybeOptions || {}), forceRefresh: maybeOptions?.forceRefresh !== undefined ? maybeOptions.forceRefresh : true };
    return listProviderModels(providerIdOrSettings, maybeSettings, opts);
  }
  const settings = providerIdOrSettings || {};
  const opts = {
    ...(maybeSettings || {}),
    forceRefresh: maybeSettings?.forceRefresh !== undefined ? maybeSettings.forceRefresh : true
  };
  return listProviderModels(settings, opts, typeof maybeOptions === 'function' ? maybeOptions : opts.fetchImpl);
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
    antigravityThinkingLevel: override.antigravityThinkingLevel !== undefined ? override.antigravityThinkingLevel : (settings.antigravityThinkingLevel || 'LOW'),
    antigravityWebSearch: override.antigravityWebSearch !== undefined ? !!override.antigravityWebSearch : !!settings.antigravityWebSearch,
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
  GEMINI_TRANSCRIBE_FALLBACK_MODEL,
  CURRENT_ANTHROPIC_DEFAULT_FAST,
  CURRENT_ANTHROPIC_DEFAULT_SMART,
  PUBLIK_PROVIDER,
  PROVIDER_LABELS,
  PROVIDER_MODEL_CATALOG,
  mergeCatalogModels,
  listGeminiModels,
  filterGeminiApiModels,
  listProviderModels,
  refreshProviderModelCatalog,
  clearModelCatalogCache,
  MODEL_CATALOG_CACHE_TTL_MS,
  RETIRED_MODEL_MIGRATIONS,
  migrateRetiredModel,
  migrateSettingsModels,
  GeminiPromptCache,
  geminiPromptCache,
  GEMINI_CACHE_MIN_PROMPT_CHARS,
  GEMINI_CACHE_TTL_SECONDS,
  GEMINI_CACHE_RENEWAL_WINDOW_MS,
  GEMINI_CACHE_FAILURE_COOLDOWN_MS,
  getClaudeCacheMinChars,
  buildClaudeSystemBlocks,
  streamGemini,
  askGemini,
  streamAnthropic,
  askAnthropic,
  testProviderConnection,
  isRateLimitError,
  GEMINI_STT_MODELS,
  listGeminiSTTModels
};
