// companion-extension/content-script.js
// Injected into web pages to detect sensitive inputs/URLs and extract clean
// Readability / per-platform coding context, heading hierarchy, selection,
// and verbatim editor/code blocks.

const DOM_CONTEXT_MAX_CHARS = 25000;

const NOISE_SELECTORS =
  'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .cookie-banner, #cookie-banner, script, style, noscript, template, svg';

const PLATFORM_STATEMENTS = {
  'leetcode.com': [
    '[data-track-load="description_content"]',
    '[data-track-load=description_content]',
    '[data-cy="question-content"]',
    '[data-cy=question-content]',
    '.elfjS',
    '.question-content',
    '[class*="problem-description"]',
  ],
  'leetcode.cn': [
    '[data-track-load="description_content"]',
    '[data-track-load=description_content]',
    '.elfjS',
    '.question-content',
  ],
  'hackerrank.com': [
    '.problem-statement',
    '.challenge-body-html',
    '.challenge_problem_statement',
    '[class*="problem-description"]',
  ],
  'codesignal.com': [
    '.task-description-content',
    '[class*="task-description"]',
    '[class*="problem-description"]',
    '.problem-statement',
  ],
  'codility.com': [
    '.task-description-content',
    '[class*="task-description"]',
    '#brinza-task-description',
    '.problem-statement',
  ],
  'codeforces.com': [
    '.problem-statement',
  ],
  'coderpad.io': [
    '.question-content',
    '.problem-statement',
    '[class*="problem-description"]',
    '[class*="task-description"]',
  ],
  'neetcode.io': [
    '.question-content',
    '.problem-statement',
    '[class*="problem-description"]',
    '[data-track-load="description_content"]',
  ],
  'binarysearch.com': [
    '.question-content',
    '.problem-statement',
    '[class*="problem-description"]',
  ],
  'atcoder.jp': [
    '#task-statement',
    '.problem-statement',
  ],
  'geeksforgeeks.org': [
    '.problems_problem_content__Xm_eO',
    '.problem-statement',
    '[class*="problem-description"]',
  ],
};

const GENERIC_STATEMENT_SELECTORS = [
  '[data-track-load="description_content"]',
  '[data-track-load=description_content]',
  '[data-cy="question-content"]',
  '[data-cy=question-content]',
  '.elfjS',
  '.question-content',
  '.problem-statement',
  '.challenge-body-html',
  '.challenge_problem_statement',
  '.task-description-content',
  '[class*="task-description"]',
  '[class*="problem-description"]',
];

const PARAGRAPH_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'blockquote', 'section', 'article',
  'header', 'footer', 'dl',
]);
const LINE_TAGS = new Set(['div', 'li', 'pre', 'tr', 'dt', 'dd']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);
const CELL_TAGS = new Set(['td', 'th']);
const VERBATIM_TAGS = new Set(['pre', 'code', 'textarea']);
const LINE_BREAK = '\u0001';
const PARAGRAPH_BREAK = '\u0002';

function cleanCodeLine(raw) {
  return String(raw || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t\r\n]+$/, '');
}

function cleanCodeString(raw) {
  return String(raw || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '')
    .trim();
}

function collapseWhitespace(s) {
  return String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts block-aware text from a DOM node while keeping <pre>/<code>/<textarea>
 * line breaks and whitespace verbatim so sample input/output are never flattened.
 */
function blockText(root) {
  if (!root) return '';
  if (!root.childNodes || root.childNodes.length === 0) {
    return collapseWhitespace(root.textContent || root.innerText || '');
  }
  const out = [];
  const walk = (node, verbatim) => {
    const children = Array.from(node.childNodes || []);
    for (const child of children) {
      if (child.nodeType === 3) {
        const data = (child.data ?? child.textContent ?? '')
          .replace(/[\u200B-\u200D\uFEFF]/g, '')
          .replace(/\u00A0/g, ' ');
        out.push(verbatim ? data : data.replace(/\s+/g, ' '));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = String(child.nodeName || child.tagName || '').toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === 'br') {
        out.push(verbatim ? '\n' : LINE_BREAK);
        continue;
      }
      if (tag === 'sup') {
        out.push('^' + (child.textContent || '').trim());
        continue;
      }
      if (tag === 'sub') {
        out.push('_' + (child.textContent || '').trim());
        continue;
      }
      const isVerbatim = verbatim || VERBATIM_TAGS.has(tag);
      const brk = isVerbatim && tag !== 'pre'
        ? ''
        : PARAGRAPH_TAGS.has(tag)
          ? PARAGRAPH_BREAK
          : LINE_TAGS.has(tag)
            ? LINE_BREAK
            : '';
      if (brk) out.push(brk);
      if (tag === 'li' && !verbatim) out.push('- ');
      walk(child, isVerbatim);
      if (brk) out.push(brk);
      if (CELL_TAGS.has(tag) && !verbatim) out.push(' ');
    }
  };
  walk(root, VERBATIM_TAGS.has(String(root.nodeName || root.tagName || '').toLowerCase()));

  const joined = out
    .join('')
    .replace(/[ \t]*[\u0001\u0002][\u0001\u0002 \t]*/g, (run) =>
      run.includes(PARAGRAPH_BREAK) ? '\n\n' : '\n'
    );
  return joined
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function outermost(nodes) {
  const list = Array.from(nodes || []);
  const set = new Set(list);
  return list.filter((n) => {
    for (let p = n.parentNode; p; p = p.parentNode) {
      if (set.has(p)) return false;
    }
    return true;
  });
}

function normalizeHost(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .trim();
}

function getHostFromDoc(doc, explicitUrl) {
  if (explicitUrl) {
    try {
      return normalizeHost(new URL(explicitUrl).hostname);
    } catch {
      /* ignore invalid URL */
    }
  }
  try {
    if (doc && doc.location && doc.location.hostname) {
      return normalizeHost(doc.location.hostname);
    }
    if (doc && doc.location && doc.location.href) {
      return normalizeHost(new URL(doc.location.href).hostname);
    }
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined' && window.location && window.location.hostname) {
    return normalizeHost(window.location.hostname);
  }
  return '';
}

function findPlatformSelectors(host) {
  if (!host) return null;
  for (const [domain, selectors] of Object.entries(PLATFORM_STATEMENTS)) {
    if (host === domain || host.endsWith('.' + domain)) {
      return selectors;
    }
  }
  return null;
}

/**
 * Extracts the problem statement on recognized coding platforms using platform-specific
 * statement selectors and blockText (preserving <pre> sample I/O verbatim).
 */
function platformStatement(doc, url) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return '';
  const host = getHostFromDoc(doc, url);
  const hostSelectors = findPlatformSelectors(host);
  const selectorsToTry = hostSelectors
    ? [...hostSelectors, ...GENERIC_STATEMENT_SELECTORS]
    : [];

  // Also allow generic statement selectors if a coding editor or known statement class is on page
  const candidateSelectors = selectorsToTry.length ? selectorsToTry : GENERIC_STATEMENT_SELECTORS;
  if (!hostSelectors) {
    // Only use generic statement selectors on pages that actually match coding statement containers
    let hasCodingContainer = false;
    for (const sel of GENERIC_STATEMENT_SELECTORS) {
      try {
        if (doc.querySelectorAll(sel).length > 0) {
          hasCodingContainer = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (!hasCodingContainer) return '';
  }

  const seenSelectors = new Set();
  for (const sel of candidateSelectors) {
    if (seenSelectors.has(sel)) continue;
    seenSelectors.add(sel);
    let nodes = [];
    try {
      nodes = outermost(doc.querySelectorAll(sel));
    } catch {
      continue;
    }
    const parts = [];
    for (const el of nodes) {
      const clone = typeof el.cloneNode === 'function' ? el.cloneNode(true) : el;
      const t = blockText(clone);
      if (t) parts.push(t);
    }
    if (parts.length > 0) {
      return parts.join('\n\n');
    }
  }
  return '';
}

/**
 * Visible <h1..h3> headings in document order as an indented hierarchy outline (max 40).
 */
function headingOutline(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return '';
  let nodes = [];
  try {
    nodes = Array.from(doc.querySelectorAll('h1, h2, h3'));
  } catch {
    return '';
  }
  const lines = [];
  for (const el of nodes) {
    const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const tag = String(el.tagName || el.nodeName || '').toUpperCase();
    const depth = tag === 'H1' ? '' : tag === 'H2' ? '  ' : '    ';
    lines.push(`${depth}${t}`);
  }
  const out = [];
  for (const l of lines) {
    if (out[out.length - 1] !== l) {
      out.push(l);
      if (out.length >= 40) break;
    }
  }
  return out.join('\n');
}

/**
 * Extracts verbatim code from live code editors (Monaco, CodeMirror 6, CodeMirror 5, Ace).
 */
function extractEditorCode(doc, cap = 8000) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return '';
  const chunks = [];
  const seenKeys = new Set();

  const push = (raw) => {
    const t = cleanCodeString(raw);
    const key = t.replace(/\s+/g, '');
    if (t.length < 2 || seenKeys.has(key)) return;
    seenKeys.add(key);
    chunks.push(t);
  };

  const safeQuery = (sel) => {
    try {
      return Array.from(doc.querySelectorAll(sel));
    } catch {
      return [];
    }
  };

  // Monaco (.monaco-editor .view-lines .view-line)
  const monacoEditors = safeQuery('.monaco-editor .view-lines, .monaco-editor');
  for (const ed of monacoEditors) {
    const lines = ed.querySelectorAll ? Array.from(ed.querySelectorAll('.view-line')) : [];
    if (lines.length > 0) {
      push(lines.map((l) => cleanCodeLine(l.textContent || '')).join('\n'));
    }
  }
  if (monacoEditors.length === 0) {
    const directMonacoLines = safeQuery('.monaco-editor .view-lines .view-line, .view-lines .view-line');
    if (directMonacoLines.length > 0) {
      push(directMonacoLines.map((l) => cleanCodeLine(l.textContent || '')).join('\n'));
    }
  }

  // CodeMirror 6 (.cm-editor .cm-content .cm-line) and CodeMirror 5 (.CodeMirror .CodeMirror-code .CodeMirror-line)
  const cmEditors = safeQuery('.cm-editor .cm-content, .cm-content, .CodeMirror .CodeMirror-code, .CodeMirror-code');
  for (const ed of cmEditors) {
    const lines = ed.querySelectorAll
      ? Array.from(ed.querySelectorAll('.cm-line, .CodeMirror-line'))
      : [];
    if (lines.length > 0) {
      push(lines.map((l) => cleanCodeLine(l.textContent || '')).join('\n'));
    } else if (ed.textContent) {
      push(ed.textContent);
    }
  }
  if (cmEditors.length === 0) {
    const directCmLines = safeQuery('.cm-line, .CodeMirror-line');
    if (directCmLines.length > 0) {
      push(directCmLines.map((l) => cleanCodeLine(l.textContent || '')).join('\n'));
    }
  }

  // Ace (.ace_editor .ace_text-layer .ace_line, .ace_content .ace_line)
  const aceEditors = safeQuery('.ace_editor .ace_text-layer, .ace_content, .ace_editor');
  for (const ed of aceEditors) {
    const lines = ed.querySelectorAll ? Array.from(ed.querySelectorAll('.ace_line')) : [];
    if (lines.length > 0) {
      push(lines.map((l) => cleanCodeLine(l.textContent || '')).join('\n'));
    } else if (ed.textContent) {
      push(ed.textContent);
    }
  }
  if (aceEditors.length === 0) {
    const directAceLines = safeQuery('.ace_line');
    if (directAceLines.length > 0) {
      push(directAceLines.map((l) => cleanCodeLine(l.textContent || '')).join('\n'));
    }
  }

  const joined = chunks.join('\n\n');
  return joined.length > cap ? joined.slice(0, cap) + '\n…(code truncated)' : joined;
}

/**
 * Extracts verbatim code from editors (Monaco, CodeMirror, Ace), <pre>, and standalone <code>.
 */
function extractCodeBlocks(doc, cap = 8000) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return '';
  const chunks = [];
  const seen = new Set();

  const push = (raw, isEditor = false) => {
    const t = cleanCodeString(raw);
    const key = t.replace(/\s+/g, '');
    if (t.length < 2 || seen.has(key)) return;
    if (isEditor || t.length > 20 || /[\n;{}()[\]=:<>]/.test(t)) {
      seen.add(key);
      chunks.push(t);
    }
  };

  // 1. Live editor code first so starter signatures and user code are captured
  const editorCode = extractEditorCode(doc, cap);
  if (editorCode) {
    push(editorCode, true);
  }

  // 2. <pre> blocks (sample input/output, code snippets)
  try {
    const preNodes = Array.from(doc.querySelectorAll('pre'));
    for (const el of preNodes) {
      push(el.textContent || '', true);
    }
  } catch {
    /* ignore */
  }

  // 3. Standalone <code> blocks (not inside <pre>)
  try {
    const codeNodes = Array.from(doc.querySelectorAll('code'));
    for (const el of codeNodes) {
      const insidePre = typeof el.closest === 'function' ? el.closest('pre') : null;
      if (!insidePre) {
        push(el.textContent || '', false);
      }
    }
  } catch {
    /* ignore */
  }

  const joined = chunks.join('\n\n');
  return joined.length > cap ? joined.slice(0, cap) + '\n…(code truncated)' : joined;
}

/**
 * Runs Mozilla Readability (via injected readabilityFactory, global Readability, or
 * a built-in Readability-compatible article clone/scorer fallback that strips noise).
 */
function runReadability(doc, readabilityFactory) {
  if (!doc) return null;
  const factory =
    readabilityFactory ||
    (typeof globalThis !== 'undefined' && typeof globalThis.Readability === 'function'
      ? (d) => new globalThis.Readability(d)
      : null);

  if (factory) {
    try {
      const clone = typeof doc.cloneNode === 'function' ? doc.cloneNode(true) : doc;
      const res = factory(clone).parse();
      if (res && typeof res.textContent === 'string' && res.textContent.trim().length > 0) {
        return {
          title: res.title ? String(res.title).trim() : '',
          textContent: collapseWhitespace(res.textContent),
        };
      }
    } catch {
      /* fall through to built-in Readability fallback */
    }
  }

  // Built-in Readability-compatible article clone/scorer fallback
  try {
    const rootSource = doc.body || doc.documentElement || doc;
    if (!rootSource) return null;
    const clone = typeof rootSource.cloneNode === 'function' ? rootSource.cloneNode(true) : rootSource;
    if (typeof clone.querySelectorAll === 'function') {
      try {
        const noise = Array.from(clone.querySelectorAll(NOISE_SELECTORS));
        for (const n of noise) {
          if (n && n.parentNode && typeof n.parentNode.removeChild === 'function') {
            n.parentNode.removeChild(n);
          } else if (n && typeof n.remove === 'function') {
            n.remove();
          }
        }
      } catch {
        /* ignore */
      }

      const candidates = ['article', 'main', '[role="main"]', '.post-content', '.article-body'];
      for (const sel of candidates) {
        try {
          const match = typeof clone.querySelector === 'function'
            ? clone.querySelector(sel)
            : clone.querySelectorAll(sel)[0];
          if (match) {
            const text = blockText(match);
            if (text && text.length >= 40) {
              return { title: doc.title || '', textContent: text };
            }
          }
        } catch {
          /* continue */
        }
      }
    }
    const fallbackText = blockText(clone);
    if (fallbackText) {
      return { title: doc.title || '', textContent: fallbackText };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Pure DOM -> structured front-matter + body extraction.
 * Front-matter order:
 *   TITLE: <title>
 *   SELECTED TEXT:\n<selection> (NO minimum length — any non-empty selection is included)
 *   CODE ON PAGE:\n<codeBlocks>
 *   HEADINGS:\n<headings>
 *   PAGE CONTENT:\n<body>
 * Trims ONLY the body from the end to fit DOM_CONTEXT_MAX_CHARS = 25000.
 */
function extractPageContent(deps = {}) {
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  const limit = deps.maxChars || DOM_CONTEXT_MAX_CHARS;
  if (!doc) {
    return { text: '', source: 'empty', title: '', pageType: 'app' };
  }

  const getSel =
    deps.getSelection ||
    (() => {
      if (typeof doc.getSelection === 'function') {
        const s = doc.getSelection();
        return s ? s.toString() : '';
      }
      if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
        const s = window.getSelection();
        return s ? s.toString() : '';
      }
      return '';
    });

  const selection = String(getSel() || '')
    .replace(/\r\n?/g, '\n')
    .trim();

  const outline = headingOutline(doc);
  const code = extractCodeBlocks(doc);
  const statement = platformStatement(doc, deps.url);
  const readable = statement ? null : runReadability(doc, deps.readabilityFactory);

  const rawTitle = String(doc.title || '').replace(/\s+/g, ' ').trim();
  const title = String((readable && readable.title) || rawTitle || '').replace(/\s+/g, ' ').trim();

  let body = '';
  let source = 'empty';
  let pageType = 'app';

  if (statement) {
    // Statement container wins over Readability on coding platforms
    body = statement;
    source = 'statement';
    pageType = 'coding';
  } else if (readable && readable.textContent) {
    body = readable.textContent;
    source = 'readability';
    pageType = code ? 'coding' : 'article';
  } else if (doc.body) {
    body = blockText(doc.body);
    if (body) source = 'innertext';
    pageType = code ? 'coding' : 'app';
  }

  const frontParts = [];
  if (title) frontParts.push(`TITLE: ${title}`);
  if (selection.length > 0) frontParts.push(`SELECTED TEXT:\n${selection}`);
  if (code) frontParts.push(`CODE ON PAGE:\n${code}`);
  if (outline) frontParts.push(`HEADINGS:\n${outline}`);

  const frontMatter = frontParts.join('\n\n');
  const bodyPrefix = 'PAGE CONTENT:\n';

  if (!body) {
    const onlyFront = frontMatter.slice(0, limit);
    return {
      text: onlyFront,
      source: selection.length > 0 && source === 'empty' ? 'selection' : source,
      title,
      pageType,
    };
  }

  if (!frontMatter) {
    const budget = Math.max(0, limit - bodyPrefix.length);
    const trimmedBody = body.length > budget ? body.slice(0, budget) : body;
    return {
      text: `${bodyPrefix}${trimmedBody}`,
      source,
      title,
      pageType,
    };
  }

  const separator = '\n\n';
  const reserved = frontMatter.length + separator.length + bodyPrefix.length;
  if (reserved >= limit) {
    return {
      text: frontMatter.slice(0, limit),
      source,
      title,
      pageType,
    };
  }

  const bodyBudget = limit - reserved;
  const trimmedBody = body.length > bodyBudget ? body.slice(0, bodyBudget) : body;
  const fullText = `${frontMatter}${separator}${bodyPrefix}${trimmedBody}`;

  return {
    text: fullText,
    source,
    title,
    pageType,
  };
}

function isSensitivePage(docOrWindow) {
  const doc = docOrWindow || (typeof document !== 'undefined' ? document : null);
  let url = '';
  try {
    url = (
      (doc && doc.location && doc.location.href) ||
      (typeof window !== 'undefined' && window.location && window.location.href) ||
      ''
    ).toLowerCase();
  } catch {
    url = '';
  }

  const sensitivePatterns = [
    /login/,
    /signin/,
    /sign-in/,
    /log-in/,
    /bank/,
    /checkout/,
    /account/,
    /billing/,
    /password/,
    /oauth/,
    /auth/,
  ];
  for (const pattern of sensitivePatterns) {
    if (pattern.test(url)) return true;
  }
  if (doc && typeof doc.querySelector === 'function' && doc.querySelector('input[type="password"]')) {
    return true;
  }
  return false;
}

function extractContent(deps = {}) {
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  if (isSensitivePage(doc)) {
    return { sensitive: true, reason: 'Sensitive page or password field detected.' };
  }

  const extracted = extractPageContent(deps);
  const url =
    deps.url ||
    (doc && doc.location && doc.location.href) ||
    (typeof window !== 'undefined' && window.location && window.location.href) ||
    '';

  return {
    sensitive: false,
    text: extracted.text,
    source: extracted.source,
    pageType: extracted.pageType,
    title: extracted.title || (doc && doc.title) || 'Web Page',
    url,
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'extract_dom') {
      sendResponse(extractContent());
    }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DOM_CONTEXT_MAX_CHARS,
    PLATFORM_STATEMENTS,
    extractPageContent,
    extractContent,
    isSensitivePage,
    extractCodeBlocks,
    extractEditorCode,
    headingOutline,
    platformStatement,
    blockText,
    outermost,
  };
}
