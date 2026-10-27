// companion-extension/service-worker.js
// Chrome Manifest V3 Service Worker managing loopback port discovery,
// authentication pairing, WebSocket keep-alive, and active tab content extraction.

let ws = null;

async function discoverPort() {
  for (let port = 4123; port <= 4134; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok) {
          await chrome.storage.local.set({ port });
          return port;
        }
      }
    } catch {}
  }
  return null;
}

async function connectWebSocket() {
  const { token, port } = await chrome.storage.local.get(['token', 'port']);
  const activePort = port || (await discoverPort());
  if (!token || !activePort) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws = new WebSocket(`ws://127.0.0.1:${activePort}/ws?t=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'extension' }));
    };
    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg && msg.type === 'capture-dom') {
          await triggerCapture();
        }
      } catch {}
    };
    ws.onclose = () => { ws = null; };
    ws.onerror = () => { ws = null; };
  } catch {
    ws = null;
  }
}

chrome.alarms.create('companion-ws-ping', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'companion-ws-ping') {
    connectWebSocket();
  }
});

async function handlePair() {
  const port = await discoverPort();
  if (!port) {
    throw new Error('Cue desktop is not running (ports 4123..4134 unreachable).');
  }
  const res = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 410 || err.error === 'not_armed') {
      throw new Error('Pairing window not armed. Click "Connect" in Cue Settings -> Companion first.');
    }
    throw new Error(`Pairing rejected (${res.status}): ${err.error || res.statusText}`);
  }
  const data = await res.json();
  await chrome.storage.local.set({ token: data.token, port: data.port });
  connectWebSocket();
  return { ok: true, port: data.port, token: data.token };
}

async function triggerCapture() {
  const { token, port } = await chrome.storage.local.get(['token', 'port']);
  if (!token || !port) {
    throw new Error('Extension is not paired with Cue.');
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) {
    throw new Error('No active browser tab found.');
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { action: 'extract_dom' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content-script.js']
    });
    response = await chrome.tabs.sendMessage(tab.id, { action: 'extract_dom' });
  }

  if (!response) {
    throw new Error('Content script failed to respond.');
  }
  if (response.sensitive) {
    return { sensitive: true, reason: response.reason || 'Sensitive page detected.' };
  }

  const payload = {
    dom: response.text,
    meta: {
      title: response.title || tab.title || 'Web Page',
      url: response.url || tab.url || ''
    }
  };

  const res = await fetch(`http://127.0.0.1:${port}/dom?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Capture rejected (${res.status}): ${err.error || res.statusText}`);
  }

  return { ok: true, title: payload.meta.title };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'pair') {
    handlePair().then(sendResponse).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (request.action === 'capture') {
    triggerCapture().then(sendResponse).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (request.action === 'getStatus') {
    chrome.storage.local.get(['token', 'port']).then(async ({ token, port }) => {
      let running = false;
      if (port) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/healthz`);
          running = res.ok;
        } catch {}
      }
      if (!running) {
        const found = await discoverPort();
        if (found) {
          port = found;
          running = true;
        }
      }
      sendResponse({
        paired: Boolean(token),
        running,
        port: port || null,
        wsConnected: ws ? ws.readyState === WebSocket.OPEN : false
      });
    });
    return true;
  }
});