const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const VERTEX_MODEL_OPTIONS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (Fast default)', tier: 'fast' },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon (Smart default)', tier: 'smart' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', tier: 'fast' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', tier: 'fast' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', tier: 'fast' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', tier: 'fast' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', tier: 'smart' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', tier: 'fast' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', tier: 'fast' }
];

const VERTEX_REGIONS = [
  'global',
  'us-central1',
  'europe-west2',
  'us-east5',
  'europe-west1',
  'asia-northeast1'
];

// Vertex streaming reliability tuning. The 20s first-chunk deadline matches cue's
// own inactivity watchdog (STREAM_INACTIVITY_MS in main.js): a call that has not
// produced a chunk in 20s never starts, so it is retried instead of hung on.
// The 15s keep-alive exists so the watchdog never fires while a retry round or
// the non-streaming fallback is still working: empty thoughts rearm it without
// showing anything (main.js only forwards non-empty thoughts to the UI).
const FIRST_CHUNK_TIMEOUT_MS = 20000;
const KEEPALIVE_MS = 15000;
const TOKEN_TIMEOUT_MS = 15000;
const LIST_TIMEOUT_MS = 20000;
const FALLBACK_TIMEOUT_MS = 45000;
const MAX_FETCH_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const tokenCache = new Map();

function clearVertexTokenCache() {
  tokenCache.clear();
}

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function validateServiceAccountJson(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Service Account JSON is empty.');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid Service Account JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Service Account JSON must be a JSON object.');
  }
  if (parsed.type !== 'service_account') {
    throw new Error('JSON key must have "type": "service_account".');
  }
  if (typeof parsed.client_email !== 'string' || !parsed.client_email.trim()) {
    throw new Error('Service Account JSON is missing "client_email".');
  }
  if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('BEGIN PRIVATE KEY')) {
    throw new Error('Service Account JSON is missing a valid PEM "private_key".');
  }
  return {
    ok: true,
    projectId: typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '',
    clientEmail: parsed.client_email.trim(),
    credentials: parsed
  };
}

function createSignedJwt(creds, nowSeconds = Math.floor(Date.now() / 1000)) {
  const tokenUri = creds.token_uri || DEFAULT_TOKEN_URI;
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: creds.client_email,
    scope: VERTEX_SCOPE,
    aud: tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(creds.private_key);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function resolveDefaultAdcPath() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'gcloud', 'application_default_credentials.json');
  }
  return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

function loadAdcCredentials(customPath) {
  const adcPath = customPath || resolveDefaultAdcPath();
  if (!adcPath || !fs.existsSync(adcPath)) {
    throw new Error(
      'No Vertex AI Service Account JSON provided and no Application Default Credentials found. ' +
      'Paste a Service Account JSON key in Settings or run "gcloud auth application-default login".'
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(adcPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read Application Default Credentials at ${adcPath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in Application Default Credentials at ${adcPath}: ${err.message}`);
  }
  return parsed;
}

// Fetch with an explicit timeout (manual controller: works on every Node fetch).
// The caller's signal is linked, so a user cancel still aborts immediately.
async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const outer = options.signal;
  const onOuterAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    return await fetchImpl(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onOuterAbort);
  }
}

async function exchangeTokenRequest(tokenUri, bodyParams, fetchImpl = fetch) {
  const body = new URLSearchParams(bodyParams).toString();
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    }, TOKEN_TIMEOUT_MS);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('Vertex AI OAuth token exchange timed out.');
    }
    throw err;
  }
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }
  if (!response.ok || !data || !data.access_token) {
    const detail = (data && (data.error_description || data.error)) || `${response.status} ${response.statusText || ''}`.trim();
    throw new Error(`Vertex AI OAuth token exchange failed: ${detail}`);
  }
  return {
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in) || 3600
  };
}

async function getVertexAccessToken(config = {}, fetchImpl = fetch) {
  const rawSa = typeof config.serviceAccountJson === 'string' ? config.serviceAccountJson.trim() : '';
  let creds;
  let authMode;

  if (rawSa) {
    const validated = validateServiceAccountJson(rawSa);
    creds = validated.credentials;
    authMode = 'service_account';
  } else {
    creds = loadAdcCredentials(config.adcPath);
    authMode = 'adc';
  }

  const projectId = String(
    config.projectId ||
    creds.project_id ||
    creds.quota_project_id ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    ''
  ).trim();

  const fingerprint = crypto
    .createHash('sha256')
    .update(`${authMode}:${creds.client_email || creds.client_id || ''}:${projectId}`)
    .digest('hex');

  const cached = tokenCache.get(fingerprint);
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return {
      token: cached.token,
      projectId: projectId || cached.projectId,
      authMode,
      clientEmail: creds.client_email || ''
    };
  }

  let exchanged;
  if (creds.type === 'service_account') {
    const assertion = createSignedJwt(creds);
    exchanged = await exchangeTokenRequest(
      creds.token_uri || DEFAULT_TOKEN_URI,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      },
      fetchImpl
    );
  } else if (creds.type === 'authorized_user') {
    if (!creds.client_id || !creds.client_secret || !creds.refresh_token) {
      throw new Error('ADC authorized_user file is missing client_id, client_secret, or refresh_token.');
    }
    exchanged = await exchangeTokenRequest(
      creds.token_uri || DEFAULT_TOKEN_URI,
      {
        grant_type: 'refresh_token',
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token
      },
      fetchImpl
    );
  } else {
    throw new Error(`Unsupported Google credential type "${creds.type || 'unknown'}". Expected "service_account" or "authorized_user".`);
  }

  tokenCache.set(fingerprint, {
    token: exchanged.accessToken,
    projectId,
    expiresAt: Date.now() + exchanged.expiresIn * 1000
  });

  return {
    token: exchanged.accessToken,
    projectId,
    authMode,
    clientEmail: creds.client_email || ''
  };
}

function cleanVertexModelId(model) {
  return String(model || '')
    .replace(/^publishers\/google\/models\//i, '')
    .replace(/^models\//i, '')
    .trim();
}

function buildVertexEndpointUrl({ projectId, location = 'global', model, action = 'streamGenerateContent', sse = true }) {
  if (!projectId || !String(projectId).trim()) {
    throw new Error('Vertex AI requires a GCP Project ID. Add your Project ID or paste a Service Account JSON key in Settings.');
  }
  const loc = String(location || 'global').trim() || 'global';
  const cleanModel = cleanVertexModelId(model) || 'gemini-3.8-flash';
  const host = loc === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${loc}-aiplatform.googleapis.com`;
  const query = sse ? '?alt=sse' : '';
  return `${host}/v1beta1/projects/${encodeURIComponent(String(projectId).trim())}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(cleanModel)}:${action}${query}`;
}

function isSupportedVertexGeminiModel(modelId) {
  const id = cleanVertexModelId(modelId).toLowerCase();
  if (!/^gemini-(3|4)/.test(id)) return false;
  if (/embedding|imagen|veo|tts|live|audio|transcribe/.test(id)) return false;
  return true;
}

async function listVertexModels(config = {}, fetchImpl = fetch) {
  const auth = await getVertexAccessToken(config, fetchImpl);
  const headers = {
    Authorization: `Bearer ${auth.token}`
  };
  if (auth.projectId) {
    headers['x-goog-user-project'] = auth.projectId;
  }

  const loc = String(config.location || 'global').trim() || 'global';
  const host = loc === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${loc}-aiplatform.googleapis.com`;
  const url = `${host}/v1beta1/publishers/google/models?pageSize=100`;

  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, { method: 'GET', headers }, LIST_TIMEOUT_MS);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('Vertex AI model list timed out.');
    }
    throw err;
  }
  if (!response.ok) {
    let errText = '';
    try { errText = await response.text(); } catch (_) {}
    throw new Error(`Vertex AI model list failed (${response.status}): ${errText.slice(0, 240)}`);
  }

  const data = await response.json();
  const rawModels = data.publisherModels || data.models || [];
  const byId = new Map();

  for (const option of VERTEX_MODEL_OPTIONS) {
    byId.set(option.id, { ...option });
  }

  for (const item of rawModels) {
    const rawName = typeof item === 'string' ? item : (item.name || item.model || item.id || '');
    const id = cleanVertexModelId(rawName);
    if (!id || !isSupportedVertexGeminiModel(id)) continue;
    if (!byId.has(id)) {
      const isSmart = /pro|argon|ultra/i.test(id);
      byId.set(id, {
        id,
        label: item.displayName ? `${item.displayName} (${id})` : id,
        tier: isSmart ? 'smart' : 'fast'
      });
    }
  }

  return {
    models: Array.from(byId.values()),
    projectId: auth.projectId,
    authMode: auth.clientEmail ? 'service_account' : auth.authMode
  };
}

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

function buildVertexPayload(params = {}, modelId = '') {
  const {
    system,
    turns,
    messages,
    userPrompt,
    imageDataUrl,
    imageBase64,
    maxTokens = 8192,
    temperature = 0.3,
    thinkingLevel,
    webSearch = false
  } = params;

  const normalizedTurns = Array.isArray(turns) && turns.length
    ? turns
    : Array.isArray(messages) && messages.length
      ? messages
      : userPrompt
        ? [{ role: 'user', text: String(userPrompt) }]
        : [];

  const contents = normalizedTurns.map((t, idx) => {
    const isLast = idx === normalizedTurns.length - 1;
    const text = t.text !== undefined ? String(t.text) : String(t.content || '');
    const parts = [{ text }];
    if (isLast && (t.role === 'user' || !t.role)) {
      if (imageDataUrl) {
        const parsed = stripDataUrl(imageDataUrl);
        if (parsed) {
          parts.push({ inlineData: { mimeType: parsed.mime, data: parsed.b64 } });
        }
      } else if (imageBase64) {
        parts.push({ inlineData: { mimeType: 'image/png', data: imageBase64 } });
      }
    }
    return {
      role: t.role === 'assistant' || t.role === 'model' ? 'model' : 'user',
      parts
    };
  });

  const cleanModel = cleanVertexModelId(modelId);
  const lvl = String(thinkingLevel || 'MEDIUM').toUpperCase();
  const includeThinking = /^gemini-[34]/i.test(cleanModel) && (lvl === 'LOW' || lvl === 'MEDIUM' || lvl === 'HIGH');
  const headroom = includeThinking ? (lvl === 'HIGH' ? 4096 : 1024) : 1024;

  const generationConfig = {
    maxOutputTokens: Math.max(16, Number(maxTokens) || 8192) + headroom,
    temperature: typeof temperature === 'number' ? temperature : 0.3
  };

  if (includeThinking) {
    generationConfig.thinkingConfig = {
      thinkingLevel: lvl,
      includeThoughts: true
    };
  } else if (params.includeThoughts) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: -1
    };
  }

  const payload = {
    contents,
    generationConfig
  };

  if (system && String(system).trim()) {
    payload.systemInstruction = {
      parts: [{ text: String(system).trim() }]
    };
  }

  if (webSearch) {
    payload.tools = [{ googleSearch: {} }];
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Streaming reliability: hedged regions, first-chunk deadline, retry, fallback.
// ---------------------------------------------------------------------------
//
// The old code walked regions one at a time (preferred -> global -> us-central1
// -> europe-west2), retried only 404s, threw immediately on 409/429/5xx, and
// consumed the SSE stream with a plain for-await loop that ignored the abort
// signal while no chunk arrived. A stalled region therefore hung the whole call
// until cue's 20s watchdog killed it, and a 409 (serving-side conflict, seen in
// the console 2026-10-24 21:27-21:30 AZT) killed the request with no retry.
//
// The new flow, per call:
//   1. Hedge: all candidate regions fire in parallel. The first region to yield
//      any chunk (thought or token) wins; losers are aborted at once.
//   2. Deadline: if no region yields a chunk within 20s, the hedge is aborted
//      and run once more (one retry round).
//   3. Fallback: if streaming still produced nothing, a single-shot
//      :generateContent request runs hedged across regions with a 45s deadline.
//      Its text is forwarded as one token. If it also fails, the original
//      streaming error is rethrown, so the user sees the real failure.
//   4. Keep-alive: until the first real chunk, an empty thought is emitted
//      every 15s. That rearms cue's 20s watchdog without displaying anything.
// Once any chunk has been shown, the stream runs to completion (or errors)
// without fallback: falling back then would duplicate output.
// ---------------------------------------------------------------------------

function isRetryableStatus(status) {
  return status === 429 || status === 409 || status === 500 || status === 502 || status === 503 || status === 504;
}

// Abort-aware sleep: resolves early when the signal fires, so a hedged loser
// stuck in backoff settles immediately instead of delaying the winner.
function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Fetch that retries fast, retryable failures (429/409/5xx) with exponential
// backoff + jitter. Aborts and network errors propagate immediately: the hedge
// across regions already covers a single region's transient failure, and an
// abort must never be mistaken for a retryable error.
async function fetchWithRetry(fetchImpl, url, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      await sleep(backoff, options.signal);
    }
    if (options.signal && options.signal.aborted) {
      const abortErr = new Error('The operation was aborted.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    let response;
    try {
      response = await fetchImpl(url, options);
    } catch (err) {
      throw err;
    }
    if (response.ok) return response;
    if (!isRetryableStatus(response.status) || attempt === MAX_FETCH_ATTEMPTS - 1) {
      let errBody = '';
      try { errBody = await response.text(); } catch (_) {}
      const err = new Error(`Vertex AI error (${response.status}): ${errBody.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }
    lastError = response;
  }
  throw lastError || new Error('Vertex AI request failed.');
}

// Race a stream read against the abort signal. A plain for-await loop only
// notices the signal when the next chunk arrives, so a stalled stream hangs
// forever despite the abort; this resolves as done the moment it fires.
function readWithSignal(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.resolve({ done: true, value: undefined });
  return new Promise((resolve) => {
    const onAbort = () => {
      try { reader.cancel(); } catch (_) {}
      resolve({ done: true, value: undefined });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (res) => {
        signal.removeEventListener('abort', onAbort);
        resolve(res);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve({ done: true, value: undefined });
      }
    );
  });
}

// Consume one SSE response. onChunk(kind, text) fires for 'thought' and
// 'token' chunks in arrival order; usageMetadata is captured when present.
// Prefers getReader (abort-aware); falls back to async-iterator bodies and
// finally to a buffered text() read for non-streaming mocks.
async function consumeVertexSseStream(response, { onChunk, signal } = {}) {
  let fullText = '';
  let usage = null;

  const processLine = (line) => {
    if (signal && signal.aborted) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (_) {
      return;
    }
    if (parsed.usageMetadata) {
      usage = parsed.usageMetadata;
    }
    const candidates = parsed.candidates || [];
    for (const candidate of candidates) {
      const parts = (candidate.content && candidate.content.parts) || [];
      for (const part of parts) {
        if (part && part.thought === true) {
          if (part.text && typeof onChunk === 'function') onChunk('thought', part.text);
          continue;
        }
        if (part && typeof part.text === 'string' && part.text.length > 0) {
          fullText += part.text;
          if (typeof onChunk === 'function') onChunk('token', part.text);
        }
      }
    }
  };

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
      if (signal && signal.aborted) break;
    }
    if (buffer.trim()) processLine(buffer);
  } else if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      if (signal && signal.aborted) break;
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    }
    if (buffer.trim()) processLine(buffer);
  } else if (typeof response.text === 'function') {
    const raw = await response.text();
    for (const line of raw.split(/\r?\n/)) {
      if (signal && signal.aborted) break;
      processLine(line);
    }
  }

  return { fullText, usage };
}

// One streaming attempt against a single region. Returns the completed result;
// throws on any failure before or during the stream.
async function attemptStreamRegion({ url, headers, body, signal, onChunk, fetchImpl }) {
  const response = await fetchWithRetry(fetchImpl, url, {
    method: 'POST',
    headers,
    body,
    signal
  });
  return consumeVertexSseStream(response, { onChunk, signal });
}

// Fire all candidate regions in parallel. The first region to yield any chunk
// wins and its chunks are forwarded; losers are aborted at once. Returns the
// winner's completed result. If the winner fails mid-stream (after chunks were
// shown), its error is thrown: the partial output stays, and falling back
// would duplicate it. If no region ever yields a chunk, the last failure wins.
async function hedgedStream({ locations, projectId, model, payload, headers, signal, onChunk, onFirstChunk, fetchImpl }) {
  let winner = null;
  const controllers = new Map();

  const abortLosers = (winLoc) => {
    for (const [loc, ctrl] of controllers) {
      if (loc !== winLoc) {
        try { ctrl.abort(); } catch (_) {}
      }
    }
  };

  const onOuterAbort = () => {
    for (const ctrl of controllers.values()) {
      try { ctrl.abort(); } catch (_) {}
    }
  };
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    const attempts = locations.map(async (location) => {
      const ctrl = new AbortController();
      controllers.set(location, ctrl);
      if (signal && signal.aborted) ctrl.abort();
      const url = buildVertexEndpointUrl({
        projectId,
        location,
        model,
        action: 'streamGenerateContent',
        sse: true
      });
      try {
        const { fullText, usage } = await attemptStreamRegion({
          url,
          headers,
          body: JSON.stringify(payload),
          signal: ctrl.signal,
          fetchImpl,
          onChunk: (kind, text) => {
            if (winner === null) {
              winner = location;
              abortLosers(location);
              if (typeof onFirstChunk === 'function') onFirstChunk();
            }
            if (winner === location && typeof onChunk === 'function') onChunk(kind, text);
          }
        });
        // An aborted attempt is a failure, not an empty success: without this,
        // a user cancel would surface as a completed empty result.
        if (ctrl.signal.aborted) {
          const abortErr = new Error('The operation was aborted.');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        return { ok: true, location, fullText, usage };
      } catch (err) {
        return { ok: false, location, error: err };
      }
    });

    const results = await Promise.all(attempts);
    if (winner !== null) {
      const win = results.find((r) => r.location === winner);
      if (win && win.ok) return win;
      if (win) throw win.error;
    }
    const lastFailure = results[results.length - 1] || results[0];
    throw (lastFailure && lastFailure.error) || new Error('Vertex AI streaming failed in all regions.');
  } finally {
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

// A hedge with a first-chunk deadline. On timeout the error carries
// code 'FIRST_CHUNK_TIMEOUT' so the caller can retry; a caller abort is
// rethrown as-is and always wins over the timeout.
async function runHedgeWithDeadline(args, timeoutMs) {
  const ctrl = new AbortController();
  const outer = args.signal;
  const onOuterAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    return await hedgedStream({
      ...args,
      signal: ctrl.signal,
      onFirstChunk: () => clearTimeout(timer)
    });
  } catch (err) {
    if (outer && outer.aborted) throw err;
    if (timedOut) {
      const timeoutErr = new Error(`Vertex AI streaming timed out before the first chunk (${timeoutMs}ms).`);
      timeoutErr.code = 'FIRST_CHUNK_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onOuterAbort);
  }
}

// Single-shot :generateContent across all regions in parallel; the first
// complete 200 wins. Thought parts are stripped; only answer text is kept.
async function generateVertexContent({ locations, projectId, model, payload, headers, signal, fetchImpl }) {
  const controllers = new Map();
  const onOuterAbort = () => {
    for (const ctrl of controllers.values()) {
      try { ctrl.abort(); } catch (_) {}
    }
  };
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const attempts = locations.map(async (location) => {
      const ctrl = new AbortController();
      controllers.set(location, ctrl);
      if (signal && signal.aborted) ctrl.abort();
      const url = buildVertexEndpointUrl({
        projectId,
        location,
        model,
        action: 'generateContent',
        sse: false
      });
      try {
        const response = await fetchWithRetry(fetchImpl, url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });
        const data = await response.json();
        const candidates = data.candidates || [];
        let fullText = '';
        for (const candidate of candidates) {
          const parts = (candidate.content && candidate.content.parts) || [];
          for (const part of parts) {
            if (part && part.thought === true) continue;
            if (part && typeof part.text === 'string') fullText += part.text;
          }
        }
        // A winner ends the race: abort the rest at once.
        for (const [loc, c] of controllers) {
          if (loc !== location) {
            try { c.abort(); } catch (_) {}
          }
        }
        return { ok: true, location, fullText, usage: data.usageMetadata || null };
      } catch (err) {
        return { ok: false, location, error: err };
      }
    });
    const results = await Promise.all(attempts);
    const win = results.find((r) => r.ok);
    if (win) return { fullText: win.fullText, usage: win.usage, region: win.location, model };
    const lastFailure = results[results.length - 1] || results[0];
    throw (lastFailure && lastFailure.error) || new Error('Vertex AI request failed in all regions.');
  } finally {
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

async function streamVertexGenerateContent(config = {}, params = {}, fetchImpl = fetch) {
  const auth = await getVertexAccessToken(config, fetchImpl);
  const projectId = String(config.projectId || auth.projectId || '').trim();
  if (!projectId) {
    throw new Error('Vertex AI requires a GCP Project ID. Add your Project ID or paste a Service Account JSON key in Settings.');
  }

  const model = cleanVertexModelId(params.model || config.model || 'gemini-3.8-flash');
  const preferredLocation = String(config.location || 'global').trim() || 'global';
  const candidateLocations = Array.from(new Set([
    preferredLocation,
    'global',
    'us-central1',
    'europe-west2'
  ]));

  const payload = buildVertexPayload(
    {
      ...params,
      thinkingLevel: params.thinkingLevel !== undefined ? params.thinkingLevel : config.thinkingLevel,
      webSearch: params.webSearch !== undefined ? params.webSearch : config.webSearch
    },
    model
  );

  const headers = {
    Authorization: `Bearer ${auth.token}`,
    'Content-Type': 'application/json',
    'x-goog-user-project': projectId
  };

  const signal = params.signal;
  const onToken = params.onToken;
  const onThought = params.onThought;
  let forwardedAny = false;
  const onChunk = (kind, text) => {
    forwardedAny = true;
    if (kind === 'thought') {
      if (typeof onThought === 'function') onThought(text);
    } else if (typeof onToken === 'function') {
      onToken(text);
    }
  };

  // Keep-alive until the first real chunk: an empty thought every 15s rearms
  // cue's 20s inactivity watchdog while a retry round or the fallback runs.
  // main.js forwards only non-empty thoughts to the UI, so this shows nothing.
  let keepAliveTimer = null;
  const stopKeepAlive = () => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  };
  const startKeepAlive = () => {
    if (keepAliveTimer || typeof onThought !== 'function') return;
    keepAliveTimer = setInterval(() => {
      if (!forwardedAny && !(signal && signal.aborted)) {
        try { onThought(''); } catch (_) {}
      }
    }, KEEPALIVE_MS);
  };

  const baseArgs = {
    locations: candidateLocations,
    projectId,
    model,
    payload,
    headers,
    fetchImpl
  };

  let streamingError = null;
  try {
    startKeepAlive();
    try {
      const res = await runHedgeWithDeadline({ ...baseArgs, signal, onChunk }, FIRST_CHUNK_TIMEOUT_MS);
      stopKeepAlive();
      return {
        fullText: res.fullText,
        usage: res.usage,
        region: res.location,
        model,
        authMode: auth.authMode
      };
    } catch (err) {
      if (signal && signal.aborted) throw err;
      streamingError = err;
      // Stalls get one retry round; fast failures (404 everywhere, bad key)
      // go straight to the fallback instead of burning another 20s.
      if (err && err.code === 'FIRST_CHUNK_TIMEOUT') {
        try {
          const res = await runHedgeWithDeadline({ ...baseArgs, signal, onChunk }, FIRST_CHUNK_TIMEOUT_MS);
          stopKeepAlive();
          return {
            fullText: res.fullText,
            usage: res.usage,
            region: res.location,
            model,
            authMode: auth.authMode
          };
        } catch (err2) {
          if (signal && signal.aborted) throw err2;
          streamingError = err2;
        }
      }
      // Anything already shown must never be duplicated by a fallback answer.
      if (forwardedAny) throw streamingError;
      // Non-streaming fallback, 45s deadline, hedged across regions.
      const fbCtrl = new AbortController();
      const fbTimer = setTimeout(() => fbCtrl.abort(), FALLBACK_TIMEOUT_MS);
      const onOuterAbort = () => fbCtrl.abort();
      if (signal) {
        if (signal.aborted) fbCtrl.abort();
        else signal.addEventListener('abort', onOuterAbort, { once: true });
      }
      try {
        const fb = await generateVertexContent({ ...baseArgs, signal: fbCtrl.signal });
        stopKeepAlive();
        if (fb.fullText && typeof onToken === 'function') onToken(fb.fullText);
        return {
          fullText: fb.fullText,
          usage: fb.usage,
          region: fb.region,
          model,
          authMode: auth.authMode
        };
      } catch (_) {
        throw streamingError;
      } finally {
        clearTimeout(fbTimer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
      }
    }
  } finally {
    stopKeepAlive();
  }
}

module.exports = {
  VERTEX_MODEL_OPTIONS,
  VERTEX_REGIONS,
  validateServiceAccountJson,
  createSignedJwt,
  getVertexAccessToken,
  clearVertexTokenCache,
  cleanVertexModelId,
  buildVertexEndpointUrl,
  buildVertexPayload,
  listVertexModels,
  generateVertexContent,
  streamVertexGenerateContent
};
