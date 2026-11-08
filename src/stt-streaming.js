// Streaming Speech-to-Text via OpenAI Realtime API (WebSocket transcription session),
// Deepgram Nova streaming, Soniox, Google Cloud Speech, or Gemini's transcribe-live model.
// Falls back to batch Whisper/Gemini if streaming unavailable.

const {
  looksLikeHallucination,
  filterHallucination,
  transcribeGemini,
  buildVocabPrompt,
  classifySttError,
  describeSttError,
  formatSttFailureStatus,
  sanitizeSttTerms,
  deepgramHintParams,
  whisperGlossaryPrompt,
  isGlossaryEcho
} = require('./stt');
const { pcmToWav } = require('./wav');
const { GEMINI_TRANSCRIBE_LIVE_MODEL } = require('./llm');

function normalizeStreamArgs(apiKeyOrOptions, maybeOptions = {}) {
  if (apiKeyOrOptions && typeof apiKeyOrOptions === 'object') {
    const opts = apiKeyOrOptions;
    const apiKey = opts.apiKey || opts.key || (opts.settings && opts.settings.apiKeys && opts.settings.apiKeys[opts.provider]) || '';
    return { apiKey, options: opts };
  }
  return { apiKey: apiKeyOrOptions || '', options: maybeOptions || {} };
}

function resolveTermsFromOptions(options = {}) {
  if (options.terms !== undefined) return sanitizeSttTerms(options.terms);
  if (options.sttDictionary !== undefined) return sanitizeSttTerms(options.sttDictionary);
  if (options.dictionary !== undefined) return sanitizeSttTerms(options.dictionary);
  if (options.settings && options.settings.sttDictionary !== undefined) {
    return sanitizeSttTerms(options.settings.sttDictionary);
  }
  return [];
}

function createWebSocketInstance(url, wsOptions, options = {}) {
  if (typeof options.createWebSocket === 'function') {
    return options.createWebSocket(url, wsOptions);
  }
  const WsClass = options.WebSocketImpl || options.WebSocket;
  if (typeof WsClass === 'function') {
    return new WsClass(url, wsOptions);
  }
  const WebSocket = require('ws');
  return new WebSocket(url, wsOptions);
}

function emitFatalSttFailure(instance, provider, errInput, fallbackCause = 'unknown') {
  const detected = classifySttError(errInput);
  const cause = detected !== 'unknown' ? detected : fallbackCause;
  const message = describeSttError(provider, detected !== 'unknown' ? errInput : { ...(typeof errInput === 'object' ? errInput : {}), message: extractErrorMessage(errInput) });
  const statusPayload = {
    ...(instance.channel ? { channel: instance.channel } : {}),
    state: 'failed',
    status: 'failed',
    cause,
    provider,
    message
  };
  instance.failed = true;
  instance.failureCause = cause;
  instance.failureStatus = statusPayload;
  instance.connected = false;
  instance.reconnecting = false;
  instance._closedByUs = true;
  if (instance._reconnectTimer) {
    clearTimeout(instance._reconnectTimer);
    instance._reconnectTimer = null;
  }
  if (typeof instance._clearKeepAlive === 'function') {
    instance._clearKeepAlive();
  }
  if (typeof instance.onStatus === 'function') {
    instance.onStatus(statusPayload);
  }
  if (typeof instance.onStatusChange === 'function') {
    instance.onStatusChange(statusPayload);
  }
  if (typeof instance.onError === 'function') {
    const rawHttpStatus = errInput && (errInput.status !== undefined ? errInput.status : errInput.statusCode);
    instance.onError({
      ...statusPayload,
      status: typeof rawHttpStatus === 'number' ? rawHttpStatus : null,
      httpStatus: typeof rawHttpStatus === 'number' ? rawHttpStatus : null
    });
  }
  return statusPayload;
}

function extractErrorMessage(errInput) {
  if (!errInput) return '';
  if (typeof errInput === 'string') return errInput;
  if (typeof errInput.message === 'string') return errInput.message;
  if (typeof errInput.description === 'string') return errInput.description;
  return String(errInput);
}

// ============================================================================
// OpenAI Realtime Transcription Session (WebSocket)
// ============================================================================

class OpenAIRealtimeSTT {
  constructor(apiKeyOrOptions, maybeOptions = {}) {
    const { apiKey, options } = normalizeStreamArgs(apiKeyOrOptions, maybeOptions);
    this.apiKey = apiKey;
    this.options = options;
    this.channel = options.channel || null;
    this.model = options.model || 'gpt-realtime-whisper';
    this.terms = resolveTermsFromOptions(options);
    this.glossaryPrompt = whisperGlossaryPrompt(this.terms);
    this.ws = null;
    this.connected = false;
    this.reconnecting = false;
    this.failed = false;
    this.failureCause = null;
    this.failureStatus = null;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatus = options.onStatus || null;
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = typeof options.maxReconnectAttempts === 'number' ? options.maxReconnectAttempts : 5;
    this._reconnectDelay = typeof options.reconnectDelay === 'number' ? options.reconnectDelay : 1000;
    this._reconnectTimer = null;
    this._pendingAudio = [];
    this._sessionReady = false;
    this._closedByUs = false;
    this.sessionConfig = null;
  }

  connect() {
    if (this.ws && this.connected) return this;
    this._closedByUs = false;
    this.failed = false;

    try {
      const url = 'wss://api.openai.com/v1/realtime?intent=transcription';
      this.url = url;

      const transcriptionConfig = {
        model: this.model,
        language: 'en',
        ...(this.glossaryPrompt ? { prompt: this.glossaryPrompt } : {})
      };
      this.sessionConfig = {
        type: 'session.update',
        session: {
          type: 'transcription',
          input_audio_transcription: transcriptionConfig,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: transcriptionConfig
            }
          }
        }
      };

      const ws = createWebSocketInstance(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        }
      }, this.options);
      this.ws = ws;

      ws.on('open', () => {
        if (this.ws !== ws) return;
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connected');
        if (this.onStatus) this.onStatus({ ...(this.channel ? { channel: this.channel } : {}), state: 'connected', provider: 'openai-realtime' });
        this._sendEvent(this.sessionConfig);
      });

      if (typeof ws.on === 'function') {
        ws.on('unexpected-response', (_req, res) => {
          if (this.ws !== ws || this._closedByUs) return;
          const statusCode = res && res.statusCode;
          emitFatalSttFailure(this, 'openai-realtime', { status: statusCode, message: `HTTP ${statusCode}` });
          try { ws.close(); } catch (_) {}
        });
      }

      ws.on('message', (data) => {
        if (this.ws !== ws) return;
        try {
          const event = JSON.parse(data.toString());
          this._handleEvent(event);
        } catch (_) {}
      });

      ws.on('close', (code, reasonBuf) => {
        if (this.ws !== ws) return;
        this.connected = false;
        this._sessionReady = false;
        if (this.failed || this._closedByUs) return;
        const reason = reasonBuf ? reasonBuf.toString() : '';
        const cause = classifySttError({ code, message: reason });
        if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
          emitFatalSttFailure(this, 'openai-realtime', { code, message: reason }, cause);
          return;
        }
        this.onStatusChange('disconnected');
        if (code !== 1000 && !this.reconnecting && !this._closedByUs) {
          this._attemptReconnect();
        }
      });

      ws.on('error', (err) => {
        if (this.ws !== ws || this._closedByUs) return;
        const cause = classifySttError(err);
        if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
          emitFatalSttFailure(this, 'openai-realtime', err, cause);
          return;
        }
        this.onError({ provider: 'openai-realtime', message: err.message, status: err.status || null });
      });
    } catch (e) {
      const cause = classifySttError(e);
      if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
        emitFatalSttFailure(this, 'openai-realtime', e, cause);
      } else {
        this.onError({ provider: 'openai-realtime', message: e.message, status: null });
      }
    }
    return this;
  }

  _handleEvent(event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        this._sessionReady = true;
        this._flushPendingAudio();
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          this.onInterim(event.delta);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript && event.transcript.trim()) {
          const filtered = filterHallucination(event.transcript.trim());
          if (filtered && (!this.glossaryPrompt || !isGlossaryEcho(filtered, this.glossaryPrompt))) {
            this.onTranscript(filtered);
          }
        }
        break;

      case 'error': {
        const errObj = {
          provider: 'openai-realtime',
          message: event.error?.message || 'Unknown realtime error',
          status: event.error?.code
        };
        const cause = classifySttError(errObj);
        if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
          emitFatalSttFailure(this, 'openai-realtime', errObj, cause);
        } else {
          this.onError(errObj);
        }
        break;
      }
    }
  }

  sendAudio(pcmBuffer) {
    if (!this.connected || !this._sessionReady) {
      this._pendingAudio.push(pcmBuffer);
      if (this._pendingAudio.length > 80) this._pendingAudio.shift();
      return;
    }
    const resampled = this._resample16to24(Buffer.from(pcmBuffer));
    const b64 = resampled.toString('base64');
    this._sendEvent({
      type: 'input_audio_buffer.append',
      audio: b64
    });
  }

  _resample16to24(pcm16kHz) {
    const srcSamples = pcm16kHz.length / 2;
    const dstSamples = Math.floor(srcSamples * 24000 / 16000);
    const out = Buffer.alloc(dstSamples * 2);
    for (let i = 0; i < dstSamples; i++) {
      const srcPos = i * 16000 / 24000;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = idx < srcSamples ? pcm16kHz.readInt16LE(idx * 2) : 0;
      const s1 = (idx + 1) < srcSamples ? pcm16kHz.readInt16LE((idx + 1) * 2) : s0;
      const sample = Math.round(s0 + (s1 - s0) * frac);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
    }
    return out;
  }

  _flushPendingAudio() {
    while (this._pendingAudio.length > 0) {
      const chunk = this._pendingAudio.shift();
      const resampled = this._resample16to24(Buffer.from(chunk));
      const b64 = resampled.toString('base64');
      this._sendEvent({
        type: 'input_audio_buffer.append',
        audio: b64
      });
    }
  }

  _sendEvent(event) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(event));
    }
  }

  _attemptReconnect() {
    if (this.failed || this._closedByUs) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      emitFatalSttFailure(this, 'openai-realtime', { message: 'Max reconnection attempts reached' }, 'connection');
      return;
    }
    this.reconnecting = true;
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.reconnecting = false;
      if (!this._closedByUs && !this.failed) this.connect();
    }, Math.min(delay, 16000));
  }

  disconnect() {
    this._closedByUs = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this.reconnecting = false;
    this._sessionReady = false;
    this._pendingAudio = [];
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(1000); } catch (_) {}
    }
    this.connected = false;
  }
}

// ============================================================================
// Deepgram Nova Streaming STT (WebSocket)
// ============================================================================

class DeepgramStreamingSTT {
  constructor(apiKeyOrOptions, maybeOptions = {}) {
    const { apiKey, options } = normalizeStreamArgs(apiKeyOrOptions, maybeOptions);
    this.apiKey = apiKey;
    this.options = options;
    this.channel = options.channel || null;
    this.model = options.model || 'nova-3';
    this.terms = resolveTermsFromOptions(options);
    this.ws = null;
    this.url = '';
    this.params = null;
    this.connected = false;
    this.failed = false;
    this.failureCause = null;
    this.failureStatus = null;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatus = options.onStatus || null;
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = typeof options.maxReconnectAttempts === 'number' ? options.maxReconnectAttempts : 5;
    this._reconnectDelay = typeof options.reconnectDelay === 'number' ? options.reconnectDelay : 1000;
    this._reconnectTimer = null;
    this._keepAliveInterval = null;
    this._committed = '';
    this._closedByUs = false;
  }

  connect() {
    if (this.ws && this.connected) return this;
    this._closedByUs = false;
    this.failed = false;

    try {
      const params = new URLSearchParams({
        model: this.model,
        language: this.options.language || 'en',
        smart_format: 'true',
        interim_results: 'true',
        utterance_end_ms: '1000',
        vad_events: 'true',
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        endpointing: '300',
        punctuate: 'true'
      });

      for (const [key, value] of deepgramHintParams(this.model, this.terms)) {
        params.append(key, value);
      }
      this.params = params;

      const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
      this.url = url;

      const ws = createWebSocketInstance(url, {
        headers: { Authorization: `Token ${this.apiKey}` }
      }, this.options);
      this.ws = ws;

      ws.on('open', () => {
        if (this.ws !== ws) return;
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connected');
        if (this.onStatus) this.onStatus({ ...(this.channel ? { channel: this.channel } : {}), state: 'connected', provider: 'deepgram' });
        this._clearKeepAlive();
        this._keepAliveInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 3000);
      });

      if (typeof ws.on === 'function') {
        ws.on('unexpected-response', (_req, res) => {
          if (this.ws !== ws || this._closedByUs) return;
          const statusCode = res && res.statusCode;
          emitFatalSttFailure(this, 'deepgram', { status: statusCode, message: `HTTP ${statusCode}` });
          try { ws.close(); } catch (_) {}
        });
      }

      ws.on('message', (data) => {
        if (this.ws !== ws) return;
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch (_) {}
      });

      ws.on('close', (code, reasonBuf) => {
        if (this.ws !== ws) return;
        this.connected = false;
        this._clearKeepAlive();
        if (this.failed || this._closedByUs) return;
        const reason = reasonBuf ? reasonBuf.toString() : '';
        const cause = classifySttError({ code, message: reason });
        if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
          emitFatalSttFailure(this, 'deepgram', { code, message: reason }, cause);
          return;
        }
        this.onStatusChange('disconnected');
        if (code !== 1000 && !this._closedByUs) this._attemptReconnect();
      });

      ws.on('error', (err) => {
        if (this.ws !== ws || this._closedByUs) return;
        const cause = classifySttError(err);
        if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
          emitFatalSttFailure(this, 'deepgram', err, cause);
          return;
        }
        this.onError({ provider: 'deepgram', message: err.message, status: err.status || null });
      });
    } catch (e) {
      const cause = classifySttError(e);
      if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
        emitFatalSttFailure(this, 'deepgram', e, cause);
      } else {
        this.onError({ provider: 'deepgram', message: e.message, status: null });
      }
    }
    return this;
  }

  _handleMessage(msg) {
    if (msg.type === 'Results') {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const text = (alt.transcript || '').trim();

      if (msg.speech_final) {
        const full = ((this._committed || '') + ' ' + text).trim();
        this._committed = '';
        const filtered = filterHallucination(full);
        if (filtered) this.onTranscript(filtered);
        this.onInterim('');
        return;
      }
      if (!text) return;
      if (msg.is_final) {
        this._committed = ((this._committed || '') + ' ' + text).trim();
        this.onInterim(this._committed);
      } else {
        this.onInterim(((this._committed || '') + ' ' + text).trim());
      }
    } else if (msg.type === 'UtteranceEnd') {
      this._flushCommitted();
    } else if (msg.type === 'Error') {
      const errObj = {
        provider: 'deepgram',
        message: msg.description || msg.message || 'Deepgram error',
        status: msg.status || msg.code || msg.variant
      };
      const cause = classifySttError(errObj);
      if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
        emitFatalSttFailure(this, 'deepgram', errObj, cause);
      } else {
        this.onError(errObj);
      }
    }
  }

  _flushCommitted() {
    const full = (this._committed || '').trim();
    this._committed = '';
    const filtered = filterHallucination(full);
    if (filtered) this.onTranscript(filtered);
    this.onInterim('');
  }

  sendAudio(pcmBuffer) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(Buffer.from(pcmBuffer));
    }
  }

  _clearKeepAlive() {
    if (this._keepAliveInterval) { clearInterval(this._keepAliveInterval); this._keepAliveInterval = null; }
  }

  _attemptReconnect() {
    if (this.failed || this._closedByUs) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      emitFatalSttFailure(this, 'deepgram', { message: 'Max reconnection attempts reached' }, 'connection');
      return;
    }
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closedByUs && !this.failed) this.connect();
    }, Math.min(delay, 16000));
  }

  disconnect() {
    this._closedByUs = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._flushCommitted();
    this._clearKeepAlive();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      if (ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {} }
      try { ws.close(1000); } catch (_) {}
    }
    this.connected = false;
  }
}

// ============================================================================
// Soniox Streaming STT (WebSocket)
// ============================================================================

class SonioxStreamingSTT {
  constructor(apiKeyOrOptions, maybeOptions = {}) {
    const { apiKey, options } = normalizeStreamArgs(apiKeyOrOptions, maybeOptions);
    this.apiKey = apiKey;
    this.options = options;
    this.channel = options.channel || null;
    this.model = options.model || 'stt-rt-preview';
    this.terms = resolveTermsFromOptions(options);
    this.ws = null;
    this.connected = false;
    this.failed = false;
    this.failureCause = null;
    this.failureStatus = null;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatus = options.onStatus || null;
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = typeof options.maxReconnectAttempts === 'number' ? options.maxReconnectAttempts : 5;
    this._reconnectDelay = typeof options.reconnectDelay === 'number' ? options.reconnectDelay : 1000;
    this._reconnectTimer = null;
    this._closedByUs = false;
    this.initialConfig = {
      api_key: this.apiKey,
      model: this.model,
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      enable_endpoint_detection: true,
      ...(this.terms.length > 0 ? { context: { terms: this.terms } } : {})
    };
    this.config = this.initialConfig;
  }

  connect() {
    if (this.ws && this.connected) return this;
    this._closedByUs = false;
    this.failed = false;

    try {
      const url = this.options.url || 'wss://stt-rt.soniox.com/transcribe-websocket';
      this.url = url;
      const ws = createWebSocketInstance(url, {}, this.options);
      this.ws = ws;

      ws.on('open', () => {
        if (this.ws !== ws) return;
        this.connected = true;
        this._reconnectAttempts = 0;
        if (ws.readyState === 1 || typeof ws.send === 'function') {
          ws.send(JSON.stringify(this.initialConfig));
        }
        this.onStatusChange('connected');
        if (this.onStatus) this.onStatus({ ...(this.channel ? { channel: this.channel } : {}), state: 'connected', provider: 'soniox' });
      });

      if (typeof ws.on === 'function') {
        ws.on('unexpected-response', (_req, res) => {
          if (this.ws !== ws || this._closedByUs) return;
          const statusCode = res && res.statusCode;
          emitFatalSttFailure(this, 'soniox', { status: statusCode, message: `HTTP ${statusCode}` });
          try { ws.close(); } catch (_) {}
        });
      }

      ws.on('message', (data) => {
        if (this.ws !== ws) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.error_code || msg.error_message) {
            const errObj = { status: msg.error_code, message: msg.error_message || 'Soniox error' };
            const cause = classifySttError(errObj);
            if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
              emitFatalSttFailure(this, 'soniox', errObj, cause);
              return;
            }
            this.onError({ provider: 'soniox', ...errObj });
            return;
          }
          if (Array.isArray(msg.tokens)) {
            let finalText = '';
            let interimText = '';
            for (const tok of msg.tokens) {
              if (!tok || typeof tok.text !== 'string') continue;
              if (tok.is_final) finalText += tok.text;
              else interimText += tok.text;
            }
            if (finalText.trim()) {
              const filtered = filterHallucination(finalText.trim());
              if (filtered) this.onTranscript(filtered);
            }
            if (interimText.trim()) {
              this.onInterim(interimText.trim());
            }
          }
        } catch (_) {}
      });

      ws.on('close', (code, reasonBuf) => {
        if (this.ws !== ws) return;
        this.connected = false;
        if (this.failed || this._closedByUs) return;
        const reason = reasonBuf ? reasonBuf.toString() : '';
        const cause = classifySttError({ code, message: reason });
        if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
          emitFatalSttFailure(this, 'soniox', { code, message: reason }, cause);
          return;
        }
        this.onStatusChange('disconnected');
        if (code !== 1000 && !this._closedByUs) this._attemptReconnect();
      });

      ws.on('error', (err) => {
        if (this.ws !== ws || this._closedByUs) return;
        const cause = classifySttError(err);
        if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
          emitFatalSttFailure(this, 'soniox', err, cause);
          return;
        }
        this.onError({ provider: 'soniox', message: err.message, status: err.status || null });
      });
    } catch (e) {
      const cause = classifySttError(e);
      if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
        emitFatalSttFailure(this, 'soniox', e, cause);
      } else {
        this.onError({ provider: 'soniox', message: e.message, status: null });
      }
    }
    return this;
  }

  _attemptReconnect() {
    if (this.failed || this._closedByUs) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      emitFatalSttFailure(this, 'soniox', { message: 'Max reconnection attempts reached' }, 'connection');
      return;
    }
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closedByUs && !this.failed) this.connect();
    }, Math.min(delay, 16000));
  }

  sendAudio(pcmBuffer) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(Buffer.from(pcmBuffer));
    }
  }

  disconnect() {
    this._closedByUs = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(1000); } catch (_) {}
    }
    this.connected = false;
  }
}

// ============================================================================
// Google Cloud Speech Streaming STT
// ============================================================================

class GoogleCloudStreamingSTT {
  constructor(apiKeyOrOptions, maybeOptions = {}) {
    const { apiKey, options } = normalizeStreamArgs(apiKeyOrOptions, maybeOptions);
    this.apiKey = apiKey;
    this.options = options;
    this.channel = options.channel || null;
    this.model = options.model || 'latest_long';
    this.language = options.language || 'en-US';
    this.terms = resolveTermsFromOptions(options);
    this.connected = false;
    this.failed = false;
    this.failureCause = null;
    this.failureStatus = null;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatus = options.onStatus || null;
    this.onStatusChange = options.onStatusChange || (() => {});
    this._closedByUs = false;
    this.config = {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode: this.language,
      enableAutomaticPunctuation: true,
      model: this.model,
      ...(this.terms.length > 0 ? { speechContexts: [{ phrases: this.terms }] } : {})
    };
    this.streamingConfig = {
      config: this.config,
      interimResults: true
    };
    this.stream = null;
  }

  connect() {
    this._closedByUs = false;
    this.failed = false;
    try {
      const gClient = this.options.speechClient || this.options.client;
      if (typeof this.options.createRecognizeStream === 'function') {
        this.stream = this.options.createRecognizeStream(this.streamingConfig);
      } else if (gClient && typeof gClient.streamingRecognize === 'function') {
        this.stream = gClient.streamingRecognize(this.streamingConfig);
      }
      this.connected = true;
      this.onStatusChange('connected');
      if (this.onStatus) this.onStatus({ ...(this.channel ? { channel: this.channel } : {}), state: 'connected', provider: 'google' });
      if (this.stream && typeof this.stream.on === 'function') {
        this.stream.on('data', (data) => {
          const result = data && data.results && data.results[0];
          const alt = result && result.alternatives && result.alternatives[0];
          if (!alt || !alt.transcript) return;
          if (result.isFinal) {
            const filtered = filterHallucination(alt.transcript.trim());
            if (filtered) this.onTranscript(filtered);
          } else {
            this.onInterim(alt.transcript.trim());
          }
        });
        this.stream.on('error', (err) => {
          if (this._closedByUs) return;
          const cause = classifySttError(err);
          if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
            emitFatalSttFailure(this, 'google', err, cause);
          } else {
            this.onError({ provider: 'google', message: err.message, status: err.code || null });
          }
        });
      }
    } catch (e) {
      const cause = classifySttError(e);
      if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
        emitFatalSttFailure(this, 'google', e, cause);
      } else {
        this.onError({ provider: 'google', message: e.message, status: null });
      }
    }
    return this;
  }

  sendAudio(pcmBuffer) {
    if (this.stream && typeof this.stream.write === 'function') {
      this.stream.write(Buffer.from(pcmBuffer));
    }
  }

  disconnect() {
    this._closedByUs = true;
    this.connected = false;
    if (this.stream && typeof this.stream.end === 'function') {
      try { this.stream.end(); } catch (_) {}
    }
    this.stream = null;
  }
}

// ============================================================================
// Starter Functions (startDeepgramStream, startSonioxStream, startGoogleCloudStream, startOpenAIRealtimeStream)
// ============================================================================

function attachStopAliases(stt) {
  if (typeof stt.stop !== 'function') {
    stt.stop = () => stt.disconnect();
  }
  if (typeof stt.close !== 'function') {
    stt.close = () => stt.disconnect();
  }
  return stt;
}

function startDeepgramStream(apiKeyOrOptions, maybeOptions = {}) {
  const stt = attachStopAliases(new DeepgramStreamingSTT(apiKeyOrOptions, maybeOptions));
  if (stt.options.autoConnect !== false) {
    stt.connect();
  }
  return stt;
}

function startSonioxStream(apiKeyOrOptions, maybeOptions = {}) {
  const stt = attachStopAliases(new SonioxStreamingSTT(apiKeyOrOptions, maybeOptions));
  if (stt.options.autoConnect !== false) {
    stt.connect();
  }
  return stt;
}

function startGoogleCloudStream(apiKeyOrOptions, maybeOptions = {}) {
  const stt = attachStopAliases(new GoogleCloudStreamingSTT(apiKeyOrOptions, maybeOptions));
  if (stt.options.autoConnect !== false) {
    stt.connect();
  }
  return stt;
}

function startOpenAIRealtimeStream(apiKeyOrOptions, maybeOptions = {}) {
  const stt = attachStopAliases(new OpenAIRealtimeSTT(apiKeyOrOptions, maybeOptions));
  if (stt.options.autoConnect !== false) {
    stt.connect();
  }
  return stt;
}

// ============================================================================
// Gemini Live transcription (gemini-*-transcribe-live over the Live API)
// ============================================================================

const GEMINI_LIVE_CONNECT_TIMEOUT_MS = 15000;
const GEMINI_LIVE_MAX_PENDING_CHUNKS = 100;

class GeminiLiveSTT {
  constructor(apiKeyOrOptions, maybeOptions = {}) {
    const { apiKey, options } = normalizeStreamArgs(apiKeyOrOptions, maybeOptions);
    this.apiKey = apiKey;
    this.options = options;
    this.channel = options.channel || null;
    this.model = options.model || GEMINI_TRANSCRIBE_LIVE_MODEL;
    const dictTerms = resolveTermsFromOptions(options);
    this.vocabulary = dictTerms.length > 0 ? dictTerms : (options.vocabulary || []);
    this.session = null;
    this.connected = false;
    this.failed = false;
    this.failureCause = null;
    this.failureStatus = null;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatus = options.onStatus || null;
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = typeof options.maxReconnectAttempts === 'number' ? options.maxReconnectAttempts : 5;
    this._reconnectDelay = typeof options.reconnectDelay === 'number' ? options.reconnectDelay : 1000;
    this._reconnectTimer = null;
    this._pendingAudio = [];
    this._lastInterim = '';
    this._closedByUs = false;
    this._connecting = false;
    this._conn = null;
    this._createClient = options.createClient || ((key) => {
      const { GoogleGenAI } = require('@google/genai');
      return new GoogleGenAI({ apiKey: key });
    });
  }

  async connect() {
    if (this.connected || this._connecting) return;
    this._connecting = true;
    this._closedByUs = false;
    this.failed = false;
    const conn = { closed: false };
    this._conn = conn;
    try {
      const ai = this._createClient(this.apiKey);
      let rejectClosed = () => {};
      const closedEarly = new Promise((_, reject) => { rejectClosed = reject; });
      const attempt = ai.live.connect({
        model: this.model,
        config: {
          responseModalities: ['TEXT'],
          inputAudioTranscription: {
            languageCodes: [],
            customVocabulary: this.vocabulary.slice(0, 1000)
          }
        },
        callbacks: {
          onmessage: (msg) => { if (this._conn === conn) this._handleMessage(msg); },
          onerror: (err) => {
            if (this._conn !== conn) return;
            const cause = classifySttError(err);
            if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
              emitFatalSttFailure(this, 'gemini-live', err, cause);
              return;
            }
            this.onError({ provider: 'gemini-live', message: (err && err.message) || 'Gemini Live connection error', status: null });
          },
          onclose: (evt) => {
            if (this._conn !== conn || conn.closed) return;
            conn.closed = true;
            const reason = (evt && evt.reason) || '';
            if (!this.connected) { rejectClosed(new Error(reason || `Gemini Live closed before setup (code ${evt && evt.code})`)); return; }
            this._onClosed(evt);
          }
        }
      });
      let timer = null;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Gemini Live connection timed out')), GEMINI_LIVE_CONNECT_TIMEOUT_MS); });
      try {
        this.session = await Promise.race([attempt, closedEarly, timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (this._conn !== conn) { try { this.session.close(); } catch (_) {} return; }
      this.connected = true;
      this._reconnectAttempts = 0;
      this.onStatusChange('connected');
      if (this.onStatus) this.onStatus({ ...(this.channel ? { channel: this.channel } : {}), state: 'connected', provider: 'gemini-live' });
      this._flushPendingAudio();
    } catch (e) {
      this.session = null;
      const message = (e && e.message) || String(e);
      const status = /not found|not supported/i.test(message) ? 404 : (/quota|rate limit|resource_exhausted/i.test(message) ? 429 : null);
      const errObj = { provider: 'gemini-live', message, status };
      const cause = classifySttError(errObj);
      if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
        emitFatalSttFailure(this, 'gemini-live', errObj, cause);
      } else {
        this.onError(errObj);
      }
    } finally {
      this._connecting = false;
    }
  }

  _handleMessage(msg) {
    const sc = msg && msg.serverContent;
    if (!sc) return;
    if (sc.interimInputTranscription && typeof sc.interimInputTranscription.text === 'string') {
      this._lastInterim = sc.interimInputTranscription.text;
      this.onInterim(this._lastInterim);
    } else if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') {
      const text = sc.inputTranscription.text.trim();
      this._lastInterim = '';
      const filtered = filterHallucination(text);
      if (filtered) this.onTranscript(filtered);
      this.onInterim('');
    }
  }

  _onClosed(evt) {
    this.connected = false;
    this.session = null;
    if (this.failed || this._closedByUs) return;
    const reason = (evt && evt.reason) || '';
    const cause = classifySttError({ code: evt && evt.code, message: reason });
    if (cause === 'quota' || cause === 'auth' || cause === 'no mic') {
      emitFatalSttFailure(this, 'gemini-live', { code: evt && evt.code, message: reason }, cause);
      return;
    }
    this.onStatusChange('disconnected');
    this._flushInterimAsFinal();
    if (this._closedByUs) return;
    this._attemptReconnect();
  }

  _flushInterimAsFinal() {
    const text = (this._lastInterim || '').trim();
    this._lastInterim = '';
    const filtered = filterHallucination(text);
    if (filtered) this.onTranscript(filtered);
    this.onInterim('');
  }

  sendAudio(pcmBuffer) {
    if (!this.connected || !this.session) {
      this._pendingAudio.push(Buffer.from(pcmBuffer));
      if (this._pendingAudio.length > GEMINI_LIVE_MAX_PENDING_CHUNKS) this._pendingAudio.shift();
      return;
    }
    this._send(Buffer.from(pcmBuffer));
  }

  _send(buf) {
    try {
      this.session.sendRealtimeInput({ audio: { data: buf.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
    } catch (e) {
      this.onError({ provider: 'gemini-live', message: e.message, status: null });
    }
  }

  _flushPendingAudio() {
    while (this._pendingAudio.length > 0 && this.connected) this._send(this._pendingAudio.shift());
  }

  _attemptReconnect() {
    if (this.failed || this._closedByUs) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      emitFatalSttFailure(this, 'gemini-live', { message: 'Max reconnection attempts reached' }, 'connection');
      return;
    }
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closedByUs && !this.failed) this.connect();
    }, Math.min(delay, 16000));
  }

  disconnect() {
    this._closedByUs = true;
    this._conn = null;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._pendingAudio = [];
    this._flushInterimAsFinal();
    if (this.session) {
      try { this.session.sendRealtimeInput({ audioStreamEnd: true }); } catch (_) {}
      try { this.session.close(); } catch (_) {}
      this.session = null;
    }
    this.connected = false;
  }
}

// ============================================================================
// Batch STT
// ============================================================================

async function transcribeBatchOpenAI(apiKey, wav, model, prompt = '') {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({
    file,
    model: model || 'whisper-1',
    response_format: 'text',
    language: 'en',
    ...(prompt ? { prompt } : {})
  });
  return (typeof res === 'string' ? res : res.text || '').trim();
}

const transcribeBatchGemini = transcribeGemini;

// ============================================================================
// Unified Streaming STT Factory
// ============================================================================

function createStreamingSTT(settings = {}, channel, callbacks = {}) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const terms = sanitizeSttTerms(settings.sttDictionary || settings.terms);
  const { onTranscript, onInterim, onError, onStatusChange, onStatus } = callbacks;

  const forwardStatus = (status) => {
    if (onStatusChange) onStatusChange(channel, status);
    if (onStatus) {
      if (status && typeof status === 'object') onStatus({ channel, ...status });
      else onStatus({ channel, state: status });
    }
  };

  if (selectedProvider === 'local') {
    return { type: 'batch', provider: selectedProvider, instance: null };
  }

  // Priority 1: Deepgram
  if ((selectedProvider === 'auto' || selectedProvider === 'deepgram') && keys.deepgram) {
    const stt = new DeepgramStreamingSTT(keys.deepgram, {
      channel,
      model: settings.deepgramModel || 'nova-3',
      terms,
      onTranscript: (text) => onTranscript && onTranscript(channel, text),
      onInterim: (text) => onInterim && onInterim(channel, text),
      onError,
      onStatusChange: forwardStatus
    });
    return { type: 'streaming', provider: 'deepgram', instance: stt };
  }

  // Priority 2: Soniox (when explicitly selected)
  if (selectedProvider === 'soniox' && keys.soniox) {
    const stt = new SonioxStreamingSTT(keys.soniox, {
      channel,
      terms,
      onTranscript: (text) => onTranscript && onTranscript(channel, text),
      onInterim: (text) => onInterim && onInterim(channel, text),
      onError,
      onStatusChange: forwardStatus
    });
    return { type: 'streaming', provider: 'soniox', instance: stt };
  }

  // Priority 3: Google Cloud Speech (when explicitly selected)
  if ((selectedProvider === 'google' || selectedProvider === 'google-cloud') && keys.google) {
    const stt = new GoogleCloudStreamingSTT(keys.google, {
      channel,
      terms,
      onTranscript: (text) => onTranscript && onTranscript(channel, text),
      onInterim: (text) => onInterim && onInterim(channel, text),
      onError,
      onStatusChange: forwardStatus
    });
    return { type: 'streaming', provider: 'google', instance: stt };
  }

  // Priority 4: OpenAI Realtime API
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    const stt = new OpenAIRealtimeSTT(keys.openai, {
      channel,
      model: 'gpt-realtime-whisper',
      terms,
      onTranscript: (text) => onTranscript && onTranscript(channel, text),
      onInterim: (text) => onInterim && onInterim(channel, text),
      onError,
      onStatusChange: forwardStatus
    });
    return { type: 'streaming', provider: 'openai-realtime', instance: stt };
  }

  // Priority 5: Gemini transcribe-live
  if (selectedProvider === 'gemini' && keys.gemini) {
    const vocab = terms.length > 0
      ? terms
      : buildVocabPrompt(settings).split(',').map((t) => t.trim()).filter(Boolean);
    const stt = new GeminiLiveSTT(keys.gemini, {
      channel,
      terms,
      vocabulary: vocab,
      onTranscript: (text) => onTranscript && onTranscript(channel, text),
      onInterim: (text) => onInterim && onInterim(channel, text),
      onError,
      onStatusChange: forwardStatus
    });
    return { type: 'streaming', provider: 'gemini-live', instance: stt };
  }

  return {
    type: 'batch',
    provider: selectedProvider === 'custom' ? 'custom' : (selectedProvider === 'auto' && keys.gemini ? 'gemini' : 'none'),
    instance: null
  };
}

module.exports = {
  OpenAIRealtimeSTT,
  DeepgramStreamingSTT,
  SonioxStreamingSTT,
  GoogleCloudStreamingSTT,
  GeminiLiveSTT,
  startDeepgramStream,
  startSonioxStream,
  startGoogleCloudStream,
  startOpenAIRealtimeStream,
  createStreamingSTT,
  transcribeBatchOpenAI,
  transcribeBatchGemini,
  classifySttError,
  describeSttError,
  formatSttFailureStatus,
  sanitizeSttTerms,
  deepgramHintParams,
  whisperGlossaryPrompt,
  isGlossaryEcho
};
