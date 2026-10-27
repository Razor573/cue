const fs = require('fs');
const path = require('path');

const FILE_MODE = 0o600;
const OAUTH_STORAGE_FILENAME = 'cue-oauth-tokens.enc';
const SAFE_STORAGE_UNAVAILABLE_MESSAGE =
  'Electron safeStorage encryption is unavailable on this system. Sign-in refused to avoid storing plaintext OAuth tokens.';

let defaultOverride = null;

function resolveElectronSafeStorage() {
  if (defaultOverride && 'safeStorage' in defaultOverride) {
    return defaultOverride.safeStorage;
  }
  try {
    const electron = require('electron');
    return (electron && electron.safeStorage) || null;
  } catch {
    return null;
  }
}

function resolveDefaultStoragePath() {
  if (defaultOverride && typeof defaultOverride.getStoragePath === 'function') {
    return defaultOverride.getStoragePath();
  }
  if (defaultOverride && typeof defaultOverride.storagePath === 'string') {
    return defaultOverride.storagePath;
  }
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), OAUTH_STORAGE_FILENAME);
    }
  } catch {
    // Plain Node environment outside Electron
  }
  throw new Error('Cannot resolve userData path for OAuth token storage outside Electron without an explicit storagePath.');
}

function isSafeStorageAvailable(opts = {}) {
  const ss = opts && 'safeStorage' in opts ? opts.safeStorage : resolveElectronSafeStorage();
  if (!ss || typeof ss.isEncryptionAvailable !== 'function') return false;
  try {
    return Boolean(ss.isEncryptionAvailable());
  } catch {
    return false;
  }
}

function assertSafeStorageAvailable(safeStorage) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    const err = new Error(SAFE_STORAGE_UNAVAILABLE_MESSAGE);
    err.code = 'SAFE_STORAGE_UNAVAILABLE';
    throw err;
  }
}

function chmodQuiet(target) {
  try {
    fs.chmodSync(target, FILE_MODE);
  } catch {
    // Windows ACLs handle user isolation when chmod is a no-op
  }
}

function readEnvelope(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
      return { version: 1, providers: { ...parsed.providers } };
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      console.error('[cue] unable to read encrypted OAuth store');
    }
  }
  return { version: 1, providers: {} };
}

function writeEnvelopeAtomic(filePath, envelope) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(envelope, null, 2);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, json, { mode: FILE_MODE });
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.writeFileSync(filePath, json, { mode: FILE_MODE });
    try { fs.unlinkSync(tmpPath); } catch {}
  }
  chmodQuiet(filePath);
}

function createOAuthStorage(options = {}) {
  const getSafeStorage = () => ('safeStorage' in options ? options.safeStorage : resolveElectronSafeStorage());
  const getPath = () => {
    if (typeof options.getStoragePath === 'function') return options.getStoragePath();
    if (typeof options.storagePath === 'string' && options.storagePath) return options.storagePath;
    return resolveDefaultStoragePath();
  };

  function getProviderTokens(provider) {
    const key = String(provider || '').trim();
    if (!key) return null;
    let filePath;
    try {
      filePath = getPath();
    } catch {
      return null;
    }
    if (!fs.existsSync(filePath)) return null;
    const ss = getSafeStorage();
    if (!ss || typeof ss.isEncryptionAvailable !== 'function' || !ss.isEncryptionAvailable()) {
      return null;
    }
    const envelope = readEnvelope(filePath);
    const cipherB64 = envelope.providers[key];
    if (typeof cipherB64 !== 'string' || !cipherB64) return null;
    try {
      const buf = Buffer.from(cipherB64, 'base64');
      const plaintext = ss.decryptString(buf);
      const parsed = JSON.parse(plaintext);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function setProviderTokens(provider, bundle) {
    const key = String(provider || '').trim();
    if (!key) throw new Error('Provider name is required to store OAuth tokens.');
    if (!bundle || typeof bundle !== 'object') throw new Error('Token bundle must be an object.');
    const ss = getSafeStorage();
    assertSafeStorageAvailable(ss);
    const filePath = getPath();
    const serialized = JSON.stringify(bundle);
    const encrypted = ss.encryptString(serialized);
    const cipherB64 = Buffer.isBuffer(encrypted)
      ? encrypted.toString('base64')
      : Buffer.from(String(encrypted), 'utf8').toString('base64');
    const envelope = readEnvelope(filePath);
    envelope.providers[key] = cipherB64;
    writeEnvelopeAtomic(filePath, envelope);
    return true;
  }

  function deleteProviderTokens(provider) {
    const key = String(provider || '').trim();
    if (!key) return false;
    let filePath;
    try {
      filePath = getPath();
    } catch {
      return false;
    }
    if (!fs.existsSync(filePath)) return true;
    const envelope = readEnvelope(filePath);
    delete envelope.providers[key];
    const remaining = Object.keys(envelope.providers);
    if (remaining.length === 0) {
      try { fs.unlinkSync(filePath); } catch {}
      try { fs.unlinkSync(`${filePath}.tmp`); } catch {}
    } else {
      writeEnvelopeAtomic(filePath, envelope);
    }
    return true;
  }

  return {
    getProviderTokens,
    setProviderTokens,
    deleteProviderTokens,
    isSafeStorageAvailable: () => isSafeStorageAvailable({ safeStorage: getSafeStorage() }),
    getStoragePath: getPath
  };
}

function getProviderTokens(provider, opts = {}) {
  return createOAuthStorage(opts).getProviderTokens(provider);
}

function setProviderTokens(provider, bundle, opts = {}) {
  return createOAuthStorage(opts).setProviderTokens(provider, bundle);
}

function deleteProviderTokens(provider, opts = {}) {
  return createOAuthStorage(opts).deleteProviderTokens(provider);
}

function configureOAuthStorageForTest(override = null) {
  defaultOverride = override;
}

module.exports = {
  OAUTH_STORAGE_FILENAME,
  SAFE_STORAGE_UNAVAILABLE_MESSAGE,
  createOAuthStorage,
  isSafeStorageAvailable,
  assertSafeStorageAvailable,
  getProviderTokens,
  setProviderTokens,
  deleteProviderTokens,
  configureOAuthStorageForTest
};
