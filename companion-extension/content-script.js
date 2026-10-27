// companion-extension/content-script.js
// Injected into web pages to detect sensitive inputs/URLs and extract selection or DOM text.

function isSensitivePage() {
  const url = window.location.href.toLowerCase();
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
    /auth/
  ];
  for (const pattern of sensitivePatterns) {
    if (pattern.test(url)) return true;
  }
  if (document.querySelector('input[type="password"]')) {
    return true;
  }
  return false;
}

function extractContent() {
  if (isSensitivePage()) {
    return { sensitive: true, reason: 'Sensitive page or password field detected.' };
  }

  const selection = (window.getSelection() ? window.getSelection().toString() : '').trim();
  let text = '';
  if (selection.length >= 50) {
    text = selection;
  } else {
    const mainEl = document.querySelector('article') ||
                   document.querySelector('main') ||
                   document.querySelector('[role="main"]') ||
                   document.body;
    text = mainEl ? (mainEl.innerText || mainEl.textContent || '') : '';
  }

  return {
    sensitive: false,
    text: text.trim(),
    title: document.title || 'Web Page',
    url: window.location.href
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extract_dom') {
    sendResponse(extractContent());
  }
});