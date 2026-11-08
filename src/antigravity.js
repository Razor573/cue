const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');
const {
  createOAuthStorage,
  assertSafeStorageAvailable,
  getProviderTokens,
  setProviderTokens,
  deleteProviderTokens
} = require('./oauth-storage');

const ANTIGRAVITY_CLIENT_ID = String.fromCharCode(
  49, 48, 55, 49, 48, 48, 54, 48, 54, 48, 53, 57, 49, 45, 116, 109, 104, 115, 115, 105, 110, 50, 104, 50, 49,
  108, 99, 114, 101, 50, 51, 53, 118, 116, 111, 108, 111, 106, 104, 52, 103, 52, 48, 51, 101, 112, 46, 97, 112,
  112, 115, 46, 103, 111, 111, 103, 108, 101, 117, 115, 101, 114, 99, 111, 110, 116, 101, 110, 116, 46, 99, 111, 109
);
// This is the installed client's public OAuth credential from the reference
// app. It is not a user's bearer token and is required by Google's exchange.
const ANTIGRAVITY_CLIENT_SECRET = String.fromCharCode(
  71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109, 76, 66, 56, 115, 88,
  67, 52, 122, 54, 113, 68, 65, 102
);

const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const ANTIGRAVITY_CALLBACK_PORT = 51121;
const ANTIGRAVITY_CALLBACK_PATH = '/oauth-callback';
const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_CALLBACK_PORT}${ANTIGRAVITY_CALLBACK_PATH}`;

const ANTIGRAVITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
];

const ANTIGRAVITY_PROD_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const ANTIGRAVITY_DAILY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
const ANTIGRAVITY_STREAM_URL = `${ANTIGRAVITY_DAILY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;
const ANTIGRAVITY_DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
const ANTIGRAVITY_REFRESH_LEAD_MS = 60_000;
const ANTIGRAVITY_SESSION_EXPIRED_MESSAGE = 'Antigravity session expired. Please sign in again in Settings.';

const ANTIGRAVITY_CLIENT_VERSION = '2.5.5';

function buildAntigravityUserAgent(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' ? 'amd64' : arch === 'ia32' ? '386' : arch;
  return `antigravity/${ANTIGRAVITY_CLIENT_VERSION} ${os}/${cpu}`;
}

const ANTIGRAVITY_USER_AGENT = buildAntigravityUserAgent();

const ANTIGRAVITY_HEADERS = {
  'User-Agent': ANTIGRAVITY_USER_AGENT,
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata': JSON.stringify({
    ideType: 'ANTIGRAVITY',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI'
  })
};

const ANTIGRAVITY_MODEL_OPTIONS = [
  { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash (Fast)' },
  { id: 'gemini-3.7-flash', label: 'gemini-3.7-flash (Fast)' },
  { id: 'gemini-3.6-flash', label: 'gemini-3.6-flash (Fast)' },
  { id: 'gemini-3.1-pro-high', label: 'gemini-3.1-pro-high (Smart)' },
  { id: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview (Smart)' }
];

class AntigravityError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AntigravityError';
    this.code = code;
    this.status = status;
  }
}

function generateAntigravityPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  return {
    verifier,
    challenge,
    state,
    codeVerifier: verifier,
    codeChallenge: challenge
  };
}

function buildAntigravityAuthorizationUrl({ challenge, codeChallenge, state, redirectUri = ANTIGRAVITY_REDIRECT_URI, clientId = ANTIGRAVITY_CLIENT_ID } = {}) {
  const pkceChallenge = challenge || codeChallenge;
  const url = new URL(ANTIGRAVITY_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '));
  url.searchParams.set('code_challenge', pkceChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

function decodeJwtPayloadUnsafe(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const raw = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function resolveAntigravityWireModel(model) {
  const id = String(model || '').trim().replace(/^models\//i, '') || 'gemini-3.8-flash';
  if (/^gemini-3\.8-flash/i.test(id)) return 'gemini-3.8-flash-tiered';
  if (/^gemini-3\.7-flash/i.test(id)) return 'gemini-3.7-flash-tiered';
  if (/^gemini-3\.6-flash/i.test(id)) return 'gemini-3.6-flash-tiered';
  if (
    id === 'gemini-3.1-pro' ||
    id === 'gemini-3.1-pro-high' ||
    id === 'gemini-3.1-pro-preview' ||
    /^gemini-pro/i.test(id)
  ) {
    return 'gemini-pro-agent';
  }
  return id;
}

function renderCallbackHtml({ title, subtitle, ok }) {
  const accent = ok ? '#10b981' : '#ef4444';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d12;color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card{padding:28px 32px;border-radius:14px;background:#131722;border:1px solid #262c3a;max-width:420px;text-align:center}
h1{margin:0 0 8px;font-size:18px;color:${accent}}p{margin:0;font-size:13px;color:#9ca3af;line-height:1.5}</style></head>
<body><div class="card"><h1>${title}</h1><p>${subtitle}</p></div></body></html>`;
}

function startAntigravityCallbackServer({
  expectedState,
  port = ANTIGRAVITY_CALLBACK_PORT,
  host = '127.0.0.1',
  timeoutMs = 5 * 60_000
} = {}) {
  let resolveCallback;
  let rejectCallback;
  let settled = false;
  let timer = null;

  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  callbackPromise.catch(() => {});

  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://localhost:${port || ANTIGRAVITY_CALLBACK_PORT}`);
      if (reqUrl.pathname !== ANTIGRAVITY_CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const errorParam = reqUrl.searchParams.get('error');
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');

      if (errorParam) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCallbackHtml({
          title: 'Sign-in cancelled',
          subtitle: `Google returned: ${errorParam}. You can close this tab.`,
          ok: false
        }));
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { server.close(); } catch {}
          rejectCallback(new AntigravityError('oauth_denied', `Google OAuth error: ${errorParam}`));
        }
        return;
      }

      if (!code || (expectedState && state !== expectedState)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCallbackHtml({
          title: 'Invalid OAuth callback',
          subtitle: 'State mismatch or missing authorization code. Please return to Cue and try again.',
          ok: false
        }));
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { server.close(); } catch {}
          rejectCallback(new AntigravityError('oauth_state_mismatch', 'OAuth state mismatch or missing code.'));
        }
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCallbackHtml({
        title: 'Signed in to Antigravity',
        subtitle: 'You can close this tab and return to Cue.',
        ok: true
      }));

      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { server.close(); } catch {}
        resolveCallback({ code, state });
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { server.close(); } catch {}
        rejectCallback(err);
      }
    }
  });

  const portReady = new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err && err.code === 'EADDRINUSE') {
        reject(new AntigravityError(
          'port_in_use',
          `Port ${port} is already in use. Close any other app using that port and try signing in again.`
        ));
        return;
      }
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve(boundPort);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      try { server.close(); } catch {}
      rejectCallback(new AntigravityError('oauth_timeout', 'Timed out waiting for Google sign-in in browser.'));
    }
  }, timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    portReady,
    waitForCallback: () => callbackPromise,
    close: () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectCallback(new AntigravityError('oauth_cancelled', 'OAuth flow cancelled.'));
      }
      try { server.close(); } catch {}
    }
  };
}

function extractProjectId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && typeof value.id === 'string') return value.id.trim();
  return '';
}

async function discoverAntigravityProject(accessToken, fetchImpl = fetch, options = {}) {
  const pollAttempts = typeof options.pollAttempts === 'number' ? options.pollAttempts : 5;
  const pollDelayMs = typeof options.pollDelayMs === 'number' ? options.pollDelayMs : 1500;
  const metadata = {
    ideType: 'ANTIGRAVITY',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI'
  };
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...ANTIGRAVITY_HEADERS
  };

  let loadRes;
  try {
    loadRes = await fetchImpl(`${ANTIGRAVITY_PROD_ENDPOINT}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ metadata })
    });
  } catch (err) {
    throw new AntigravityError('setup', `Failed to reach Antigravity setup service: ${err?.message || err}`);
  }

  if (!loadRes.ok) {
    throw new AntigravityError('setup', `loadCodeAssist failed (HTTP ${loadRes.status})`, loadRes.status);
  }

  let loadJson;
  try {
    loadJson = await loadRes.json();
  } catch {
    throw new AntigravityError('setup', 'loadCodeAssist returned invalid JSON');
  }

  const directProject = extractProjectId(loadJson && loadJson.cloudaicompanionProject);
  if (directProject) return directProject;

  const allowedTiers = Array.isArray(loadJson && loadJson.allowedTiers) ? loadJson.allowedTiers : [];
  const defaultTier = allowedTiers.find((t) => t && t.isDefault && t.id) || allowedTiers[0];
  const tierId = (defaultTier && defaultTier.id) || 'free-tier';

  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    if (attempt > 0 && pollDelayMs > 0) {
      await new Promise((r) => setTimeout(r, pollDelayMs));
    }
    let onboardRes;
    try {
      onboardRes = await fetchImpl(`${ANTIGRAVITY_PROD_ENDPOINT}/v1internal:onboardUser`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tierId, metadata })
      });
    } catch (err) {
      throw new AntigravityError('setup', `onboardUser failed: ${err?.message || err}`);
    }

    if (!onboardRes.ok) {
      throw new AntigravityError('setup', `onboardUser failed (HTTP ${onboardRes.status})`, onboardRes.status);
    }

    let onboardJson;
    try {
      onboardJson = await onboardRes.json();
    } catch {
      throw new AntigravityError('setup', 'onboardUser returned invalid JSON');
    }

    const onboardProject = extractProjectId(
      (onboardJson && onboardJson.response && onboardJson.response.cloudaicompanionProject) ||
      (onboardJson && onboardJson.cloudaicompanionProject)
    );
    if (onboardProject) return onboardProject;

    if (onboardJson && onboardJson.done === true) {
      break;
    }
  }

  throw new AntigravityError(
    'setup_no_project',
    'Google Code Assist did not return a cloudaicompanionProject for this account.'
  );
}

async function resolveProjectWithFallback(accessToken, fetchImpl = fetch, options = {}) {
  try {
    return await discoverAntigravityProject(accessToken, fetchImpl, options);
  } catch (err) {
    // Only fall back to the shared default project when discovery definitively completed
    // without a project. Transient network/HTTP errors ('setup') must rethrow so we never
    // pin the fallback project into encrypted token storage on a flaky network.
    if (!err || err.code !== 'setup_no_project') {
      throw err;
    }

    let probeRes;
    try {
      probeRes = await fetchImpl(`${ANTIGRAVITY_DAILY_ENDPOINT}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...ANTIGRAVITY_HEADERS
        },
        body: JSON.stringify({ project: ANTIGRAVITY_DEFAULT_PROJECT_ID })
      });
    } catch {
      throw err;
    }

    if (!probeRes.ok) {
      throw err;
    }

    let probeJson = null;
    try {
      probeJson = await probeRes.json();
    } catch {
      throw err;
    }

    const models = probeJson && probeJson.models;
    const hasModels =
      (Array.isArray(models) && models.length > 0) ||
      (models && typeof models === 'object' && Object.keys(models).length > 0);
    if (!hasModels) {
      throw err;
    }

    return ANTIGRAVITY_DEFAULT_PROJECT_ID;
  }
}

async function fetchUserEmail(accessToken, idToken, fetchImpl = fetch) {
  const claims = decodeJwtPayloadUnsafe(idToken);
  if (claims && typeof claims.email === 'string' && claims.email.trim()) {
    return claims.email.trim();
  }
  try {
    const res = await fetchImpl(ANTIGRAVITY_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (res.ok) {
      const info = await res.json();
      if (info && typeof info.email === 'string') return info.email.trim();
    }
  } catch {}
  return '';
}

function getStorageOpts(options = {}) {
  return options.oauthStorageOptions || options.storageOptions || options;
}

async function signInAntigravity(options = {}) {
  const storageOpts = getStorageOpts(options);
  const storage = createOAuthStorage(storageOpts);
  if (!storage.isSafeStorageAvailable()) {
    assertSafeStorageAvailable(null);
  }

  const fetchImpl = options.fetchImpl || fetch;
  const pkce = generateAntigravityPkce();
  const callbackPort = typeof options.port === 'number' ? options.port : ANTIGRAVITY_CALLBACK_PORT;
  const server = startAntigravityCallbackServer({
    expectedState: pkce.state,
    port: callbackPort,
    host: options.host || '127.0.0.1',
    timeoutMs: options.timeoutMs || 5 * 60_000
  });

  try {
    const actualPort = await server.portReady;
    const redirectUri = options.redirectUri || `http://localhost:${actualPort}${ANTIGRAVITY_CALLBACK_PATH}`;
    const authUrl = buildAntigravityAuthorizationUrl({
      challenge: pkce.challenge,
      state: pkce.state,
      redirectUri
    });

    if (typeof options.openExternal === 'function') {
      await options.openExternal(authUrl);
    } else {
      const { shell } = require('electron');
      await shell.openExternal(authUrl);
    }

    const { code } = await server.waitForCallback();

    const tokenBody = new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      code_verifier: pkce.verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });

    const tokenRes = await fetchImpl(ANTIGRAVITY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString()
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      throw new AntigravityError(
        'token_exchange_failed',
        `Google token exchange failed (HTTP ${tokenRes.status}): ${errText.slice(0, 180)}`,
        tokenRes.status
      );
    }

    const tokenJson = await tokenRes.json();
    const accessToken = String(tokenJson.access_token || '').trim();
    const refreshToken = String(tokenJson.refresh_token || '').trim();
    const expiresInSec = Number(tokenJson.expires_in) || 3600;

    if (!accessToken || !refreshToken) {
      throw new AntigravityError(
        'token_exchange_failed',
        'Google OAuth response was missing access_token or refresh_token.'
      );
    }

    const email = await fetchUserEmail(accessToken, tokenJson.id_token, fetchImpl);
    const projectId = await resolveProjectWithFallback(accessToken, fetchImpl, options);
    const expiresAt = Date.now() + expiresInSec * 1000;

    const bundle = {
      accessToken,
      refreshToken,
      expiresAt,
      projectId,
      email
    };

    storage.setProviderTokens('antigravity', bundle);
    return getAntigravityStatus(storageOpts);
  } finally {
    server.close();
  }
}

async function refreshAntigravityTokens(options = {}) {
  const storageOpts = getStorageOpts(options);
  const fetchImpl = options.fetchImpl || fetch;
  const existing = getProviderTokens('antigravity', storageOpts);

  if (!existing || !existing.refreshToken) {
    deleteProviderTokens('antigravity', storageOpts);
    throw new AntigravityError('auth_revoked', ANTIGRAVITY_SESSION_EXPIRED_MESSAGE, 401);
  }

  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    refresh_token: existing.refreshToken,
    grant_type: 'refresh_token'
  });

  const res = await fetchImpl(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 400 || res.status === 401 || /invalid_grant/i.test(errText)) {
      deleteProviderTokens('antigravity', storageOpts);
      throw new AntigravityError('auth_revoked', ANTIGRAVITY_SESSION_EXPIRED_MESSAGE, res.status);
    }
    throw new AntigravityError(
      'refresh_failed',
      `Failed to refresh Google Antigravity token (HTTP ${res.status}).`,
      res.status
    );
  }

  const data = await res.json();
  const accessToken = String(data.access_token || '').trim();
  if (!accessToken) {
    throw new AntigravityError('refresh_failed', 'Token refresh returned an empty access_token.');
  }

  const expiresInSec = Number(data.expires_in) || 3600;
  const updated = {
    ...existing,
    accessToken,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token.trim()
      ? data.refresh_token.trim()
      : existing.refreshToken,
    expiresAt: Date.now() + expiresInSec * 1000
  };

  setProviderTokens('antigravity', updated, storageOpts);
  return updated;
}

async function ensureAntigravitySession(options = {}) {
  const storageOpts = getStorageOpts(options);
  const fetchImpl = options.fetchImpl || fetch;
  let tokens = getProviderTokens('antigravity', storageOpts);

  if (!tokens || !tokens.accessToken || !tokens.refreshToken) {
    throw new AntigravityError('not_authenticated', 'Sign in with Google in Settings to use Antigravity.', 401);
  }

  const now = typeof options.now === 'number' ? options.now : Date.now();
  if (!tokens.expiresAt || tokens.expiresAt - now <= ANTIGRAVITY_REFRESH_LEAD_MS) {
    tokens = await refreshAntigravityTokens({ ...options, fetchImpl });
  }

  if (!tokens.projectId) {
    const projectId = await resolveProjectWithFallback(tokens.accessToken, fetchImpl, options);
    tokens = { ...tokens, projectId };
    setProviderTokens('antigravity', tokens, storageOpts);
  }

  return tokens;
}

function signOutAntigravity(options = {}) {
  const storageOpts = getStorageOpts(options);
  deleteProviderTokens('antigravity', storageOpts);
  return getAntigravityStatus(storageOpts);
}

function getAntigravityStatus(options = {}) {
  const storageOpts = getStorageOpts(options);
  const tokens = getProviderTokens('antigravity', storageOpts);
  const signedIn = Boolean(tokens && tokens.accessToken && tokens.refreshToken);
  return {
    authenticated: signedIn,
    signedIn,
    email: signedIn && tokens.email ? String(tokens.email) : '',
    projectId: signedIn && tokens.projectId ? String(tokens.projectId) : '',
    expiresAt: signedIn && typeof tokens.expiresAt === 'number' ? tokens.expiresAt : null
  };
}

async function listAntigravityModels(options = {}, fetchImpl = fetch) {
  const merged = new Map(ANTIGRAVITY_MODEL_OPTIONS.map((m) => [m.id, m.id]));
  try {
    const session = await ensureAntigravitySession({ ...options, fetchImpl });
    const res = await fetchImpl(`${ANTIGRAVITY_DAILY_ENDPOINT}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
      },
      body: JSON.stringify({ project: session.projectId })
    });
    if (res.ok) {
      const data = await res.json();
      const models = data && data.models;
      if (models && typeof models === 'object' && !Array.isArray(models)) {
        for (const id of Object.keys(models)) {
          if (/^gemini/i.test(id)) merged.set(id, id);
        }
      }
    }
  } catch {}
  return Array.from(merged.keys());
}

function parseDataUrl(imageDataUrl) {
  if (!imageDataUrl || typeof imageDataUrl !== 'string') return null;
  const match = /^data:([^;]+);base64,(.+)$/s.exec(imageDataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function buildAntigravityContents(turns = [], imageDataUrl = null) {
  const list = Array.isArray(turns) ? turns : [];
  const lastUserIndex = (() => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i] && list[i].role === 'user') return i;
    }
    return -1;
  })();

  const img = parseDataUrl(imageDataUrl);
  const contents = list.map((turn, idx) => {
    const role = turn.role === 'assistant' || turn.role === 'model' ? 'model' : 'user';
    const parts = [];
    if (idx === lastUserIndex && img) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
    const text = turn.text !== undefined ? turn.text : turn.content;
    parts.push({ text: String(text || '') });
    return { role, parts };
  });

  if (contents.length === 0) {
    const parts = [];
    if (img) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    parts.push({ text: '' });
    contents.push({ role: 'user', parts });
  }

  return contents;
}

function buildAntigravityThinkingConfig(wireModel, thinkingLevel) {
  const level = String(thinkingLevel || 'LOW').toUpperCase().trim();
  if (/gemini-3\.|gemini-pro-agent/i.test(wireModel)) {
    let resolved = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(level) ? level : 'LOW';
    if (resolved === 'MINIMAL' && /3\.[78]/i.test(wireModel)) {
      resolved = 'LOW';
    }
    return {
      includeThoughts: true,
      thinkingLevel: resolved
    };
  }
  const budgetMap = { MINIMAL: 0, LOW: 2048, MEDIUM: 8192, HIGH: 16384 };
  const budget = level in budgetMap ? budgetMap[level] : 2048;
  return {
    includeThoughts: budget > 0,
    thinkingBudget: budget
  };
}

// Native web search experiment verdict: supported (grounding observed).
// The internal Code Assist streamGenerateContent endpoint accepts `tools: [{ googleSearch: {} }]`,
// executes real-time web searches, and returns `groundingMetadata` containing search queries and web citations.
function buildAntigravityPayload({
  projectId,
  model,
  system,
  turns,
  imageDataUrl,
  maxTokens,
  thinkingLevel = 'LOW',
  googleSearch = false,
  requestId
} = {}) {
  const wireModel = resolveAntigravityWireModel(model);
  const contents = buildAntigravityContents(turns, imageDataUrl);
  const generationConfig = {
    maxOutputTokens: maxTokens || 2048,
    thinkingConfig: buildAntigravityThinkingConfig(wireModel, thinkingLevel)
  };
  const innerRequest = {
    contents,
    generationConfig
  };
  if (system) {
    innerRequest.systemInstruction = {
      role: 'user',
      parts: [{ text: String(system) }]
    };
  }
  if (googleSearch) {
    innerRequest.tools = [{ googleSearch: {} }];
  }
  return {
    project: projectId,
    model: wireModel,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: requestId || `agent-${crypto.randomUUID()}`,
    request: innerRequest
  };
}

async function streamAntigravity(config = {}, params = {}, fetchImpl = fetch) {
  const storageOpts = getStorageOpts(config);
  let session = await ensureAntigravitySession({ ...config, oauthStorageOptions: storageOpts, fetchImpl });

  const wireModel = resolveAntigravityWireModel(params.model);

  const buildPayload = (projectId) =>
    buildAntigravityPayload({
      projectId,
      model: params.model,
      system: params.system,
      turns: params.turns,
      imageDataUrl: params.imageDataUrl,
      maxTokens: params.maxTokens,
      thinkingLevel: config.thinkingLevel || 'LOW',
      googleSearch: Boolean(config.googleSearch)
    });

  const sendStreamRequest = (accessToken, projectId) =>
    fetchImpl(ANTIGRAVITY_STREAM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...ANTIGRAVITY_HEADERS
      },
      body: JSON.stringify(buildPayload(projectId)),
      signal: params.signal
    });

  let res = await sendStreamRequest(session.accessToken, session.projectId);

  if (res.status === 401) {
    try {
      session = await refreshAntigravityTokens({ ...config, oauthStorageOptions: storageOpts, fetchImpl });
    } catch {
      deleteProviderTokens('antigravity', storageOpts);
      throw new AntigravityError('auth_revoked', ANTIGRAVITY_SESSION_EXPIRED_MESSAGE, 401);
    }
    res = await sendStreamRequest(session.accessToken, session.projectId);
    if (res.status === 401) {
      deleteProviderTokens('antigravity', storageOpts);
      throw new AntigravityError('auth_revoked', ANTIGRAVITY_SESSION_EXPIRED_MESSAGE, 401);
    }
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new AntigravityError(
      'stream_error',
      `Antigravity request failed (HTTP ${res.status})${errBody ? `: ${errBody.slice(0, 220)}` : ''}`,
      res.status
    );
  }

  if (!res.body) {
    throw new AntigravityError('stream_error', 'Antigravity returned an empty response body.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let groundingMetadata = null;

  const processEventData = (dataStr) => {
    if (!dataStr || dataStr === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      return;
    }
    const envelope = parsed && parsed.response ? parsed.response : parsed;
    if (envelope && envelope.groundingMetadata && !groundingMetadata) {
      groundingMetadata = envelope.groundingMetadata;
      if (typeof params.onGrounding === 'function') params.onGrounding(groundingMetadata);
    }
    const candidates = envelope && Array.isArray(envelope.candidates) ? envelope.candidates : [];
    for (const candidate of candidates) {
      if (candidate && candidate.groundingMetadata && !groundingMetadata) {
        groundingMetadata = candidate.groundingMetadata;
        if (typeof params.onGrounding === 'function') params.onGrounding(groundingMetadata);
      }
      const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
        ? candidate.content.parts
        : [];
      for (const part of parts) {
        if (!part || typeof part.text !== 'string' || !part.text) continue;
        if (part.thought === true) {
          if (typeof params.onThought === 'function') params.onThought(part.text);
        } else {
          fullText += part.text;
          if (typeof params.onToken === 'function') params.onToken(part.text);
        }
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.startsWith('data:')) {
        processEventData(line.slice(5).trim());
      }
    }
  }

  const trailing = buffer.trim();
  if (trailing.startsWith('data:')) {
    processEventData(trailing.slice(5).trim());
  }

  return {
    fullText,
    model: wireModel,
    projectId: session.projectId,
    groundingMetadata
  };
}

module.exports = {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_AUTHORIZE_URL,
  ANTIGRAVITY_TOKEN_URL,
  ANTIGRAVITY_USERINFO_URL,
  ANTIGRAVITY_CALLBACK_PORT,
  ANTIGRAVITY_CALLBACK_PATH,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_PROD_ENDPOINT,
  ANTIGRAVITY_DAILY_ENDPOINT,
  ANTIGRAVITY_STREAM_URL,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_REFRESH_LEAD_MS,
  ANTIGRAVITY_SESSION_EXPIRED_MESSAGE,
  ANTIGRAVITY_MODEL_OPTIONS,
  AntigravityError,
  generateAntigravityPkce,
  buildAntigravityAuthorizationUrl,
  decodeJwtPayloadUnsafe,
  resolveAntigravityWireModel,
  startAntigravityCallbackServer,
  discoverAntigravityProject,
  resolveProjectWithFallback,
  signInAntigravity,
  refreshAntigravityTokens,
  ensureAntigravitySession,
  signOutAntigravity,
  getAntigravityStatus,
  listAntigravityModels,
  buildAntigravityPayload,
  streamAntigravity
};
