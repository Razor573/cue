'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('Unit 1: main.js disables Chromium background throttling for uninterrupted capture', () => {
  assert.match(
    mainSrc,
    /webPreferences:\s*\{[\s\S]*?backgroundThrottling:\s*false[\s\S]*?\}/,
    'winOptions.webPreferences must set backgroundThrottling: false'
  );
});

test('Unit 2: isOverlayVisible helper checks window presence and visibility', () => {
  assert.match(
    mainSrc,
    /function isOverlayVisible\(\)\s*\{[\s\S]*?win\.isVisible\(\)[\s\S]*?\}/,
    'isOverlayVisible() must be defined and check win.isVisible()'
  );
});

test('Unit 3: Shortcut split into visibility vs app feature sets', () => {
  assert.match(mainSrc, /function registerVisibilityShortcuts\(\)/, 'registerVisibilityShortcuts must exist');
  assert.match(mainSrc, /function registerAppShortcuts\(\)/, 'registerAppShortcuts must exist');
  assert.match(
    mainSrc,
    /function registerShortcuts\(\)\s*\{[\s\S]*?registerVisibilityShortcuts\(\);[\s\S]*?registerAppShortcuts\(\);[\s\S]*?\}/,
    'registerShortcuts must call both registerVisibilityShortcuts and registerAppShortcuts'
  );

  const visStart = mainSrc.indexOf('function registerVisibilityShortcuts()');
  assert.ok(visStart > -1, 'function registerVisibilityShortcuts() not found');
  const visEnd = mainSrc.indexOf('function registerAppShortcuts()', visStart);
  assert.ok(visEnd > -1, 'function registerAppShortcuts() not found');
  const visBody = mainSrc.slice(visStart, visEnd);

  assert.ok(visBody.includes("globalShortcut.register('CommandOrControl+\\\\', () => toggleOverlayVisibility())"));
  assert.ok(visBody.includes("globalShortcut.register('CommandOrControl+Shift+H', () => toggleOverlayVisibility())"));
  assert.ok(visBody.includes("globalShortcut.register('CommandOrControl+Shift+R', () => emergencyRecover())"));
});

test('Unit 4: unregisterAppShortcuts unregisters feature hotkeys to free them for other apps', () => {
  assert.match(mainSrc, /function unregisterAppShortcuts\(\)/, 'unregisterAppShortcuts must exist');
  const unregStart = mainSrc.indexOf('function unregisterAppShortcuts()');
  const unregEnd = mainSrc.indexOf('function registerShortcuts()', unregStart);
  const unregBody = mainSrc.slice(unregStart, unregEnd > -1 ? unregEnd : unregStart + 400);

  assert.match(unregBody, /globalShortcut\.unregister\(/, 'unregisterAppShortcuts must call globalShortcut.unregister');
  assert.match(unregBody, /appShortcutsRegistered\s*=\s*false/, 'unregisterAppShortcuts must set appShortcutsRegistered to false');
});

test('Unit 5: Window lifecycle hooks properly suppress shortcuts and stealth keyboard on hide', () => {
  const hideMatch = mainSrc.match(/win\.on\('hide',\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
  assert.ok(hideMatch, "win.on('hide') must be registered");
  assert.match(hideMatch[1], /stealthKeyboard\.stop\(\)/, "win.on('hide') must stop stealthKeyboard");
  assert.match(hideMatch[1], /unregisterAppShortcuts\(\)/, "win.on('hide') must call unregisterAppShortcuts()");

  const showMatch = mainSrc.match(/win\.on\('show',\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
  assert.ok(showMatch, "win.on('show') must be registered");
  assert.match(showMatch[1], /registerAppShortcuts\(\)/, "win.on('show') must call registerAppShortcuts()");

  const toggleStart = mainSrc.indexOf('function toggleOverlayVisibility()');
  const toggleEnd = mainSrc.indexOf('// Window dragging', toggleStart);
  const toggleBody = mainSrc.slice(toggleStart, toggleEnd);

  assert.match(toggleBody, /unregisterAppShortcuts\(\)/, 'toggleOverlayVisibility must unregister app shortcuts on hide');
  assert.match(toggleBody, /registerAppShortcuts\(\)/, 'toggleOverlayVisibility must register app shortcuts on show');
});

test('Unit 6: All app shortcut handlers defensively check window visibility', () => {
  const appStart = mainSrc.indexOf('function registerAppShortcuts()');
  const appEnd = mainSrc.indexOf('function unregisterAppShortcuts()');
  assert.ok(appStart > -1 && appEnd > -1);
  const appBody = mainSrc.slice(appStart, appEnd);

  const registerMatches = appBody.match(/globalShortcut\.register\(/g) || [];
  assert.ok(registerMatches.length >= 24, `Expected at least 24 registered shortcuts, found ${registerMatches.length}`);

  const guardMatches = appBody.match(/if\s*\(!isOverlayVisible\(\)\)\s*return;/g) || [];
  assert.equal(
    guardMatches.length,
    registerMatches.length,
    `Each of the ${registerMatches.length} app shortcut callbacks must start with if (!isOverlayVisible()) return;`
  );
});

test('Unit 7: Window hiding does not stop streaming STT, capture loops, or clear audio buffers', () => {
  const toggleStart = mainSrc.indexOf('function toggleOverlayVisibility()');
  const toggleEnd = mainSrc.indexOf('// Window dragging', toggleStart);
  const toggleBody = mainSrc.slice(toggleStart, toggleEnd);
  assert.doesNotMatch(toggleBody, /stopStreamingSTT/);
  assert.doesNotMatch(toggleBody, /setCapturing/);
  assert.doesNotMatch(toggleBody, /buffers/);

  const hideMatch = mainSrc.match(/win\.on\('hide',\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
  assert.ok(hideMatch);
  assert.doesNotMatch(hideMatch[1], /stopStreamingSTT/);
  assert.doesNotMatch(hideMatch[1], /setCapturing/);
  assert.doesNotMatch(hideMatch[1], /buffers/);
});
