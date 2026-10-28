// src/companion-server.js
// Embedded loopback HTTP + WebSocket server for cue's Browser Companion.
// Provides port auto-probing (4123..4134), pairing with 60-second arming,
// token management via safeStorage, secret-redacting DOM capture, and WebSocket control.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

let electronSafeStorage = null;
let electronApp = null;
try {
  const electron = require('electron');
  electronSafeStorage = electron.safeStorage;
  electronApp = electron.app;
} catch {
  // Test environment without Electron
}

const DEFAULT_START_PORT = 4123;
const DEFAULT_END_PORT = 4134;
const DEFAULT_EXTENSION_ID = 'cuecompanionchromepinnedid0001';
const NATIVELY_STORE_ID = 'lmhgnkbjnelmciecjkleaomjpejcgaln';
const NATIVELY_DEV_ID = 'macjecgdfliikhplbbdbpljomcigjnjg';
const MAX_BODY_BYTES = 500000;
const MAX_TEXT_CHARS = 25000;
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60000;

function isAllowedExtensionOrigin(origin, configuredId) {
  if (!origin || typeof origin !== 'string') return false;
  const allowedIds = new Set([
    DEFAULT_EXTENSION_ID,
    NATIVELY_STORE_ID,
    NATIVELY_DEV_ID
  ]);
  if (configuredId) allowedIds.add(configuredId);

  for (const id of allowedIds) {
    if (origin === `chrome-extension://${id}`) return true;
  }
  // Structural match: standard Chrome extension IDs are 32 characters in range [a-p]
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function isLoopback(remoteAddress) {
  if (!remoteAddress) return false;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1' ||
    remoteAddress === 'localhost'
  );
}

function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9-_]{20,}/g, '[REDACTED]')
    .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/csk-[A-Za-z0-9-_]{20,}/g, '[REDACTED]')
    .replace(/bearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED]')
    .replace(/(?:password|passwd|pwd)\s*[:=]\s*(?:(?:password|passwd|pwd)\s*[:=]\s*)?\S+/gi, '[REDACTED]');
}

class RateLimiter {
  constructor(limit = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.requests = new Map();
  }

  isRateLimited(ip) {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    let timestamps = this.requests.get(ip);
    if (!timestamps) {
      timestamps = [];
      this.requests.set(ip, timestamps);
    }
    while (timestamps.length > 0 && timestamps[0] < windowStart) {
      timestamps.shift();
    }
    if (timestamps.length >= this.limit) {
      return true;
    }
    timestamps.push(now);
    return false;
  }

  reset() {
    this.requests.clear();
  }
}

class CompanionTokenManager {
  constructor(options = {}) {
    this.userDataDir = options.userDataDir || (electronApp ? electronApp.getPath('userData') : os.tmpdir());
    this.tokenFilePath = options.tokenFilePath || path.join(this.userDataDir, 'cue-companion-token.enc');
    this.safeStorage = options.safeStorage || electronSafeStorage;
  }

  loadOrCreateToken() {
    if (fs.existsSync(this.tokenFilePath)) {
      try {
        const encrypted = fs.readFileSync(this.tokenFilePath);
        const decrypted = this._decrypt(encrypted);
        if (decrypted && decrypted.length === 32) {
          return decrypted;
        }
      } catch {
        // Fall through to rotate fresh token on decryption failure
      }
    }
    return this.rotateToken();
  }

  rotateToken() {
    const token = crypto.randomBytes(24).toString('base64url');
    this._persist(token);
    return token;
  }

  _encrypt(plainText) {
    if (this.safeStorage && typeof this.safeStorage.encryptString === 'function') {
      return this.safeStorage.encryptString(plainText);
    }
    const key = crypto.createHash('sha256').update('cue-companion-token-key').digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]);
  }

  _decrypt(encryptedBuffer) {
    if (this.safeStorage && typeof this.safeStorage.decryptString === 'function') {
      return this.safeStorage.decryptString(encryptedBuffer);
    }
    const key = crypto.createHash('sha256').update('cue-companion-token-key').digest();
    const iv = encryptedBuffer.subarray(0, 12);
    const tag = encryptedBuffer.subarray(12, 28);
    const data = encryptedBuffer.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data, null, 'utf8') + decipher.final('utf8');
  }

  _persist(token) {
    const encrypted = this._encrypt(token);
    try {
      fs.mkdirSync(path.dirname(this.tokenFilePath), { recursive: true });
    } catch {}
    fs.writeFileSync(this.tokenFilePath, encrypted, { mode: 0o600 });
  }
}

class CompanionServer {
  constructor(options = {}) {
    this.startPort = options.startPort || DEFAULT_START_PORT;
    this.endPort = options.endPort || DEFAULT_END_PORT;
    this.extensionId = process.env.CUE_COMPANION_EXTENSION_ID || options.extensionId || DEFAULT_EXTENSION_ID;
    this.isSessionActive = options.isSessionActive || (() => true);
    this.onCaptured = options.onCaptured || null;
    this.tokenManager = new CompanionTokenManager(options);
    this.rateLimiter = new RateLimiter(options.rateLimitMax || RATE_LIMIT_MAX, options.rateLimitWindowMs || RATE_LIMIT_WINDOW_MS);

    this.token = this.tokenManager.loadOrCreateToken();
    this.port = null;
    this.httpServer = null;
    this.wss = null;
    this.clients = new Set();
    this.pairingWindowArmedUntil = 0;
    this.hasPaired = false;
    this.capturedContext = null;
    this.lastCapturedTitle = null;
  }

  armPairingWindow(durationMs = 60000) {
    this.pairingWindowArmedUntil = Date.now() + durationMs;
    return this.pairingWindowArmedUntil;
  }

  isPairingArmed() {
    return Date.now() < this.pairingWindowArmedUntil;
  }

  getPort() {
    return this.port;
  }

  getPairingString() {
    return `${this.port || 4123}:${this.token}`;
  }

  isPaired() {
    return this.hasPaired || this.clients.size > 0;
  }

  getLastCapturedTitle() {
    return this.lastCapturedTitle;
  }

  rotateToken() {
    this.token = this.tokenManager.rotateToken();
    return this.token;
  }

  consumeCapturedContext() {
    const ctx = this.capturedContext;
    this.capturedContext = null;
    return ctx;
  }

  requestDesktopCapture() {
    const reqId = crypto.randomUUID();
    const payload = JSON.stringify({ type: 'capture-dom', reqId });
    let sentCount = 0;
    for (const client of this.clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(payload);
        sentCount++;
      }
    }
    return { ok: true, reqId, sentCount };
  }

  async start() {
    this.httpServer = http.createServer((req, res) => this._handleHttpRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (req, socket, head) => {
      this._handleWebSocketUpgrade(req, socket, head);
    });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('message', (msgData) => {
        try {
          const parsed = JSON.parse(msgData.toString('utf8'));
          if (parsed && parsed.type === 'hello' && parsed.role === 'extension') {
            ws.role = 'extension';
          }
        } catch {}
      });
      ws.on('close', () => {
        this.clients.delete(ws);
      });
      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });

    for (let p = this.startPort; p <= this.endPort; p++) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (err) => {
            this.httpServer.removeListener('listening', onListening);
            reject(err);
          };
          const onListening = () => {
            this.httpServer.removeListener('error', onError);
            resolve();
          };
          this.httpServer.once('error', onError);
          this.httpServer.once('listening', onListening);
          this.httpServer.listen(p, '127.0.0.1');
        });
        this.port = p;
        return this.port;
      } catch (err) {
        if (err.code === 'EADDRINUSE') {
          continue;
        }
        throw err;
      }
    }
    throw new Error(`No available port in range ${this.startPort}..${this.endPort}`);
  }

  async stop() {
    for (const client of this.clients) {
      try { client.terminate(); } catch {}
    }
    this.clients.clear();
    if (this.wss) {
      try { this.wss.close(); } catch {}
    }
    if (this.httpServer && this.httpServer.listening) {
      await new Promise((resolve) => this.httpServer.close(resolve));
    }
    this.port = null;
  }

  _sendJson(res, statusCode, data, headers = {}) {
    const origin = headers['Access-Control-Allow-Origin'] || '*';
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      ...headers
    });
    res.end(JSON.stringify(data));
  }

  _handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port || 4123}`);
    const origin = req.headers.origin || '';
    const corsHeaders = origin.startsWith('chrome-extension://')
      ? { 'Access-Control-Allow-Origin': origin }
      : {};

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return;
    }

    if (url.pathname === '/healthz' && req.method === 'GET') {
      return this._sendJson(res, 200, { ok: true, clients: this.clients.size }, corsHeaders);
    }

    if (url.pathname === '/pair') {
      if (req.method !== 'POST') {
        return this._sendJson(res, 405, { error: 'method_not_allowed' }, corsHeaders);
      }
      if (!isLoopback(req.socket.remoteAddress)) {
        return this._sendJson(res, 403, { error: 'forbidden' }, corsHeaders);
      }
      if (!this.isPairingArmed()) {
        return this._sendJson(res, 410, { error: 'not_armed' }, corsHeaders);
      }
      if (!isAllowedExtensionOrigin(origin, this.extensionId)) {
        return this._sendJson(res, 403, { error: 'invalid_origin' }, corsHeaders);
      }
      this.pairingWindowArmedUntil = 0;
      this.hasPaired = true;
      return this._sendJson(res, 200, { token: this.token, port: this.port, success: true, ok: true }, corsHeaders);
    }

    if (url.pathname === '/dom') {
      if (req.method !== 'POST') {
        return this._sendJson(res, 405, { error: 'method_not_allowed' }, corsHeaders);
      }
      const token = url.searchParams.get('t');
      if (!token || token !== this.token) {
        return this._sendJson(res, 401, { error: 'unauthorized' }, corsHeaders);
      }
      const clientIp = req.socket.remoteAddress || '127.0.0.1';
      if (this.rateLimiter.isRateLimited(clientIp)) {
        return this._sendJson(res, 429, { error: 'rate_limited' }, corsHeaders);
      }
      if (!this.isSessionActive()) {
        return this._sendJson(res, 409, { error: 'no_active_session' }, corsHeaders);
      }

      let bytesReceived = 0;
      let bodyStr = '';
      let tooLarge = false;

      req.on('data', (chunk) => {
        if (tooLarge) return;
        bytesReceived += chunk.length;
        if (bytesReceived > MAX_BODY_BYTES) {
          tooLarge = true;
          this._sendJson(res, 413, { error: 'payload_too_large' }, corsHeaders);
          req.resume();
          return;
        }
        bodyStr += chunk.toString('utf8');
      });

      req.on('end', () => {
        if (tooLarge) return;
        let payload;
        try {
          payload = JSON.parse(bodyStr);
        } catch {
          return this._sendJson(res, 400, { error: 'bad_request' }, corsHeaders);
        }
        if (!payload || typeof payload.dom !== 'string') {
          return this._sendJson(res, 400, { error: 'bad_request' }, corsHeaders);
        }

        // Liveness / connection probe from Natively or Cue extension popup:
        // Authenticate successfully, but do NOT treat as user-captured context.
        if (payload.probe === true) {
          return this._sendJson(res, 200, { success: true, ok: true }, corsHeaders);
        }

        const cleanText = redactSecrets(payload.dom).slice(0, MAX_TEXT_CHARS);
        const meta = payload.meta || {};
        this.capturedContext = {
          text: cleanText,
          title: meta.title || 'Web Page',
          url: meta.url || '',
          receivedAt: Date.now()
        };
        this.lastCapturedTitle = this.capturedContext.title;

        if (typeof this.onCaptured === 'function') {
          try {
            this.onCaptured({
              title: this.capturedContext.title,
              text: this.capturedContext.text,
              url: this.capturedContext.url
            });
          } catch {}
        }

        return this._sendJson(res, 200, { success: true, ok: true }, corsHeaders);
      });
      return;
    }

    return this._sendJson(res, 404, { error: 'not_found' }, corsHeaders);
  }

  _handleWebSocketUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port || 4123}`);
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('t');
    if (!token || token !== this.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }
}

function createCompanionServer(options) {
  return new CompanionServer(options);
}

module.exports = {
  CompanionServer,
  CompanionTokenManager,
  RateLimiter,
  createCompanionServer,
  redactSecrets,
  DEFAULT_EXTENSION_ID,
  DEFAULT_START_PORT,
  DEFAULT_END_PORT
};