// companion-extension/popup.js
document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const portText = document.getElementById('port-text');
  const pairBtn = document.getElementById('pair-btn');
  const captureBtn = document.getElementById('capture-btn');
  const feedback = document.getElementById('feedback');

  function setFeedback(msg, type = '') {
    feedback.textContent = msg;
    feedback.className = `feedback ${type}`;
  }

  function updateStatus(state) {
    if (!state.running) {
      statusDot.className = 'badge disconnected';
      statusText.textContent = 'Desktop not running';
      portText.textContent = '—';
      pairBtn.disabled = true;
      captureBtn.disabled = true;
      return;
    }
    portText.textContent = String(state.port || '4123');
    pairBtn.disabled = false;
    if (state.paired) {
      statusDot.className = 'badge connected';
      statusText.textContent = 'Connected';
      pairBtn.textContent = 'Re-pair with Cue';
      captureBtn.disabled = false;
    } else {
      statusDot.className = 'badge unpaired';
      statusText.textContent = 'Not Paired';
      pairBtn.textContent = 'Pair with Cue';
      captureBtn.disabled = true;
    }
  }

  function refresh() {
    chrome.runtime.sendMessage({ action: 'getStatus' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        statusDot.className = 'badge disconnected';
        statusText.textContent = 'Extension error';
        return;
      }
      updateStatus(res);
    });
  }

  pairBtn.addEventListener('click', () => {
    pairBtn.disabled = true;
    setFeedback('Pairing…');
    chrome.runtime.sendMessage({ action: 'pair' }, (res) => {
      pairBtn.disabled = false;
      if (chrome.runtime.lastError || !res || !res.ok) {
        setFeedback((res && res.error) || 'Pairing failed. Click "Connect" in Cue Settings first.', 'error');
      } else {
        setFeedback('Paired successfully!', 'success');
      }
      refresh();
    });
  });

  captureBtn.addEventListener('click', () => {
    captureBtn.disabled = true;
    setFeedback('Capturing page content…');
    chrome.runtime.sendMessage({ action: 'capture' }, (res) => {
      captureBtn.disabled = false;
      if (chrome.runtime.lastError || !res || !res.ok) {
        if (res && res.sensitive) {
          setFeedback('Sensitive page detected: capture blocked.', 'warn');
        } else {
          setFeedback((res && res.error) || 'Capture failed.', 'error');
        }
      } else {
        setFeedback(`Captured: ${res.title}`, 'success');
      }
    });
  });

  refresh();
});