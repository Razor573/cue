const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MAIN_PATH = path.join(__dirname, '..', 'main.js');
const MAIN_JS = fs.readFileSync(MAIN_PATH, 'utf8');

function extractEnsureContentProtection(src) {
  const match = src.match(/function ensureContentProtection\(targetWin = win\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'ensureContentProtection function definition must exist in main.js');
  return match[0];
}

function createRunner(isLinux = false, env = {}) {
  const fnCode = extractEnsureContentProtection(MAIN_JS);
  const sandbox = {
    isLinux,
    process: { env: { ...env } },
    console: { warn: () => {} },
    win: null
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fnCode}\nglobalThis.ensureContentProtection = ensureContentProtection;`, sandbox);
  return sandbox.ensureContentProtection;
}

test('ensureContentProtection ignores null or undefined targetWin', () => {
  const fn = createRunner(false, {});
  assert.doesNotThrow(() => fn(null));
  assert.doesNotThrow(() => fn(undefined));
});

test('ensureContentProtection ignores destroyed windows', () => {
  const fn = createRunner(false, {});
  let called = false;
  const mockWin = {
    isDestroyed: () => true,
    setContentProtection: () => { called = true; }
  };
  fn(mockWin);
  assert.equal(called, false, 'setContentProtection should not be called on destroyed window');
});

test('ensureContentProtection skips when CUE_NO_PROTECT is set', () => {
  const fn = createRunner(false, { CUE_NO_PROTECT: '1' });
  let called = false;
  const mockWin = {
    isDestroyed: () => false,
    setContentProtection: () => { called = true; }
  };
  fn(mockWin);
  assert.equal(called, false, 'setContentProtection should not be called when CUE_NO_PROTECT is set');
});

test('ensureContentProtection skips on Linux', () => {
  const fn = createRunner(true, {});
  let called = false;
  const mockWin = {
    isDestroyed: () => false,
    setContentProtection: () => { called = true; }
  };
  fn(mockWin);
  assert.equal(called, false, 'setContentProtection should not be called on Linux');
});

test('ensureContentProtection calls setContentProtection(true) on valid windows', () => {
  const fn = createRunner(false, {});
  let protectedArg = null;
  const mockWin = {
    isDestroyed: () => false,
    setContentProtection: (val) => { protectedArg = val; }
  };
  fn(mockWin);
  assert.equal(protectedArg, true, 'setContentProtection should be called with true');
});

test('ensureContentProtection swallows and logs error when setContentProtection throws', () => {
  const fn = createRunner(false, {});
  const mockWin = {
    isDestroyed: () => false,
    setContentProtection: () => { throw new Error('OS failure'); }
  };
  assert.doesNotThrow(() => fn(mockWin));
});

test('main.js does not contain WIN_IS_LOCAL_CONSOLE_SESSION', () => {
  assert.doesNotMatch(MAIN_JS, /\bWIN_IS_LOCAL_CONSOLE_SESSION\b/,
    'WIN_IS_LOCAL_CONSOLE_SESSION was an artificial guard that blocked protection');
});

test('main.js winOptions includes transparent background color', () => {
  assert.match(MAIN_JS, /backgroundColor:\s*'#00000000'/,
    'winOptions must define transparent background color (#00000000)');
});

test('main.js sets always-on-top level to floating instead of screen-saver', () => {
  assert.match(MAIN_JS, /setAlwaysOnTop\(\s*true,\s*'floating'\s*\)/,
    'Window must use floating always-on-top level for phantom-lens parity');
  assert.doesNotMatch(MAIN_JS, /setAlwaysOnTop\(\s*true,\s*'screen-saver'/,
    'screen-saver z-band should not be used');
});

test('main.js re-asserts content protection on lifecycle and visibility events', () => {
  assert.match(MAIN_JS, /win\.webContents\.on\('did-finish-load',\s*\(\)\s*=>\s*\{[\s\S]*?ensureContentProtection\(win\)/,
    'win did-finish-load must call ensureContentProtection(win)');
  assert.match(MAIN_JS, /win\.on\('show',\s*\(\)\s*=>\s*\{[\s\S]*?ensureContentProtection\(win\)/,
    'win on show must call ensureContentProtection(win)');
  assert.match(MAIN_JS, /win\.on\('focus',\s*\(\)\s*=>\s*\{[\s\S]*?ensureContentProtection\(win\)/,
    'win on focus must call ensureContentProtection(win)');
  assert.match(MAIN_JS, /function\s+toggleOverlayVisibility\(\)\s*\{[\s\S]*?ensureContentProtection\(win\)/,
    'toggleOverlayVisibility must call ensureContentProtection(win) when showing');
  assert.match(MAIN_JS, /function\s+emergencyRecover\(\)\s*\{[\s\S]*?ensureContentProtection\(win\)/,
    'emergencyRecover must call ensureContentProtection(win)');
});

test('main.js applies floating and content protection to permissions window', () => {
  assert.match(MAIN_JS, /permWin\.setAlwaysOnTop\(\s*true,\s*'floating'\s*\)/,
    'permWin must use floating always-on-top level');
  assert.match(MAIN_JS, /ensureContentProtection\(permWin\)/,
    'permWin must have content protection applied');
  assert.match(MAIN_JS, /permWin\.webContents\.on\('did-finish-load',\s*\(\)\s*=>\s*\{[\s\S]*?ensureContentProtection\(permWin\)/,
    'permWin did-finish-load must re-assert content protection');
});
