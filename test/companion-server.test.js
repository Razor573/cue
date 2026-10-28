// test/companion-server.test.js
// Unit tests covering cue's Browser Companion server:
// 1. Healthz discovery & port probing (4123..4134)
// 2. Pairing window (armed 60s, burns on first pair, rejects expired, validates Origin)
// 3. Auth (401 on bad/missing token, 200 on valid token)
// 4. Rate limiting (120 req / 60s -> 429)
// 5. Body cap (>500k bytes -> 413) and truncation to 25k chars
// 6. Status contracts (405 on GET /dom, 409 when no active session, OPTIONS CORS 204)
// 7. Secrets stripping (redacts API keys, JWTs, private keys, passwords)
// 8. Single-use consumption (read-and-clear via consumeCapturedContext)
// 9. WebSocket desktop capture trigger

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WebSocket } = require('ws');
const {
  createCompanionServer,
  redactSecrets,
  DEFAULT_EXTENSION_ID
} = require('../src/companion-server');

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-companion-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mockSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (str) => Buffer.from(`enc:${str}`, 'utf8'),
    decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, '')
  };
}

async function httpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body !== null) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test('1. Healthz discovery and port probing across range 4123..4134', async (t) => {
  const dir = createTempDir(t);
  const server1 = createCompanionServer({
    userDataDir: dir,
    safeStorage: mockSafeStorage(),
    startPort: 4200,
    endPort: 4205
  });
  t.after(async () => { await server1.stop(); });

  const port1 = await server1.start();
  assert.equal(port1, 4200);

  const res1 = await httpRequest(`http://127.0.0.1:${port1}/healthz`);
  assert.equal(res1.status, 200);
  assert.equal(res1.json.ok, true);
  assert.equal(res1.json.clients, 0);

  // Start second server: 4200 is occupied, probes and binds to 4201
  const dir2 = createTempDir(t);
  const server2 = createCompanionServer({
    userDataDir: dir2,
    safeStorage: mockSafeStorage(),
    startPort: 4200,
    endPort: 4205
  });
  t.after(async () => { await server2.stop(); });

  const port2 = await server2.start();
  assert.equal(port2, 4201);

  const res2 = await httpRequest(`http://127.0.0.1:${port2}/healthz`);
  assert.equal(res2.status, 200);
  assert.equal(res2.json.ok, true);
});

test('2. Pairing window: armed 60s, burns on first pair, rejects expired, validates Origin', async (t) => {
  const dir = createTempDir(t);
  const server = createCompanionServer({
    userDataDir: dir,
    safeStorage: mockSafeStorage(),
    startPort: 4210,
    endPort: 4215
  });
  t.after(async () => { await server.stop(); });
  const port = await server.start();

  // A. Not armed -> 410
  const unArmedRes = await httpRequest(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { origin: `chrome-extension://${DEFAULT_EXTENSION_ID}` }
  });
  assert.equal(unArmedRes.status, 410);
  assert.equal(unArmedRes.json.error, 'not_armed');

  // B. Arm window for 60s
  server.armPairingWindow(60000);

  // C. Invalid origin -> 403
  const badOriginRes = await httpRequest(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { origin: 'chrome-extension://unauthorizedextensionid1234' }
  });
  assert.equal(badOriginRes.status, 403);
  assert.equal(badOriginRes.json.error, 'invalid_origin');

  // D. Valid origin and armed -> 200, returns token
  const validRes = await httpRequest(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { origin: `chrome-extension://${DEFAULT_EXTENSION_ID}` }
  });
  assert.equal(validRes.status, 200);
  assert.ok(validRes.json.token);
  assert.equal(validRes.json.port, port);
  assert.equal(validRes.json.success, true);

  // D2. Natively Web Store extension origin works
  server.armPairingWindow(60000);
  const nativelyRes = await httpRequest(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { origin: 'chrome-extension://lmhgnkbjnelmciecjkleaomjpejcgaln' }
  });
  assert.equal(nativelyRes.status, 200);
  assert.equal(nativelyRes.json.success, true);

  // E. Burns on first pair: immediately calling again returns 410
  const burnedRes = await httpRequest(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { origin: `chrome-extension://${DEFAULT_EXTENSION_ID}` }
  });
  assert.equal(burnedRes.status, 410);

  // F. Expired window -> 410
  server.armPairingWindow(15);
  await new Promise((r) => setTimeout(r, 25));
  const expiredRes = await httpRequest(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { origin: `chrome-extension://${DEFAULT_EXTENSION_ID}` }
  });
  assert.equal(expiredRes.status, 410);
});

test('3. Auth: 401 on bad/missing token, 200 on valid token', async (t) => {
  const dir = createTempDir(t);
  const server = createCompanionServer({
    userDataDir: dir,
    safeStorage: mockSafeStorage(),
    startPort: 4220,
    endPort: 4225
  });
  t.after(async () => { await server.stop(); });
  const port = await server.start();

  // Missing token
  const noTokenRes = await httpRequest(`http://127.0.0.1:${port}/dom`, { method: 'POST' }, { dom: 'Sample text' });
  assert.equal(noTokenRes.status, 401);

  // Bad token
  const badTokenRes = await httpRequest(`http://127.0.0.1:${port}/dom?t=invalidtokenvalue`, { method: 'POST' }, { dom: 'Sample text' });
  assert.equal(badTokenRes.status, 401);

  // Valid token
  const validRes = await httpRequest(`http://127.0.0.1:${port}/dom?t=${server.token}`, { method: 'POST' }, { dom: 'Sample text' });
  assert.equal(validRes.status, 200);
  assert.equal(validRes.json.ok, true);
});

test('4. Rate limit: 120 requests per 60 seconds per IP returns 429', async (t) => {
  const dir = createTempDir(t);
  const server = createCompanionServer({
    userDataDir: dir,
    safeStorage: mockSafeStorage(),
    startPort: 4230,
    endPort: 4235,
    rateLimitMax: 120,
    rateLimitWindowMs: 60000
  });
  t.after(async () => { await server.stop(); });
  const port = await server.start();

  // Fire 120 requests
  for (let i = 0; i < 120; i++) {
    const res = await httpRequest(`http://127.0.0.1:${port}/dom?t=${server.token}`, { method: 'POST' }, { dom: `Item ${i}` });
    assert.equal(res.status, 200);
  }

  // 121st request should be rate-limited
  const limitedRes = await httpRequest(`http://127.0.0.1:${port}/dom?t=${server.token}`, { method: 'POST' }, { dom: 'Over limit' });
  assert.equal(limitedRes.status, 429);
  assert.equal(limitedRes.json.error, 'rate_limited');
});

test('5. Body cap (>500k bytes -> 413) and text truncation to 25k chars', async (t) => {
  const dir = createTempDir(t);
  const server = createCompanionServer({
    userDataDir: dir,
    safeStorage: mockSafeStorage(),
    startPort: 4240,
    endPort: 4245
  });
  t.after(async () => { await server.stop(); });
  const port = await server.start();

  // Payload > 500,000 bytes
  const largePayload = JSON.stringify({ dom: 'x'.repeat(510000) });
  const largeRes = await httpRequest(`http://127.0.0.1:${port}/dom?t=${server.token}`, { method: 'POST' }, largePayload);
  assert.equal(largeRes.status, 413);

  // Payload with 30,000 chars (under 500k bytes) truncated to 25,000 chars
  const text30k = 'a'.repeat(30000);
  const res = await httpRequest(`http://127.0.0.1:${port}/dom?t=${server.token}`, { method: 'POST' }, { dom: text30k });
  assert.equal(res.status, 200);

  const captured = server.consumeCapturedContext();
  assert.ok(captured);
  assert.equal(captured.text.length, 25000);
});

test('6. Status contracts: 405 on GET /dom, OPTIONS CORS 204, 409 when no active session', async (t) => {
  let sessionActive = true;
  const dir = createTempDir(t);
  const server = createCompanionServer({
    userDataDir: dir,
    safeStorage: mockSafeStorage(),
    startPort: 4250,
    endPort: 4255,
    isSessionActive: () => sessionActive
  });
  t.after(async () => { await server.stop(); });
  const port = await server.start();

  // Method not allowed: GET /dom
  const getRes = await httpRequest(`http://127.0.0.1:${port}/dom?t=${server.token}`, { method: 'GET' });
  assert.equal(getRes.status, 405);

  // OPTIONS CORS 204
  const optionsRes = await httpRequest(`http://127.0.0.1:${port}/dom`, {
    method: 'OPTIONS',
    headers: { origin: `chrome-extension://${DEFAULT_EXTENSION_ID}` }
  });
  assert.equal(optionsRes.status, 204);

  // 409 Conflict when session not active
  sessionActive = false;
  const inactiveRes = await httpRequest(`http://127.0.0.1:${port}/dom?t=${server.token}`, { method: 'POST' }, { dom: 'Background text' });
  assert.equal(inactiveRes.status, 409);
  assert.equal(inactiveRes.json.error, 'no_active_session');
});

test('7. Secrets stripping: redacts API keys, JWTs, private keys, passwords, bearer tokens', (t) => {
  const rawText = `
    Here is an API key: sk-abcdef1234567890abcdef1234567890
    Here is Google key: AIzaSyD98765432101234567890123456789012
    Here is GitHub token: ghp_1234567890abcdefghijklmnopqrstuvwx
    Here is JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jV_ExampleSignatureHere123
    Here is private key:
    -----BEGIN RSA PRIVATE KEY-----
    MIIEowIBAAKCAQEA0Y...
    -----END RSA PRIVATE KEY-----
    Here is password: password = SecretPassword123!
    Here is Bearer: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
  `;
  const sanitized = redactSecrets(rawText);
  assert.ok(!sanitized.includes('sk-abcdef1234567890abcdef1234567890'));
  assert.ok(!sanitized.includes('AIzaSyD98765432101234567890123456789012'));
  assert.ok(!sanitized.includes('ghp_1234567890abcdefghijklmnopqrstuvwx'));
  assert.ok(!sanitized.includes('MIIEowIBAAKCAQEA0Y'));
  assert.ok(!sanitized.includes('SecretPassword123!'));
  assert.ok(sanitized.includes('[REDACTED]'));
});

test('8. Single-use consumption (read-and-clear via consumeCapturedContext)', async (t) => {
  const dir = createTempDir(t);
  const server = createCompanionServer({
    userDataDir: dir,
    safeStorage: mockSafeStorage(),
    startPort: 4260,
    endPort: 4265
  });
  t.after(async () => { await server.stop(); });
  const port = await server.start();

  await httpRequest(`http://127.0.0.1:${port}/dom?t=${server.token}`, { method: 'POST' }, {
    dom: 'Article headline and paragraphs',
    meta: { title: 'TechCrunch Article', url: 'https://techcrunch.com/sample' }
  });

  assert.equal(server.getLastCapturedTitle(), 'TechCrunch Article');

  // First consumption: returns captured data
  const first = server.consumeCapturedContext();
  assert.ok(first);
  assert.equal(first.title, 'TechCrunch Article');
  assert.equal(first.text, 'Article headline and paragraphs');

  // Second consumption: null (cleared after first use)
  const second = server.consumeCapturedContext();
  assert.equal(second, null);
});

test('9. WebSocket desktop-pull capture hotkey dispatch', async (t) => {
  const dir = createTempDir(t);
  const server = createCompanionServer({
    userDataDir: dir,
    safeStorage: mockSafeStorage(),
    startPort: 4270,
    endPort: 4275
  });
  t.after(async () => { await server.stop(); });
  const port = await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${server.token}`);
  await new Promise((resolve) => ws.once('open', resolve));

  const received = [];
  ws.on('message', (data) => {
    received.push(JSON.parse(data.toString('utf8')));
  });

  const res = server.requestDesktopCapture();
  assert.equal(res.ok, true);
  assert.equal(res.sentCount, 1);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'capture-dom');
  assert.equal(received[0].reqId, res.reqId);

  ws.close();
});
