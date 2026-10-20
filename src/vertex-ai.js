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

async function exchangeTokenRequest(tokenUri, bodyParams, fetchImpl = fetch) {
  const body = new URLSearchParams(bodyParams).toString();
  const response = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
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

  const response = await fetchImpl(url, { method: 'GET', headers });
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

async function consumeVertexSseStream(response, onToken, onThought, signal) {
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
          if (part.text && typeof onThought === 'function') {
            onThought(part.text);
          }
          continue;
        }
        if (part && typeof part.text === 'string' && part.text.length > 0) {
          fullText += part.text;
          if (typeof onToken === 'function') onToken(part.text);
        }
      }
    }
  };

  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
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

  let lastError = null;
  for (let i = 0; i < candidateLocations.length; i++) {
    const location = candidateLocations[i];
    const url = buildVertexEndpointUrl({
      projectId,
      location,
      model,
      action: 'streamGenerateContent',
      sse: true
    });

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        'x-goog-user-project': projectId
      },
      body: JSON.stringify(payload),
      signal: params.signal
    });

    if (response.status === 404 && i < candidateLocations.length - 1) {
      let errBody = '';
      try { errBody = await response.text(); } catch (_) {}
      lastError = Object.assign(
        new Error(`Vertex AI model "${model}" not found in ${location} (404): ${errBody.slice(0, 200)}`),
        { status: 404 }
      );
      continue;
    }

    if (!response.ok) {
      let errBody = '';
      try { errBody = await response.text(); } catch (_) {}
      const err = new Error(`Vertex AI error (${response.status} in ${location}): ${errBody.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }

    const { fullText, usage } = await consumeVertexSseStream(response, params.onToken, params.onThought, params.signal);
    return {
      fullText,
      usage,
      region: location,
      model,
      authMode: auth.authMode
    };
  }

  throw lastError || new Error(`Vertex AI request failed for model "${model}".`);
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
  streamVertexGenerateContent
};
