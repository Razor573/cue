const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DOM_CONTEXT_MAX_CHARS,
  PLATFORM_STATEMENTS,
  extractPageContent,
  extractContent,
  extractCodeBlocks,
  extractEditorCode,
  headingOutline,
  platformStatement,
  blockText,
} = require('../companion-extension/content-script');

// Minimal DOM builder for Node unit tests without requiring jsdom
function el(tag, attrs = {}, children = []) {
  const node = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    attributes: { ...attrs },
    className: attrs.class || '',
    id: attrs.id || '',
    parentNode: null,
    childNodes: [],
    get textContent() {
      return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join('');
    },
    cloneNode(deep = true) {
      if (!deep) return el(tag, attrs, []);
      return el(
        tag,
        attrs,
        this.childNodes.map((c) => (c.cloneNode ? c.cloneNode(true) : { ...c }))
      );
    },
    closest(selector) {
      let cur = this.parentNode;
      while (cur) {
        if (matchesSelector(cur, selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    querySelectorAll(selector) {
      return queryAll(this, selector);
    },
    querySelector(selector) {
      return queryAll(this, selector)[0] || null;
    },
  };

  for (const child of children) {
    const childNode =
      typeof child === 'string'
        ? {
            nodeType: 3,
            data: child,
            textContent: child,
            cloneNode() {
              return { nodeType: 3, data: child, textContent: child, cloneNode: this.cloneNode };
            },
          }
        : child;
    childNode.parentNode = node;
    node.childNodes.push(childNode);
  }
  return node;
}

function matchesSingleSelector(node, sel) {
  if (!node || node.nodeType !== 1) return false;
  const s = sel.trim();
  if (!s) return false;

  // Attribute selector: [attr="val"] or [attr=val] or [class*="sub"]
  const attrContains = s.match(/^\[([a-zA-Z0-9_-]+)\*="([^"]+)"\]$/);
  if (attrContains) {
    const [, attr, sub] = attrContains;
    const val = attr === 'class' ? node.className : node.attributes[attr];
    return typeof val === 'string' && val.includes(sub);
  }
  const attrExact = s.match(/^\[([a-zA-Z0-9_-]+)=["']?([^"'\]]+)["']?\]$/);
  if (attrExact) {
    const [, attr, expected] = attrExact;
    return node.attributes[attr] === expected;
  }

  if (s.startsWith('.')) {
    const cls = s.slice(1);
    return String(node.className || '')
      .split(/\s+/)
      .includes(cls);
  }
  if (s.startsWith('#')) {
    return node.id === s.slice(1);
  }
  return node.tagName.toLowerCase() === s.toLowerCase();
}

function matchesChain(node, chainParts) {
  if (!matchesSingleSelector(node, chainParts[chainParts.length - 1])) return false;
  let cur = node.parentNode;
  for (let i = chainParts.length - 2; i >= 0; i--) {
    const part = chainParts[i];
    while (cur && !matchesSingleSelector(cur, part)) {
      cur = cur.parentNode;
    }
    if (!cur) return false;
    cur = cur.parentNode;
  }
  return true;
}

function matchesSelector(node, selectorGroup) {
  const selectors = selectorGroup.split(',').map((s) => s.trim()).filter(Boolean);
  for (const sel of selectors) {
    const parts = sel.split(/\s+/).filter(Boolean);
    if (parts.length === 1 && matchesSingleSelector(node, parts[0])) return true;
    if (parts.length > 1 && matchesChain(node, parts)) return true;
  }
  return false;
}

function queryAll(root, selectorGroup) {
  const results = [];
  const walk = (n) => {
    for (const child of n.childNodes || []) {
      if (child.nodeType === 1) {
        if (matchesSelector(child, selectorGroup)) {
          results.push(child);
        }
        walk(child);
      }
    }
  };
  walk(root);
  return results;
}

function createFakeDoc({ title = '', hostname = 'example.com', href = 'https://example.com/', bodyChildren = [] }) {
  const body = el('body', {}, bodyChildren);
  const doc = {
    title,
    location: { hostname, href },
    body,
    documentElement: body,
    cloneNode(deep = true) {
      return createFakeDoc({
        title: this.title,
        hostname: this.location.hostname,
        href: this.location.href,
        bodyChildren: deep ? this.body.childNodes.map((c) => (c.cloneNode ? c.cloneNode(true) : { ...c })) : [],
      });
    },
    querySelectorAll(sel) {
      return queryAll(this.body, sel);
    },
    querySelector(sel) {
      return queryAll(this.body, sel)[0] || null;
    },
  };
  return doc;
}

test('Readability extraction, heading hierarchy (h1/h2/h3), TITLE, and SELECTED TEXT with no minimum length', () => {
  const doc = createFakeDoc({
    title: 'Raw Browser Tab Title',
    hostname: 'blog.example.com',
    href: 'https://blog.example.com/system-design',
    bodyChildren: [
      el('h1', {}, ['Distributed Consensus']),
      el('h2', {}, ['Raft Leader Election']),
      el('h2', {}, ['Raft Leader Election']), // duplicate consecutive heading should be deduplicated
      el('h3', {}, ['Split Vote Timeout']),
      el('article', {}, [
        el('p', {}, ['Raft achieves consensus via an elected leader and replicated log entries.']),
      ]),
    ],
  });

  // Short 3-char selection "O(n)" -> must still appear in SELECTED TEXT (no 50-char minimum!)
  const result = extractPageContent({
    document: doc,
    getSelection: () => 'O(n)',
    readabilityFactory: () => ({
      parse: () => ({
        title: 'Clean Readability Title',
        textContent: 'Raft achieves consensus via an elected leader and replicated log entries.',
      }),
    }),
  });

  assert.equal(result.source, 'readability');
  assert.equal(result.title, 'Clean Readability Title');
  assert.match(result.text, /^TITLE: Clean Readability Title/);
  assert.ok(
    result.text.includes('SELECTED TEXT:\nO(n)'),
    'short selection (<50 chars) must be included in SELECTED TEXT front-matter'
  );
  assert.ok(
    result.text.includes('HEADINGS:\nDistributed Consensus\n  Raft Leader Election\n    Split Vote Timeout'),
    'headings must preserve h1/h2/h3 indentation hierarchy and deduplicate consecutive identical headings'
  );
  assert.ok(
    result.text.includes('PAGE CONTENT:\nRaft achieves consensus via an elected leader and replicated log entries.')
  );
});

test('1-character selection is preserved in SELECTED TEXT front-matter', () => {
  const doc = createFakeDoc({
    title: 'Quick Page',
    bodyChildren: [el('p', {}, ['Some body paragraph that is longer than forty characters for fallback.'])],
  });

  const res = extractPageContent({
    document: doc,
    getSelection: () => 'x',
  });
  assert.ok(res.text.includes('SELECTED TEXT:\nx'));
});

test('Trims ONLY PAGE CONTENT from the end when exceeding DOM_CONTEXT_MAX_CHARS (25,000)', () => {
  assert.equal(DOM_CONTEXT_MAX_CHARS, 25000);

  const giantBody = 'A'.repeat(30000) + 'TAIL_MARKER_SHOULD_BE_TRIMMED';
  const doc = createFakeDoc({
    title: 'Long Article Title',
    bodyChildren: [
      el('h1', {}, ['Top Section']),
      el('pre', {}, ['function keepMeInFrontMatter() { return 42; }']),
      el('article', {}, [el('p', {}, [giantBody])]),
    ],
  });

  const res = extractPageContent({
    document: doc,
    getSelection: () => 'important selection',
    readabilityFactory: () => ({
      parse: () => ({
        title: 'Long Article Title',
        textContent: giantBody,
      }),
    }),
  });

  assert.equal(res.text.length, DOM_CONTEXT_MAX_CHARS);
  // Front-matter is preserved intact at the top
  assert.ok(res.text.startsWith('TITLE: Long Article Title\n\nSELECTED TEXT:\nimportant selection'));
  assert.ok(res.text.includes('CODE ON PAGE:\nfunction keepMeInFrontMatter() { return 42; }'));
  assert.ok(res.text.includes('HEADINGS:\nTop Section'));
  assert.ok(res.text.includes('PAGE CONTENT:\nAAAA'));
  // End of giant body was trimmed off
  assert.ok(!res.text.includes('TAIL_MARKER_SHOULD_BE_TRIMMED'));
});

test('Coding platform extraction: statement container wins over Readability and preserves <pre> sample I/O + Monaco editor lines verbatim', () => {
  const doc = createFakeDoc({
    title: '1. Two Sum - LeetCode',
    hostname: 'leetcode.com',
    href: 'https://leetcode.com/problems/two-sum/',
    bodyChildren: [
      el('h1', {}, ['1. Two Sum']),
      el('div', { 'data-track-load': 'description_content' }, [
        el('p', {}, ['Given an array of integers nums and an integer target, return indices of the two numbers.']),
        el('pre', {}, ['Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]\nExplanation: Because nums[0] + nums[1] == 9, we return [0, 1].']),
        el('p', {}, ['Constraints:']),
        el('ul', {}, [
          el('li', {}, ['2 <= nums.length <= 10', el('sup', {}, ['4'])]),
        ]),
      ]),
      el('div', { class: 'monaco-editor' }, [
        el('div', { class: 'view-lines' }, [
          el('div', { class: 'view-line' }, ['class\u00A0Solution:']),
          el('div', { class: 'view-line' }, ['    def twoSum(self, nums: List[int], target: int) -> List[int]:']),
          el('div', { class: 'view-line' }, ['        \u200Bpass']),
        ]),
      ]),
    ],
  });

  // Even if Readability returns a mangled/Incomplete article that lost the statement & constraints,
  // the platform statement container on leetcode.com MUST win over Readability!
  const res = extractPageContent({
    document: doc,
    readabilityFactory: () => ({
      parse: () => ({
        title: 'Mangled Readability Title',
        textContent: 'Readability dropped the problem statement and flattened everything.',
      }),
    }),
  });

  assert.equal(res.source, 'statement');
  assert.equal(res.pageType, 'coding');

  // Verify Monaco editor code is extracted verbatim with NBSP and zero-width spaces cleaned
  assert.ok(
    res.text.includes(
      'CODE ON PAGE:\nclass Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        pass'
    ),
    'Monaco editor starter code must be extracted verbatim into CODE ON PAGE'
  );

  // Verify <pre> sample input and output newlines are kept intact in PAGE CONTENT
  assert.ok(
    res.text.includes(
      'Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]\nExplanation: Because nums[0] + nums[1] == 9, we return [0, 1].'
    ),
    '<pre> sample input and output must keep intact newlines'
  );
  assert.ok(res.text.includes('2 <= nums.length <= 10^4'), 'exponent in <sup> must be preserved as ^4');
  assert.ok(!res.text.includes('Readability dropped the problem statement'));
});

test('HackerRank / CodeMirror 6 extraction keeps sample I/O and editor lines intact', () => {
  const doc = createFakeDoc({
    title: 'Array Manipulation | HackerRank',
    hostname: 'www.hackerrank.com',
    href: 'https://www.hackerrank.com/challenges/crush/problem',
    bodyChildren: [
      el('div', { class: 'challenge-body-html' }, [
        el('div', { class: 'problem-statement' }, [
          el('p', {}, ['Starting with a 1-indexed array of zeros, perform a list of queries.']),
          el('pre', {}, ['Sample Input\n5 3\n1 2 100\n2 5 100\n3 4 100']),
          el('pre', {}, ['Sample Output\n200']),
        ]),
      ]),
      el('div', { class: 'cm-editor' }, [
        el('div', { class: 'cm-content' }, [
          el('div', { class: 'cm-line' }, ['long arrayManipulation(int n, vector<vector<int>> queries) {']),
          el('div', { class: 'cm-line' }, ['    return 0;']),
          el('div', { class: 'cm-line' }, ['}']),
        ]),
      ]),
    ],
  });

  const res = extractContent({ document: doc });
  assert.equal(res.sensitive, false);
  assert.equal(res.source, 'statement');
  assert.ok(res.text.includes('Sample Input\n5 3\n1 2 100\n2 5 100\n3 4 100'));
  assert.ok(res.text.includes('Sample Output\n200'));
  assert.ok(
    res.text.includes('long arrayManipulation(int n, vector<vector<int>> queries) {\n    return 0;\n}')
  );
});
