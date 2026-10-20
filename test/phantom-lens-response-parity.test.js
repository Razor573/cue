'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { sanitizeLatex, renderMarkdown } = require('../renderer/renderer');

test('Unit 1: sanitizeLatex LaTeX-to-Unicode conversion', async (t) => {
  await t.test('handles basic math expressions and symbols', () => {
    const input = 'The solution is $\\sqrt{16} = 4$ and fraction $\\frac{1}{2}$.';
    const output = sanitizeLatex(input);
    assert.equal(output.includes('√16 = 4'), true, `Expected √16 = 4, got: ${output}`);
    assert.equal(output.includes('1/2'), true, `Expected 1/2, got: ${output}`);
    assert.equal(output.includes('\\sqrt'), false, 'LaTeX \\sqrt should be sanitized');
    assert.equal(output.includes('\\frac'), false, 'LaTeX \\frac should be sanitized');
  });

  await t.test('handles display math blocks ($$ ... $$) and inequalities', () => {
    const input = 'Expression: $$\\alpha \\times \\beta \\leq \\gamma \\neq \\delta \\approx \\epsilon \\pm 1$$';
    const output = sanitizeLatex(input);
    assert.equal(output.includes('×'), true, 'Expected × symbol');
    assert.equal(output.includes('≤'), true, 'Expected ≤ symbol');
    assert.equal(output.includes('≠'), true, 'Expected ≠ symbol');
    assert.equal(output.includes('≈'), true, 'Expected ≈ symbol');
    assert.equal(output.includes('±'), true, 'Expected ± symbol');
    assert.equal(output.includes('$$'), false, 'Delimiters should be stripped');
  });

  await t.test('replaces text wrapper commands and common LaTeX commands', () => {
    const input = 'We have \\text{total} \\rightarrow \\infty and \\textbf{bold} \\textit{italic}.';
    const output = sanitizeLatex(input);
    assert.equal(output.includes('total → ∞ and bold italic.'), true, `Got: ${output}`);
  });

  await t.test('preserves escaped currency signs and plain text', () => {
    const input = 'Price is \\$100 and plain text remains completely untouched.';
    const output = sanitizeLatex(input);
    assert.equal(output.includes('$100'), true, `Expected $100, got: ${output}`);
    assert.equal(output.includes('plain text remains completely untouched.'), true);
  });
});

test('Unit 2: renderMarkdown markdown parsing and formatting', async (t) => {
  await t.test('normalizes broken heading prefix (e.g. xplanation:)', () => {
    const input = 'xplanation: Here is why the answer is correct.';
    const output = renderMarkdown(input);
    assert.equal(output.includes('<strong>Explanation:</strong>'), true, `Expected normalized explanation heading, got: ${output}`);
  });

  await t.test('renders numbered lists with .response-ol class', () => {
    const input = '1. First step\n2. Second step\n3. Third step';
    const output = renderMarkdown(input);
    assert.equal(output.includes('<ol class="response-ol">'), true, `Expected response-ol, got: ${output}`);
    assert.equal(output.includes('<li>First step</li>'), true);
    assert.equal(output.includes('<li>Second step</li>'), true);
    assert.equal(output.includes('<li>Third step</li>'), true);
    assert.equal(output.includes('</ol>'), true);
  });

  await t.test('renders bullet lists with .response-ul class', () => {
    const input = '- Item A\n* Item B\n- Item C';
    const output = renderMarkdown(input);
    assert.equal(output.includes('<ul class="response-ul">'), true, `Expected response-ul, got: ${output}`);
    assert.equal(output.includes('<li>Item A</li>'), true);
    assert.equal(output.includes('<li>Item B</li>'), true);
    assert.equal(output.includes('<li>Item C</li>'), true);
    assert.equal(output.includes('</ul>'), true);
  });

  await t.test('renders headings (#, ##, ###)', () => {
    const input = '# Heading 1\n## Heading 2\n### Heading 3';
    const output = renderMarkdown(input);
    assert.equal(output.includes('<h1>Heading 1</h1>'), true);
    assert.equal(output.includes('<h2>Heading 2</h2>'), true);
    assert.equal(output.includes('<h3>Heading 3</h3>'), true);
  });

  await t.test('renders fenced code blocks into pre code elements', () => {
    const input = '```javascript\nconst sum = (a, b) => a + b;\n```';
    const output = renderMarkdown(input);
    assert.equal(output.includes('<pre><code>'), true);
    assert.equal(output.includes('const sum = (a, b) =&gt; a + b;'), true);
    assert.equal(output.includes('</code></pre>'), true);
  });

  await t.test('renders inline code and bold styling', () => {
    const input = 'Use `Array.prototype.map()` for **immutable** transformation.';
    const output = renderMarkdown(input);
    assert.equal(output.includes('<code>Array.prototype.map()</code>'), true);
    assert.equal(output.includes('<strong>immutable</strong>'), true);
  });
});

test('Unit 3: Answer token capacity caps in src/llm.js & src/vertex-ai.js', () => {
  const llmSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'llm.js'), 'utf8');
  assert.match(
    llmSrc,
    /maxTokens\s*=\s*settings\.smart\s*\?\s*12288\s*:\s*8192/,
    'src/llm.js must set maxTokens to 12288 for smart and 8192 for fast'
  );

  const vertexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'vertex-ai.js'), 'utf8');
  assert.match(
    vertexSrc,
    /maxTokens\s*=\s*8192/,
    'src/vertex-ai.js must default maxTokens to 8192'
  );
  assert.match(
    vertexSrc,
    /maxOutputTokens:\s*Math\.max\(16,\s*Number\(maxTokens\)\s*\|\|\s*8192\)/,
    'src/vertex-ai.js must use 8192 fallback in generationConfig'
  );
});

test('Unit 4: Inactivity watchdog timeout in main.js', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(
    mainSrc,
    /const STREAM_INACTIVITY_MS\s*=\s*20000;/,
    'main.js must define STREAM_INACTIVITY_MS as 20000 (20s inactivity watchdog)'
  );
  assert.match(
    mainSrc,
    /the model stopped responding \(timed out\)\. Please try again\./,
    'main.js watchdog must reject with standard timeout message'
  );
  assert.match(
    mainSrc,
    /onThought:\s*\(thoughtText\)\s*=>\s*\{[\s\S]*?rearm\(\);[\s\S]*?send\('llm:thought'/,
    'main.js must re-arm inactivity timer on every thought chunk'
  );
  assert.match(
    mainSrc,
    /onToken:\s*\(t\)\s*=>\s*\{[\s\S]*?rearm\(\);[\s\S]*?send\('llm:token'/,
    'main.js must re-arm inactivity timer on every token chunk'
  );
});

test('Unit 5: Session directive detection and context injection in main.js', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  // Verify directive match regex
  const regexMatch = mainSrc.match(/const directiveMatch = \(userText \|\| ''\)\.match\((\/.*?\/i)\);/);
  assert.ok(regexMatch, 'directiveMatch regex must be present in main.js');
  const directiveRe = new RegExp(/^(in this (assessment|interview|test|exam)|for this session|always|from now on|never|format:|remember:|give me .+ and .+ for all questions)/i);

  // Test various directive patterns
  const validDirectives = [
    'in this assessment give me best and second best',
    'in this interview be concise',
    'for this session explain step by step',
    'always include time complexity',
    'from now on avoid pseudocode',
    'never explain obvious syntax',
    'format: bullet points only',
    'remember: write typescript',
    'give me pros and cons for all questions'
  ];

  for (const d of validDirectives) {
    assert.ok(directiveRe.test(d), `Regex should match directive: "${d}"`);
  }

  // Non-directives should not trigger
  const nonDirectives = [
    'How do I reverse a binary tree?',
    'Write a quicksort in JavaScript',
    'What is the difference between TCP and UDP?'
  ];

  for (const nd of nonDirectives) {
    assert.equal(directiveRe.test(nd), false, `Regex should not match: "${nd}"`);
  }

  // Verify session:directive event emission and context injection
  assert.match(mainSrc, /send\('session:directive'/);
  assert.match(mainSrc, /ACTIVE SESSION DIRECTIVES \(MUST FOLLOW FOR ALL RESPONSES\):/);
  assert.match(mainSrc, /sessionDirectives\.map/);
});

test('Unit 6: ThinkingIndicator, discrete response history, and ramped scroll parity in renderer', () => {
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

  // ThinkingIndicator
  assert.match(rendererSrc, /class="thinking-placeholder"/);
  assert.match(rendererSrc, /Analyzing screen context and formulating solution\.\.\./);
  assert.match(rendererSrc, /Thinking… \(\${thinkingElapsed}s\)/);
  assert.match(rendererSrc, /Thought for \${thinkingElapsed}s/);

  // Ramped scroll
  assert.match(rendererSrc, /function rampedScroll\(el, dx, dy\)/);
  assert.match(rendererSrc, /scrollVelocity\.mult\s*=\s*Math\.min\(scrollVelocity\.mult\s*\*\s*1\.4,\s*8\)/);
  assert.match(rendererSrc, /behavior:\s*'auto'/);

  // Discrete response history navigation
  assert.match(rendererSrc, /responseHistory\s*=\s*\[\]/);
  assert.match(rendererSrc, /historyIndex/);
  assert.match(rendererSrc, /renderHistoryItem/);
  assert.match(rendererSrc, /updateHistoryPill/);

  // HTML elements
  assert.ok(htmlSrc.includes('id="history-pill"'), 'index.html must have #history-pill');
  assert.ok(htmlSrc.includes('id="directive-badge"'), 'index.html must have #directive-badge');

  // CSS classes
  assert.ok(cssSrc.includes('.thinking-placeholder'), 'styles.css must have .thinking-placeholder');
  assert.ok(cssSrc.includes('.response-ol'), 'styles.css must have .response-ol');
  assert.ok(cssSrc.includes('.response-ul'), 'styles.css must have .response-ul');
  assert.ok(cssSrc.includes('.history-pill'), 'styles.css must have .history-pill');
  assert.ok(cssSrc.includes('.directive-badge'), 'styles.css must have .directive-badge');
});
