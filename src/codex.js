// Codex OAuth provider for ChatGPT accounts.
// Usage through this provider counts against the user's ChatGPT subscription plan quota
// (Plus / Pro / Team) rather than standard API key billing.
// Note: This relies on the public Codex CLI OAuth client (`app_EMoamEEZ73f0CkXaXp7hrann`),
// which OpenAI may modify or restrict in future updates.

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
const { decodeJwtPayloadUnsafe } = require('./antigravity');

const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_SCOPE = 'openid profile email offline_access';
const CODEX_OAUTH_PREFERRED_PORT = 1455;
const CODEX_OAUTH_CALLBACK_PATH = '/auth/callback';
const CODEX_OAUTH_REFRESH_LEAD_MS = 5 * 60 * 1000;
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

const CODEX_SESSION_EXPIRED_MESSAGE = 'ChatGPT session expired. Please sign in again in Settings.';
const CODEX_PLAN_LIMIT_MESSAGE =
  'ChatGPT plan limit reached (429). Please wait for your ChatGPT subscription window to reset or switch providers.';

const CODEX_MODEL_OPTIONS = [
  {
    id: 'gpt-5.5',
    label: 'gpt-5.5 (Fast)',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'gpt-5.5-codex',
    label: 'gpt-5.5-codex (Smart)',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'gpt-5.4-codex',
    label: 'gpt-5.4-codex',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'gpt-5.2-codex',
    label: 'gpt-5.2-codex',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'gpt-5.2',
    label: 'gpt-5.2',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'gpt-5.1-codex',
    label: 'gpt-5.1-codex',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high']
  }
];

function generateCodexPkce() {
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

function buildCodexAuthorizeUrl({ redirectUri, state, challenge, codeChallenge }) {
  const pkceChallenge = challenge || codeChallenge;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CODEX_OAUTH_SCOPE,
    code_challenge: pkceChallenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs'
  });
  return `${CODEX_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

function decodeCodexIdToken(idToken) {
  const claims = decodeJwtPayloadUnsafe(idToken);
  if (!claims || typeof claims !== 'object') {
    return { email: null, accountId: null };
  }
  const email = typeof claims.email === 'string' && claims.email.trim() ? claims.email.trim() : null;
  const authClaim = claims['https://api.openai.com/auth'];
  const accountId =
    authClaim && typeof authClaim === 'object' && typeof authClaim.chatgpt_account_id === 'string'
      ? authClaim.chatgpt_account_id.trim()
      : null;
  return { email, accountId };
}

function renderCodexCallbackHtml({ title, subtitle, ok }) {
  const accent = ok ? '#10b981' : '#ef4444';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d12;color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card{padding:28px 32px;border-radius:14px;background:#131722;border:1px solid #262c3a;max-width:420px;text-align:center}
h1{margin:0 0 8px;font-size:18px;color:${accent}}p{margin:0;font-size:13px;color:#9ca3af;line-height:1.5}</style></head>
<body><div class="card"><h1>${title}</h1><p>${subtitle}</p></div></body></html>`;
}

function startCodexCallbackServer({
  preferredPort = CODEX_OAUTH_PREFERRED_PORT,
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
      const reqUrl = new URL(req.url || '/', 'http://localhost');
      if (reqUrl.pathname !== CODEX_OAUTH_CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      const error = reqUrl.searchParams.get('error');
      const errorDescription = reqUrl.searchParams.get('error_description');
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');

      if (error) {
        const msg = errorDescription || error;
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCodexCallbackHtml({
          title: 'Sign-in cancelled',
          subtitle: `${msg}. You can close this tab.`,
          ok: false
        }));
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { server.close(); } catch {}
          rejectCallback(new Error(`OAuth error: ${msg}`));
        }
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCodexCallbackHtml({
          title: 'Sign-in incomplete',
          subtitle: 'Missing authorization code or state parameter.',
          ok: false
        }));
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { server.close(); } catch {}
          rejectCallback(new Error('Missing code or state on callback'));
        }
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCodexCallbackHtml({
        title: 'Signed in with ChatGPT',
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

  const tryListen = (port) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Unexpected server address'));
          return;
        }
        resolve(addr.port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

  const portReady = (async () => {
    try {
      return await tryListen(preferredPort);
    } catch (err) {
      if (preferredPort !== 0 && err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
        return await tryListen(0);
      }
      throw err;
    }
  })();

  timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      try { server.close(); } catch {}
      rejectCallback(new Error('OAuth sign-in timed out after 5 minutes'));
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
        rejectCallback(new Error('OAuth sign-in cancelled'));
      }
      try { server.close(); } catch {}
    }
  };
}

function getStorageOpts(options = {}) {
  return options.oauthStorageOptions || options.storageOptions || options;
}

function parseTokenBundle(bundle, fallbackRefreshToken = '') {
  const accessToken = typeof bundle.access_token === 'string' ? bundle.access_token.trim() : '';
  const refreshToken =
    typeof bundle.refresh_token === 'string' && bundle.refresh_token.trim()
      ? bundle.refresh_token.trim()
      : fallbackRefreshToken;
  const idToken = typeof bundle.id_token === 'string' ? bundle.id_token.trim() : '';

  if (!accessToken || !refreshToken) {
    throw new Error('OAuth token response missing access_token or refresh_token');
  }

  let expiresAt = Date.now() + 3600 * 1000;
  if (typeof bundle.expires_in === 'number' && Number.isFinite(bundle.expires_in)) {
    expiresAt = Date.now() + bundle.expires_in * 1000;
  } else {
    const accessClaims = decodeJwtPayloadUnsafe(accessToken);
    if (accessClaims && typeof accessClaims.exp === 'number') {
      expiresAt = accessClaims.exp * 1000;
    }
  }

  const { email: idEmail, accountId: idAccount } = idToken
    ? decodeCodexIdToken(idToken)
    : { email: null, accountId: null };
  const { email: accessEmail, accountId: accessAccount } = decodeCodexIdToken(accessToken);

  return {
    accessToken,
    refreshToken,
    idToken,
    expiresAt,
    email: idEmail || accessEmail || '',
    accountId: idAccount || accessAccount || '',
    lastRefreshAt: Date.now()
  };
}

async function signInCodex(options = {}) {
  const storageOpts = getStorageOpts(options);
  const storage = createOAuthStorage(storageOpts);
  if (!storage.isSafeStorageAvailable()) {
    assertSafeStorageAvailable(null);
  }

  const fetchImpl = options.fetchImpl || fetch;
  const pkce = generateCodexPkce();
  const preferredPort =
    typeof options.preferredPort === 'number'
      ? options.preferredPort
      : typeof options.port === 'number'
        ? options.port
        : CODEX_OAUTH_PREFERRED_PORT;

  const server = startCodexCallbackServer({
    preferredPort,
    host: options.host || '127.0.0.1',
    timeoutMs: options.timeoutMs || 5 * 60_000
  });

  try {
    const actualPort = await server.portReady;
    const redirectUri = options.redirectUri || `http://localhost:${actualPort}${CODEX_OAUTH_CALLBACK_PATH}`;
    const authorizeUrl = buildCodexAuthorizeUrl({
      redirectUri,
      state: pkce.state,
      challenge: pkce.challenge
    });

    if (typeof options.openExternal === 'function') {
      await options.openExternal(authorizeUrl);
    } else {
      const { shell } = require('electron');
      await shell.openExternal(authorizeUrl);
    }

    const { code, state } = await server.waitForCallback();
    if (state !== pkce.state) {
      throw new Error('OAuth state mismatch (possible CSRF); aborting sign-in.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CODEX_OAUTH_CLIENT_ID,
      code_verifier: pkce.verifier
    });

    const res = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Token exchange failed (${res.status}): ${errText.slice(0, 200)}`);
    }

    const tokenJson = await res.json();
    const tokens = parseTokenBundle(tokenJson);
    storage.setProviderTokens('codex', tokens);
    return getCodexStatus(storageOpts);
  } finally {
    server.close();
  }
}

async function refreshCodexTokens(options = {}) {
  const storageOpts = getStorageOpts(options);
  const fetchImpl = options.fetchImpl || fetch;
  const existing = getProviderTokens('codex', storageOpts);

  if (!existing || !existing.refreshToken) {
    deleteProviderTokens('codex', storageOpts);
    const err = new Error(CODEX_SESSION_EXPIRED_MESSAGE);
    err.code = 'auth_revoked';
    err.status = 401;
    throw err;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: existing.refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
    scope: CODEX_OAUTH_SCOPE
  });

  const res = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const isRevoked =
      res.status === 400 ||
      res.status === 401 ||
      /invalid_grant|refresh_token_expired|refresh_token_reused|refresh_token_invalidated/i.test(errText);
    if (isRevoked) {
      deleteProviderTokens('codex', storageOpts);
      const err = new Error(CODEX_SESSION_EXPIRED_MESSAGE);
      err.code = 'auth_revoked';
      err.status = res.status;
      throw err;
    }
    const err = new Error(`Token refresh failed (${res.status}): ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const bundle = await res.json();
  const parsed = parseTokenBundle(bundle, existing.refreshToken);
  const updated = {
    ...existing,
    ...parsed,
    // Always overwrite refreshToken when OpenAI rotates it on refresh so the next refresh does not fail.
    refreshToken:
      typeof bundle.refresh_token === 'string' && bundle.refresh_token.trim()
        ? bundle.refresh_token.trim()
        : existing.refreshToken,
    email: parsed.email || existing.email || '',
    accountId: parsed.accountId || existing.accountId || ''
  };

  setProviderTokens('codex', updated, storageOpts);
  return updated;
}

async function ensureCodexSession(options = {}) {
  const storageOpts = getStorageOpts(options);
  const fetchImpl = options.fetchImpl || fetch;
  let tokens = getProviderTokens('codex', storageOpts);

  if (!tokens || !tokens.accessToken || !tokens.refreshToken) {
    const err = new Error('Sign in with ChatGPT in Settings to use Codex.');
    err.code = 'not_authenticated';
    err.status = 401;
    throw err;
  }

  const now = typeof options.now === 'number' ? options.now : Date.now();
  if (!tokens.expiresAt || tokens.expiresAt - now <= CODEX_OAUTH_REFRESH_LEAD_MS) {
    tokens = await refreshCodexTokens({ ...options, oauthStorageOptions: storageOpts, fetchImpl });
  }

  return tokens;
}

function signOutCodex(options = {}) {
  const storageOpts = getStorageOpts(options);
  deleteProviderTokens('codex', storageOpts);
  return getCodexStatus(storageOpts);
}

function getCodexStatus(options = {}) {
  const storageOpts = getStorageOpts(options);
  const tokens = getProviderTokens('codex', storageOpts);
  const signedIn = Boolean(tokens && tokens.accessToken && tokens.refreshToken);
  return {
    authenticated: signedIn,
    signedIn,
    email: signedIn && tokens.email ? String(tokens.email) : '',
    accountId: signedIn && tokens.accountId ? String(tokens.accountId) : '',
    expiresAt: signedIn && typeof tokens.expiresAt === 'number' ? tokens.expiresAt : null
  };
}

function resolveCodexReasoningEffort(modelId, pick) {
  const normalized = String(modelId || '').trim().toLowerCase();
  const entry = CODEX_MODEL_OPTIONS.find((m) => m.id.toLowerCase() === normalized) || CODEX_MODEL_OPTIONS[0];
  if (pick && entry.supportedReasoningEfforts.includes(pick)) {
    return pick;
  }
  return entry.defaultReasoningEffort;
}

function buildCodexInputItems(turns = [], imageDataUrl = null) {
  const list = Array.isArray(turns) ? turns : [];
  const lastUserIdx = (() => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i] && list[i].role === 'user') return i;
    }
    return -1;
  })();

  const items = list.map((turn, idx) => {
    const isAssistant = turn.role === 'assistant' || turn.role === 'model';
    const text = turn.text !== undefined ? turn.text : turn.content;
    if (isAssistant) {
      return {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: String(text || '') }]
      };
    }
    const content = [];
    if (idx === lastUserIdx && imageDataUrl) {
      content.push({ type: 'input_image', image_url: imageDataUrl });
    }
    content.push({ type: 'input_text', text: String(text || '') });
    return {
      type: 'message',
      role: 'user',
      content
    };
  });

  if (items.length === 0) {
    const content = [];
    if (imageDataUrl) content.push({ type: 'input_image', image_url: imageDataUrl });
    content.push({ type: 'input_text', text: '' });
    items.push({ type: 'message', role: 'user', content });
  }

  return items;
}

function createPlanLimitError(detail = '') {
  const suffix = detail && !/chatgpt plan limit/i.test(detail) ? ` (${detail})` : '';
  const err = new Error(`${CODEX_PLAN_LIMIT_MESSAGE}${suffix}`);
  err.status = 429;
  err.code = 'plan_limit';
  return err;
}

async function streamCodexResponses(config = {}, params = {}, fetchImpl = fetch) {
  const storageOpts = getStorageOpts(config);
  let session = await ensureCodexSession({ ...config, oauthStorageOptions: storageOpts, fetchImpl });

  const model = String(params.model || 'gpt-5.5').trim() || 'gpt-5.5';
  const effort = resolveCodexReasoningEffort(model, config.reasoningEffort);
  const input = buildCodexInputItems(params.turns, params.imageDataUrl);

  const payload = {
    model,
    instructions: String(params.system || 'You are a helpful assistant.'),
    input,
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    stream: true,
    store: false
  };
  if (effort) {
    payload.reasoning = { effort, summary: 'auto' };
  }

  const sendRequest = (tokens) => {
    const headers = {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      originator: 'codex_cli_rs'
    };
    if (tokens.accountId) {
      headers['chatgpt-account-id'] = tokens.accountId;
    }
    return fetchImpl(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: params.signal
    });
  };

  let res = await sendRequest(session);

  if (res.status === 401) {
    try {
      session = await refreshCodexTokens({ ...config, oauthStorageOptions: storageOpts, fetchImpl });
    } catch {
      signOutCodex(storageOpts);
      const err = new Error(CODEX_SESSION_EXPIRED_MESSAGE);
      err.status = 401;
      err.code = 'auth_revoked';
      throw err;
    }
    res = await sendRequest(session);
    if (res.status === 401) {
      signOutCodex(storageOpts);
      const err = new Error(CODEX_SESSION_EXPIRED_MESSAGE);
      err.status = 401;
      err.code = 'auth_revoked';
      throw err;
    }
  }

  if (res.status === 429) {
    const errText = await res.text().catch(() => '');
    throw createPlanLimitError(errText.slice(0, 120).trim());
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (/usage_limit|rate_limit|plan limit|quota/i.test(errText)) {
      throw createPlanLimitError(errText.slice(0, 120).trim());
    }
    const err = new Error(`Codex backend error (${res.status}): ${errText.slice(0, 240)}`);
    err.status = res.status;
    throw err;
  }

  if (!res.body) {
    throw new Error('Codex backend returned an empty response body.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let completed = false;
  let streamError = null;

  const handleEventBlock = (rawBlock) => {
    if (!rawBlock.trim()) return;
    let eventName = null;
    const dataLines = [];
    for (const rawLine of rawBlock.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) return;
    const dataStr = dataLines.join('\n');
    if (dataStr === '[DONE]') {
      completed = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      return;
    }
    const type = eventName || (parsed && parsed.type) || '';

    if (type === 'response.output_text.delta') {
      const delta = parsed && typeof parsed.delta === 'string' ? parsed.delta : '';
      if (delta) {
        fullText += delta;
        if (typeof params.onToken === 'function') params.onToken(delta);
      }
      return;
    }

    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning.delta') {
      const delta = parsed && typeof parsed.delta === 'string' ? parsed.delta : '';
      if (delta && typeof params.onThought === 'function') {
        params.onThought(delta);
      }
      return;
    }

    if (type === 'response.completed' || type === 'response.done') {
      if (!fullText && parsed && parsed.response && Array.isArray(parsed.response.output)) {
        for (const item of parsed.response.output) {
          const content = item && Array.isArray(item.content) ? item.content : [];
          for (const part of content) {
            if (part && part.type === 'output_text' && typeof part.text === 'string' && part.text) {
              fullText += part.text;
              if (typeof params.onToken === 'function') params.onToken(part.text);
            }
          }
        }
      }
      completed = true;
      return;
    }

    if (type === 'error' || type === 'response.failed') {
      const errObj = (parsed && parsed.error) || (parsed && parsed.response && parsed.response.error) || parsed || {};
      const code = String(errObj.code || errObj.type || '');
      const msg = String(errObj.message || 'Codex stream failed');
      if (/rate_limit|usage_limit|plan_limit|quota|too_many_requests/i.test(`${code} ${msg}`)) {
        streamError = createPlanLimitError(msg);
      } else {
        streamError = new Error(msg);
      }
      completed = true;
    }
  };

  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepIndex;
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        handleEventBlock(block);
        if (completed) break;
      }
    }
    if (!completed && buffer.trim()) {
      handleEventBlock(buffer);
    }
  } catch (err) {
    if (!(completed && params.signal && params.signal.aborted)) {
      throw err;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  if (streamError) throw streamError;

  return {
    fullText,
    model
  };
}

module.exports = {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_OAUTH_SCOPE,
  CODEX_OAUTH_PREFERRED_PORT,
  CODEX_OAUTH_CALLBACK_PATH,
  CODEX_OAUTH_REFRESH_LEAD_MS,
  CODEX_RESPONSES_URL,
  CODEX_SESSION_EXPIRED_MESSAGE,
  CODEX_PLAN_LIMIT_MESSAGE,
  CODEX_MODEL_OPTIONS,
  generateCodexPkce,
  buildCodexAuthorizeUrl,
  decodeCodexIdToken,
  startCodexCallbackServer,
  signInCodex,
  refreshCodexTokens,
  ensureCodexSession,
  signOutCodex,
  getCodexStatus,
  resolveCodexReasoningEffort,
  streamCodexResponses
};
