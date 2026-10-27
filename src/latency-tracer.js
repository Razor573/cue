'use strict';

/**
 * src/latency-tracer.js
 *
 * In-memory ring buffer (last 50 requests) tracking milestone latencies
 * across LLM execution.
 *
 * Milestones:
 * question_submitted -> context_built -> provider_request_started ->
 * first_chunk -> first_useful_token -> response_completed
 * (plus validation_started/completed, retry_used).
 *
 * STRICT PRIVACY REQUIREMENT:
 * Only stores metadata: durations in ms, provider, model name, token counts, timestamps.
 * NO raw prompt or transcript text is stored.
 */

const MAX_RING_BUFFER_ENTRIES = 50;

const ALLOWED_MILESTONES = new Set([
  'question_submitted',
  'context_built',
  'provider_request_started',
  'first_chunk',
  'first_useful_token',
  'response_completed',
  'validation_started',
  'validation_completed',
  'retry_used'
]);

class Trace {
  constructor(initialMeta = {}, tracer = null) {
    this.tracer = tracer;
    this.id = initialMeta.id || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.provider = typeof initialMeta.provider === 'string' ? initialMeta.provider : '';
    this.model = typeof initialMeta.model === 'string' ? initialMeta.model : '';
    this.tokenCount = typeof initialMeta.tokenCount === 'number' ? initialMeta.tokenCount : 0;
    this.retryUsed = Boolean(initialMeta.retryUsed);
    this.timestamps = {};
    this.durations = {};
    this.recorded = false;
  }

  mark(milestone, meta = {}) {
    if (!ALLOWED_MILESTONES.has(milestone)) {
      return this;
    }

    const now = Date.now();
    if (!this.timestamps[milestone]) {
      this.timestamps[milestone] = now;
    }

    if (typeof meta.provider === 'string') this.provider = meta.provider;
    if (typeof meta.model === 'string') this.model = meta.model;
    if (typeof meta.tokenCount === 'number') this.tokenCount = meta.tokenCount;
    if (milestone === 'retry_used' || meta.retryUsed) this.retryUsed = true;

    this._calculateDurations();

    if (milestone === 'response_completed' && this.tracer && !this.recorded) {
      this.tracer.record(this);
      this.recorded = true;
    }

    return this;
  }

  _calculateDurations() {
    const qs = this.timestamps.question_submitted;
    const cb = this.timestamps.context_built;
    const ps = this.timestamps.provider_request_started;
    const fc = this.timestamps.first_chunk;
    const fut = this.timestamps.first_useful_token;
    const rc = this.timestamps.response_completed;
    const vs = this.timestamps.validation_started;
    const vc = this.timestamps.validation_completed;

    if (qs && cb) this.durations.contextBuildMs = cb - qs;
    if (cb && ps) this.durations.dispatchMs = ps - cb;
    if (ps && fc) this.durations.ttfbMs = fc - ps;
    if (ps && fut) this.durations.firstUsefulTokenMs = fut - ps;
    if (qs && fut) this.durations.perceivedLatencyMs = fut - qs;
    if (ps && rc) this.durations.generationMs = rc - ps;
    if (qs && rc) this.durations.totalMs = rc - qs;
    if (vs && vc) this.durations.validationMs = vc - vs;
  }

  finish(meta = {}) {
    if (!this.timestamps.response_completed) {
      this.mark('response_completed', meta);
    }
    if (this.tracer && !this.recorded) {
      this.tracer.record(this);
      this.recorded = true;
    }
    return this.toJSON();
  }

  toJSON() {
    // Only metadata: durations, provider, model, token counts, timestamps.
    // Zero prompt or transcript text is stored.
    return {
      id: this.id,
      provider: this.provider,
      model: this.model,
      tokenCount: this.tokenCount,
      retryUsed: this.retryUsed,
      timestamps: { ...this.timestamps },
      durations: { ...this.durations }
    };
  }
}

class LatencyTracer {
  constructor(options = {}) {
    this.capacity = options.capacity || MAX_RING_BUFFER_ENTRIES;
    this.buffer = [];
  }

  startTrace(meta = {}) {
    const trace = new Trace(meta, this);
    trace.mark('question_submitted');
    return trace;
  }

  record(traceOrData) {
    if (!traceOrData) return null;
    const data = typeof traceOrData.toJSON === 'function' ? traceOrData.toJSON() : traceOrData;

    // Strict sanitization: ensure no raw prompt/transcript/response properties leak
    const entry = {
      id: String(data.id || `trace_${Date.now()}`),
      provider: String(data.provider || ''),
      model: String(data.model || ''),
      tokenCount: Number(data.tokenCount || 0),
      retryUsed: Boolean(data.retryUsed),
      timestamps: { ...(data.timestamps || {}) },
      durations: { ...(data.durations || {}) }
    };

    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
    }
    this.buffer.push(entry);
    return entry;
  }

  snapshot() {
    return this.buffer.map(e => ({
      ...e,
      timestamps: { ...e.timestamps },
      durations: { ...e.durations }
    }));
  }

  getHistory() {
    return this.snapshot();
  }

  clear() {
    this.buffer = [];
  }

  getSummary() {
    if (this.buffer.length === 0) {
      return { count: 0, avgTotalMs: 0, avgTtfbMs: 0 };
    }
    let totalMsSum = 0;
    let ttfbSum = 0;
    let ttfbCount = 0;
    for (const e of this.buffer) {
      if (typeof e.durations.totalMs === 'number') totalMsSum += e.durations.totalMs;
      if (typeof e.durations.ttfbMs === 'number') {
        ttfbSum += e.durations.ttfbMs;
        ttfbCount++;
      }
    }
    return {
      count: this.buffer.length,
      avgTotalMs: Math.round(totalMsSum / this.buffer.length),
      avgTtfbMs: ttfbCount > 0 ? Math.round(ttfbSum / ttfbCount) : 0
    };
  }
}

function createLatencyTracer(options) {
  return new LatencyTracer(options);
}

const globalTracer = createLatencyTracer();

module.exports = {
  createLatencyTracer,
  LatencyTracer,
  globalTracer
};
