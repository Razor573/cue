const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULTS, MAX_AI_RULES_CHARS: STORE_MAX_AI_RULES } = require('../src/store');
const { MAX_AI_RULES_CHARS } = require('../src/profile-context');
const { geminiGenerationConfig, MODES, PHANTOM_LENS_DIRECTIVES } = require('../src/prompts') ? {
  ...require('../src/llm'),
  ...require('../src/prompts')
} : {};

test('Unit 1: store & profile context configuration limits', () => {
  assert.equal(DEFAULTS.geminiThinkingLevel, 'LOW');
  assert.equal(DEFAULTS.geminiWebSearch, false);
  assert.equal(STORE_MAX_AI_RULES, 1_000_000);
  assert.equal(MAX_AI_RULES_CHARS, 1_000_000, 'AI rules character cap must be at least 1,000,000');
});

test('Unit 2: Gemini thinking configuration & tool grounding', () => {
  // Low tier thinking
  const cfgLow = geminiGenerationConfig({ system: 'test-system', maxTokens: 500, thinkingLevel: 'LOW' });
  assert.deepEqual(cfgLow.thinkingConfig, { thinkingLevel: 'low' });

  // Medium tier thinking with search grounding
  const cfgMed = geminiGenerationConfig({ system: 'test-system', maxTokens: 500, thinkingLevel: 'MEDIUM', webSearch: true });
  assert.deepEqual(cfgMed.thinkingConfig, { thinkingLevel: 'medium' });
  assert.deepEqual(cfgMed.tools, [{ googleSearch: {} }]);

  // High tier thinking with includeThoughts flag
  const cfgHigh = geminiGenerationConfig({ system: 'test-system', maxTokens: 500, thinkingLevel: 'HIGH', includeThoughts: true });
  assert.deepEqual(cfgHigh.thinkingConfig, { thinkingLevel: 'high', includeThoughts: true });
});

test('Unit 3: Phantom Lens prompt structure & strict readability rules in prompts.js', () => {
  assert.ok(PHANTOM_LENS_DIRECTIVES, 'PHANTOM_LENS_DIRECTIVES must be exported from prompts.js');
  assert.match(PHANTOM_LENS_DIRECTIVES, /COMPREHENSIVE REASONING & RIGOROUS VERIFICATION DIRECTIVES/);
  assert.match(PHANTOM_LENS_DIRECTIVES, /1\. \*\*Question:\*\*/);
  assert.match(PHANTOM_LENS_DIRECTIVES, /2\. \*\*Answer:\*\*/);
  assert.match(PHANTOM_LENS_DIRECTIVES, /3\. \*\*Explanation:\*\*/);
  assert.match(PHANTOM_LENS_DIRECTIVES, /STRICT READABILITY & FORMATTING RULES/);
  assert.match(PHANTOM_LENS_DIRECTIVES, /plain Unicode text/);
  assert.match(PHANTOM_LENS_DIRECTIVES, /DOMAIN ADAPTATION/);

  // Look & Ask modes include the directives
  const lookPrompt = MODES.look.buildSystem(null);
  assert.match(lookPrompt, /1\. \*\*Question:\*\*/);
  assert.match(lookPrompt, /2\. \*\*Answer:\*\*/);

  const askPrompt = MODES.ask.buildSystem(null);
  assert.match(askPrompt, /1\. \*\*Question:\*\*/);
  assert.match(askPrompt, /2\. \*\*Answer:\*\*/);
});

test('Unit 4: Renderer HTML and CSS structure for Settings, Gemini, and Thinking', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer/styles.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer/renderer.js'), 'utf8');

  // Gemini and Vertex AI first in providers segment
  const providerSegIdx = html.indexOf('id="provider-seg"');
  assert.ok(providerSegIdx > -1, 'provider-seg not found in html');
  const segSub = html.slice(providerSegIdx, providerSegIdx + 500);
  const geminiIdx = segSub.indexOf('data-provider="gemini"');
  const vertexIdx = segSub.indexOf('data-provider="vertex"');
  const anthropicIdx = segSub.indexOf('data-provider="anthropic"');
  assert.ok(geminiIdx > -1 && vertexIdx > -1 && anthropicIdx > -1);
  assert.ok(geminiIdx < anthropicIdx, 'Gemini should precede Anthropic');
  assert.ok(vertexIdx < anthropicIdx, 'Vertex AI should precede Anthropic');

  // Gemini row controls
  assert.ok(html.includes('id="gemini-row"'), 'gemini-row element must exist');
  assert.ok(html.includes('id="gemini-thinking"'), 'gemini-thinking element must exist');
  assert.ok(html.includes('id="gemini-web-search"'), 'gemini-web-search element must exist');

  // Gemini STT provider option
  assert.ok(html.includes('data-stt-provider="gemini"'), 'Gemini STT provider button must exist');

  // Whisper health test button
  assert.ok(html.includes('id="whisper-test-btn"'), 'whisper-test-btn must exist');
  assert.ok(html.includes('id="whisper-test-status"'), 'whisper-test-status must exist');

  // Appearance tab removed
  assert.ok(!html.includes('data-tab="appearance"'), 'appearance tab must be removed');
  assert.ok(!html.includes('data-pane="appearance"'), 'appearance pane must be removed');

  // Settings scrim blur box removed (transparent)
  assert.match(css, /#settings-scrim\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?backdrop-filter:\s*none;/);

  // Thinking card styling exists
  assert.ok(css.includes('.thinking-card'), 'thinking-card styles must exist in CSS');

  // Settings tab pane scrollable
  assert.match(css, /\.s-tab-pane\s*\{[\s\S]*?overflow-y:\s*auto\s*!important;/);

  // In-flight request cancellation on second call
  assert.match(renderer, /finalizeCurrentResponse\(true\)/);

  // Settings toggle
  assert.match(renderer, /cue\.on\('open-settings',\s*\(\)\s*=>\s*\{[\s\S]*?closeSettings\(\)[\s\S]*?openSettings\(\)/);

  // Settings scroll on Alt+Up/Down
  assert.match(renderer, /cue\.on\('response:scroll',[\s\S]*?\.s-tab-pane:not\(\.hidden\)/);
});

test('Unit 5: Main process in-flight cancellation & Whisper test handler', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  // activeFeatureAbort controller
  assert.match(mainSrc, /activeFeatureAbort\.abort\(\)/);
  assert.match(mainSrc, /activeFeatureAbort\s*=\s*new AbortController\(\)/);

  // whisper test handler
  assert.match(mainSrc, /ipcMain\.handle\('whisper:test-model'/);

  // Meeting companion hotkey
  assert.match(mainSrc, /CommandOrControl\+Shift\+M/);
  assert.match(mainSrc, /openMeetingWindow\(\)/);
});
