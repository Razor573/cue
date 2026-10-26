'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { StealthKeyboardManager } = require('../src/stealth-keyboard');

test('Unit 1: StealthKeyboardManager exports and lifecycle', async (t) => {
  await t.test('instantiates with window getter', () => {
    const manager = new StealthKeyboardManager(() => null);
    assert.equal(typeof manager.isAvailable, 'function');
    assert.equal(typeof manager.isActive, 'function');
    assert.equal(typeof manager.start, 'function');
    assert.equal(typeof manager.stop, 'function');
    assert.equal(manager.isActive(), false);
  });

  await t.test('detects Windows platform availability', () => {
    const manager = new StealthKeyboardManager(() => null);
    if (process.platform === 'win32') {
      assert.equal(manager.isAvailable(), true);
      assert.equal(manager.getLastError(), null);
    }
  });

  await t.test('handles non-Windows platforms gracefully', () => {
    const manager = new StealthKeyboardManager(() => null, { platform: 'darwin' });
    assert.equal(manager.isAvailable(), false);
    assert.match(manager.getLastError(), /Windows/i);
    assert.equal(manager.start(), false);
    assert.equal(manager.stop(), false);
  });

  await t.test('handles missing addon path gracefully', () => {
    const manager = new StealthKeyboardManager(() => null, {
      platform: 'win32',
      addonPath: path.join(__dirname, 'nonexistent', 'stealth.node')
    });
    assert.equal(manager.isAvailable(), false);
    assert.match(manager.getLastError(), /Cannot find module|not found|Failed to load/i);
  });

  await t.test('dispatches key events via mock addon', () => {
    let hookCb = null;
    let stopped = false;
    const mockAddon = {
      startTyping: (cb) => { hookCb = cb; return true; },
      stopTyping: () => { stopped = true; return true; }
    };

    const dispatched = [];
    const mockWin = {
      isDestroyed: () => false,
      webContents: {
        send: (channel, data) => dispatched.push({ channel, data })
      }
    };

    const manager = new StealthKeyboardManager(() => mockWin, { addon: mockAddon, platform: 'win32' });
    assert.equal(manager.isAvailable(), true);
    assert.equal(manager.isActive(), false);

    const started = manager.start();
    assert.equal(started, true);
    assert.equal(manager.isActive(), true);

    // Call hook with keystroke events
    hookCb({ kind: 'char', char: 'a' });
    hookCb({ kind: 'backspace' });
    hookCb({ kind: 'enter' });
    hookCb({ kind: 'escape' });

    assert.equal(dispatched.length, 4);
    assert.deepEqual(dispatched[0], { channel: 'stealth-key', data: { kind: 'char', char: 'a' } });
    assert.deepEqual(dispatched[1], { channel: 'stealth-key', data: { kind: 'backspace' } });
    assert.deepEqual(dispatched[2], { channel: 'stealth-key', data: { kind: 'enter' } });
    assert.deepEqual(dispatched[3], { channel: 'stealth-key', data: { kind: 'escape' } });

    const stopResult = manager.stop();
    assert.equal(stopResult, true);
    assert.equal(stopped, true);
    assert.equal(manager.isActive(), false);
  });
});

test('Unit 1: Preload bridge exposes methods and allows channels', () => {
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

  // Verify exposed methods on window.cue
  const requiredMethods = [
    'startStealthTyping',
    'stopStealthTyping',
    'enableSafeClickThrough',
    'restoreInteractiveMode',
    'toggleInteractiveMode',
    'attachFiles',
    'removeLastAttachedFile',
    'checkUpdate',
    'abort'
  ];
  for (const method of requiredMethods) {
    assert.ok(
      preloadSrc.includes(`${method}:`),
      `preload.js must expose ${method}`
    );
  }

  // Verify allowed channels in cue.on
  const requiredChannels = [
    'stealth-key',
    'toggle-ask-input',
    'open-settings',
    'settings-unlock',
    'reset-view',
    'response:scroll',
    'code:scroll',
    'history:nav',
    'transparency:toggle',
    'interactive:state',
    'attached-files',
    'emergency:recover'
  ];
  for (const ch of requiredChannels) {
    assert.ok(
      preloadSrc.includes(`'${ch}'`),
      `preload.js allowed channels must include '${ch}'`
    );
  }
});

test('Unit 2: main.js registers all Phantom Lens global shortcuts and IPC handlers', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  // Verify globalShortcut.register combinations
  const requiredShortcuts = [
    'CommandOrControl+Enter',
    'CommandOrControl+Shift+Enter',
    'CommandOrControl+Shift+Alt+M',
    'CommandOrControl+K',
    'CommandOrControl+R',
    'CommandOrControl+,',
    'CommandOrControl+Shift+,',
    'Alt+Up',
    'Alt+Down',
    'Alt+Left',
    'Alt+Right',
    'CommandOrControl+Shift+Up',
    'CommandOrControl+Shift+Down',
    'CommandOrControl+Left',
    'CommandOrControl+Right',
    'CommandOrControl+Up',
    'CommandOrControl+Down',
    'CommandOrControl+Shift+]',
    'CommandOrControl+Shift+[',
    'CommandOrControl+Shift+V',
    'CommandOrControl+O',
    'CommandOrControl+Shift+O',
    'CommandOrControl+Shift+R',
    'CommandOrControl+Q',
    'CommandOrControl+Shift+Alt+Left',
    'CommandOrControl+Shift+Alt+Right',
    'CommandOrControl+Shift+Alt+T',
    'CommandOrControl+Shift+Alt+A',
    'CommandOrControl+Shift+Alt+S',
    'CommandOrControl+\\\\'
  ];

  for (const shortcut of requiredShortcuts) {
    assert.ok(
      mainSrc.includes(`globalShortcut.register('${shortcut}'`),
      `main.js must register shortcut ${shortcut}`
    );
  }

  // Verify IPC handlers
  const requiredIpc = [
    'mouse:click-through-enable',
    'mouse:interactive-restore',
    'mouse:interactive-toggle',
    'stealth:start',
    'stealth:stop',
    'files:attach-dialog',
    'files:remove-last',
    'app:update-check',
    'llm:abort'
  ];
  for (const ipc of requiredIpc) {
    assert.ok(
      mainSrc.includes(`'${ipc}'`),
      `main.js must handle IPC ${ipc}`
    );
  }

  // Verify pass-through mechanics
  assert.match(mainSrc, /interactiveOverride\s*=\s*false/);
  assert.match(mainSrc, /applyInteractivityState\(\)/);
  assert.match(mainSrc, /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/);
});

test('Unit 3: Renderer HTML, CSS, and renderer.js wire pass-through & stealth typing', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

  // DOM elements in HTML
  assert.ok(html.includes('id="interactive-pill"'), 'index.html must have #interactive-pill');
  assert.ok(html.includes('id="stealth-typing-badge"'), 'index.html must have #stealth-typing-badge');
  assert.ok(html.includes('id="attached-files-bar"'), 'index.html must have #attached-files-bar');
  assert.ok(html.includes('id="settings-unlock-banner"'), 'index.html must have #settings-unlock-banner');
  assert.ok(html.includes('data-tab="hotkeys"'), 'index.html must have Hotkeys tab button');
  assert.ok(html.includes('data-pane="hotkeys"'), 'index.html must have Hotkeys pane');

  // CSS classes in styles.css
  assert.ok(css.includes('.interactive-pill'), 'styles.css must style .interactive-pill');
  assert.ok(css.includes('.stealth-typing-badge'), 'styles.css must style .stealth-typing-badge');
  assert.ok(css.includes('.attached-files-bar'), 'styles.css must style .attached-files-bar');
  assert.ok(css.includes('.ultra-transparent'), 'styles.css must style .ultra-transparent');
  assert.ok(css.includes('.settings-unlock-banner'), 'styles.css must style .settings-unlock-banner');
  assert.ok(css.includes('.hotkeys-grid'), 'styles.css must style .hotkeys-grid');

  // Event handlers in renderer.js
  const events = [
    'interactive:state',
    'toggle-ask-input',
    'stealth-key',
    'open-settings',
    'settings-unlock',
    'reset-view',
    'response:scroll',
    'code:scroll',
    'history:nav',
    'transparency:toggle',
    'attached-files',
    'emergency:recover'
  ];
  for (const ev of events) {
    assert.ok(
      js.includes(`cue.on('${ev}'`),
      `renderer.js must listen for cue.on('${ev}')`
    );
  }

  // Verify closeSettings restores pass-through mode
  assert.match(js, /enableSafeClickThrough/);
});
