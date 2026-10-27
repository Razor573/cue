'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isSmallTalkOrLogistics,
  hasDanglingEnding,
  evaluateQuestionCandidate,
  createAutoAnswerController,
  createSimpleAutoAnswer,
  tokenContainment,
  normalizeForCompare
} = require('../src/auto-answer');

function createFakeClock() {
  let currentMs = 1000;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => currentMs,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, due: currentMs + ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    advance: (ms) => {
      const target = currentMs + ms;
      while (true) {
        let earliestId = null;
        let earliest = null;
        for (const [id, entry] of timers.entries()) {
          if (entry.due <= target && (!earliest || entry.due < earliest.due)) {
            earliest = entry;
            earliestId = id;
          }
        }
        if (!earliest) break;
        currentMs = earliest.due;
        timers.delete(earliestId);
        earliest.fn();
      }
      currentMs = target;
    },
    pendingCount: () => timers.size
  };
}

test('Question classifier distinguishes interview questions from small talk, logistics, and dangling clauses', async (t) => {
  await t.test('identifies audio/video checks, greetings, and rhetorical check-ins as small talk', () => {
    const smallTalkSamples = [
      'Can you hear me?',
      'Hey, can you hear me okay?',
      'Can you see my screen?',
      'Is my mic working?',
      'How are you doing today?',
      'How was your weekend?',
      "How's it going?",
      'Nice to meet you!',
      'Thanks for joining today.',
      'Where are you calling from?',
      'Does that make sense?',
      'Are you ready to get started?',
      'Shall we begin?'
    ];

    for (const sample of smallTalkSamples) {
      assert.equal(isSmallTalkOrLogistics(sample), true, `expected small talk for: ${sample}`);
      const ev = evaluateQuestionCandidate(sample);
      assert.equal(ev.decision, 'ignore', `expected ignore decision for: ${sample}`);
      assert.equal(ev.reason, 'small_talk', `expected small_talk reason for: ${sample}`);
    }
  });

  await t.test('detects mid-sentence dangling endings that need more wait time', () => {
    const danglingSamples = [
      'Can you explain how you built the pipeline and',
      'Tell me about a time when you had to deal with',
      'Walk me through how your service handles failover,',
      'What would you do if the database goes down or...'
    ];

    for (const sample of danglingSamples) {
      assert.equal(hasDanglingEnding(sample), true, `expected dangling ending for: ${sample}`);
      const ev = evaluateQuestionCandidate(sample);
      assert.equal(ev.decision, 'incomplete', `expected incomplete decision for: ${sample}`);
      assert.equal(ev.settleMs, 3200);
    }
  });

  await t.test('classifies explicit and behavioral interview questions accurately', () => {
    const explicit = evaluateQuestionCandidate('How did you design the rate limiter for your API gateway?');
    assert.equal(explicit.decision, 'question');
    assert.equal(explicit.confidence, 'high');
    assert.equal(explicit.settleMs, 1400);

    const behavioral = evaluateQuestionCandidate('Tell me about a time you resolved a critical production incident.');
    assert.equal(behavioral.decision, 'question');
    assert.equal(behavioral.confidence, 'medium');
    assert.equal(behavioral.settleMs, 2000);

    const walkThrough = evaluateQuestionCandidate('So walk me through how you debugged the memory leak in node');
    assert.equal(walkThrough.decision, 'question');
    assert.equal(walkThrough.confidence, 'medium');

    const statement = evaluateQuestionCandidate('We deploy our backend services on Kubernetes across three regions.');
    assert.equal(statement.decision, 'ignore');
    assert.equal(statement.reason, 'statement');
  });
});

test('AutoAnswerController state machine handles pauses, continuations, and self-speech cancellation', async (t) => {
  await t.test('waits for settle window and VAD silence before triggering answer', () => {
    const clock = createFakeClock();
    const states = [];
    const triggered = [];

    const ctrl = createAutoAnswerController({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onStateChange: (st) => states.push(st),
      onTriggerAnswer: (q, meta) => triggered.push({ q, meta })
    });

    ctrl.setConfig({ enabled: true, capturing: true });
    assert.equal(ctrl.getState().state, 'quiet');

    ctrl.onVadState('them', true);
    assert.equal(ctrl.getState().state, 'listening');

    ctrl.onThemInterim('How do you handle');
    ctrl.onThemFinal('How do you handle database migrations in production?');
    assert.equal(ctrl.getState().state, 'settling');

    clock.advance(1600);
    assert.equal(triggered.length, 0, 'must not trigger while them VAD is still speaking');

    ctrl.onVadState('them', false);
    clock.advance(1300);
    assert.equal(triggered.length, 0, 'must wait full settleMs after VAD silence');

    clock.advance(200);
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].q, 'How do you handle database migrations in production?');
    assert.equal(triggered[0].meta.isContinuation, false);
    assert.equal(ctrl.getState().state, 'thinking');
  });

  await t.test('ignores empty interim flushes from GeminiLiveSTT during settling', () => {
    const clock = createFakeClock();
    const triggered = [];

    const ctrl = createAutoAnswerController({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onTriggerAnswer: (q) => triggered.push(q)
    });

    ctrl.setConfig({ enabled: true, capturing: true });
    ctrl.onThemFinal('What is the difference between a process and a thread?');
    assert.equal(ctrl.getState().state, 'settling');

    ctrl.onThemInterim('');
    assert.equal(ctrl.getState().state, 'settling', 'empty interim must not reset settling state');

    clock.advance(1450);
    assert.equal(triggered.length, 1);
  });

  await t.test('cancels settling or pre-token thinking when user starts speaking', () => {
    const clock = createFakeClock();
    const triggered = [];
    let aborted = 0;

    const ctrl = createAutoAnswerController({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onTriggerAnswer: (q) => triggered.push(q),
      onAbortAnswer: () => { aborted++; }
    });

    ctrl.setConfig({ enabled: true, capturing: true });
    ctrl.onThemFinal('Can you walk me through your resume?');
    assert.equal(ctrl.getState().state, 'settling');

    ctrl.onVadState('you', true);
    assert.equal(ctrl.getState().state, 'quiet');
    clock.advance(3000);
    assert.equal(triggered.length, 0, 'user speaking during settle cancels trigger');

    ctrl.onVadState('you', false);
    ctrl.onThemFinal('What was your most challenging distributed systems project?');
    clock.advance(1500);
    assert.equal(triggered.length, 1);
    assert.equal(ctrl.getState().state, 'thinking');

    ctrl.onVadState('you', true);
    assert.equal(aborted, 1, 'user speaking before first LLM token aborts in-flight answer');
    assert.equal(ctrl.getState().state, 'quiet');
  });

  await t.test('aborts and coalesces Part 1 + Part 2 when speaker continues a half-finished question', () => {
    const clock = createFakeClock();
    const triggered = [];
    let aborted = 0;

    const ctrl = createAutoAnswerController({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onTriggerAnswer: (q, meta) => triggered.push({ q, meta }),
      onAbortAnswer: () => { aborted++; }
    });

    ctrl.setConfig({ enabled: true, capturing: true });
    ctrl.onThemFinal('Tell me about a time you scaled a backend service.');
    clock.advance(2100);
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].q, 'Tell me about a time you scaled a backend service.');
    assert.equal(ctrl.getState().state, 'thinking');

    ctrl.onThemFinal('Specifically how did you prevent cache stampedes under peak load?');
    assert.equal(aborted, 1, 'continuation must abort Part 1 answer');
    assert.equal(ctrl.getState().state, 'settling');

    clock.advance(1500);
    assert.equal(triggered.length, 2);
    assert.equal(
      triggered[1].q,
      'Tell me about a time you scaled a backend service. Specifically how did you prevent cache stampedes under peak load?'
    );
    assert.equal(triggered[1].meta.isContinuation, true);
  });

  await t.test('suppresses duplicate question triggers within cooldown window', () => {
    const clock = createFakeClock();
    const triggered = [];

    const ctrl = createAutoAnswerController({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onTriggerAnswer: (q) => triggered.push(q)
    });

    ctrl.setConfig({ enabled: true, capturing: true });
    ctrl.onThemFinal('How do you ensure idempotency in payment webhooks?');
    clock.advance(1500);
    assert.equal(triggered.length, 1);

    ctrl.onLlmStart();
    ctrl.onLlmToken();
    ctrl.onLlmDone();
    assert.equal(ctrl.getState().state, 'cooldown');

    clock.advance(2000);
    assert.equal(ctrl.getState().state, 'quiet');

    ctrl.onVadState('you', true);
    ctrl.onYouFinal('I use an idempotency key stored in Redis with a unique constraint.');
    ctrl.onVadState('you', false);

    ctrl.onThemFinal('How do you ensure idempotency in payment webhooks?');
    assert.equal(ctrl.getState().state, 'quiet');
    clock.advance(2000);
    assert.equal(triggered.length, 1, 'duplicate question within 10s must be ignored');
  });
});

// ==================== Section 2: SimpleAutoAnswer Tests ====================

const flush = () => new Promise((r) => setImmediate(r));

test('SimpleAutoAnswer engine handles prefilters, fast model judging, fallbacks, supersede, inert user, and gate checks', async (t) => {
  await t.test('prefilter skips duplicate, backchannel, and short utterances with correct log reasons', async () => {
    const clock = createFakeClock();
    const dispatches = [];
    const offers = [];

    const auto = createSimpleAutoAnswer({
      clock,
      onDispatch: (q) => dispatches.push(q),
      onOffer: (q) => offers.push(q),
      judgeCandidate: async () => ({ isAsk: true, confidence: 0.95, questionText: 'How do you shard data?' })
    });

    // 1. Backchannels
    const backchannels = ['yeah', 'cool', 'sounds good', 'makes sense'];
    for (const b of backchannels) {
      auto.onThemFinal(b);
      clock.advance(950);
      await flush();
      const log = auto.getDecisionLog();
      assert.equal(log[log.length - 1].verdict, 'silent');
      assert.equal(log[log.length - 1].reason, 'backchannel');
    }

    // 2. Too short (<4 words no '?')
    auto.onThemFinal('We deploy Kubernetes.');
    clock.advance(950);
    await flush();
    let log = auto.getDecisionLog();
    assert.equal(log[log.length - 1].verdict, 'silent');
    assert.equal(log[log.length - 1].reason, 'too_short');

    // Utterance with < 4 words but ending with '?' must NOT be skipped as too_short
    auto.onThemFinal('Why not?');
    clock.advance(950);
    await flush();
    log = auto.getDecisionLog();
    assert.notEqual(log[log.length - 1].reason, 'too_short');

    // 3. Duplicate check
    auto.onThemFinal('How do you shard data in your production database?');
    clock.advance(950);
    await flush();
    assert.equal(dispatches.length, 1);

    // Send normalized duplicate
    auto.onThemFinal('how do you shard data in your production database');
    clock.advance(950);
    await flush();
    log = auto.getDecisionLog();
    assert.equal(dispatches.length, 1, 'Duplicate utterance must not trigger second dispatch');
    assert.equal(log[log.length - 1].verdict, 'silent');
    assert.equal(log[log.length - 1].reason, 'duplicate');
  });

  await t.test('fast model judge routes confidence >= 0.88 to dispatch, >= 0.65 to offer, and rejects ungrounded extraction', async () => {
    const clock = createFakeClock();
    const dispatches = [];
    const offers = [];
    let judgeReturn = null;

    const auto = createSimpleAutoAnswer({
      clock,
      onDispatch: (q) => dispatches.push(q),
      onOffer: (q) => offers.push(q),
      judgeCandidate: async () => judgeReturn
    });

    // High confidence (>= 0.88) -> dispatch
    judgeReturn = { isAsk: true, confidence: 0.92, questionText: 'How do you handle API rate limits?' };
    auto.onThemFinal('How do you handle API rate limits across microservices?');
    clock.advance(950);
    await flush();
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0], 'How do you handle API rate limits?');
    let log = auto.getDecisionLog();
    assert.equal(log[log.length - 1].verdict, 'dispatch');
    assert.equal(log[log.length - 1].confidence, 0.92);

    // Medium confidence (>= 0.65) -> offer
    judgeReturn = { isAsk: true, confidence: 0.72, questionText: 'Should we move to the next slide?' };
    auto.onThemFinal('Should we move to the next slide now?');
    clock.advance(950);
    await flush();
    assert.equal(offers.length, 1);
    assert.equal(offers[0], 'Should we move to the next slide?');
    log = auto.getDecisionLog();
    assert.equal(log[log.length - 1].verdict, 'offer');
    assert.equal(log[log.length - 1].confidence, 0.72);

    // Low confidence (< 0.65) -> silent
    judgeReturn = { isAsk: true, confidence: 0.45, questionText: 'Maybe it is getting late today?' };
    auto.onThemFinal('Maybe it is getting late today?');
    clock.advance(950);
    await flush();
    assert.equal(dispatches.length, 1);
    assert.equal(offers.length, 1);
    log = auto.getDecisionLog();
    assert.equal(log[log.length - 1].verdict, 'silent');
    assert.equal(log[log.length - 1].reason, 'below_threshold');

    // Extracted question with token containment < 0.65 -> rejected as hallucinated
    judgeReturn = { isAsk: true, confidence: 0.98, questionText: 'Unrelated hallucination about rainy Seattle weather' };
    auto.onThemFinal('What is your philosophy on test-driven development?');
    clock.advance(950);
    await flush();
    assert.equal(dispatches.length, 1);
    assert.equal(offers.length, 1);
    log = auto.getDecisionLog();
    assert.equal(log[log.length - 1].verdict, 'silent');
    assert.equal(log[log.length - 1].reason, 'containment_failed');
  });

  await t.test('judge timeout (>2500ms) falls back to ends-with-? rule', async () => {
    const clock = createFakeClock();
    const dispatches = [];

    const auto = createSimpleAutoAnswer({
      clock,
      judgeDeadlineMs: 2500,
      onDispatch: (q) => dispatches.push(q),
      judgeCandidate: () => new Promise(() => {}) // never resolves (hangs)
    });

    // Ends with '?' -> dispatch on timeout fallback
    auto.onThemFinal('Can you explain event sourcing and CQRS?');
    clock.advance(950); // triggers stoppage and arms deadline
    clock.advance(2600); // triggers deadline timeout
    await flush();

    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0], 'Can you explain event sourcing and CQRS?');
    let log = auto.getDecisionLog();
    assert.equal(log[log.length - 1].verdict, 'dispatch');
    assert.equal(log[log.length - 1].reason, 'judge_timeout_fallback');

    // Does not end with '?' -> silent on timeout fallback
    auto.onThemFinal('Walk me through your database failover mechanism');
    clock.advance(950);
    clock.advance(2600);
    await flush();

    assert.equal(dispatches.length, 1, 'Non-? utterance must stay silent on timeout fallback');
    log = auto.getDecisionLog();
    assert.equal(log[log.length - 1].verdict, 'silent');
    assert.equal(log[log.length - 1].reason, 'judge_timeout_fallback');
  });

  await t.test('new them utterance while judge is in flight supersedes and ignores in-flight verdict', async () => {
    const clock = createFakeClock();
    const dispatches = [];
    let resolveJudge1 = null;

    const auto = createSimpleAutoAnswer({
      clock,
      onDispatch: (q) => dispatches.push(q),
      judgeCandidate: ({ candidateText }) => {
        if (candidateText.includes('cache invalidation')) {
          return Promise.resolve({
            isAsk: true,
            confidence: 0.95,
            questionText: 'Can you explain how you handle cache invalidation across regions?'
          });
        }
        return new Promise((resolve) => {
          resolveJudge1 = resolve;
        });
      }
    });

    // Part 1
    auto.onThemFinal('Can you explain how you handle');
    clock.advance(950); // Stoppage 1 fires, judge 1 in flight

    // New speech arrives while judge 1 is in flight
    auto.onThemFinal('cache invalidation across regions?');

    // Judge 1 resolves now
    if (resolveJudge1) {
      resolveJudge1({ isAsk: true, confidence: 0.95, questionText: 'Can you explain how you handle' });
    }
    await flush();
    assert.equal(dispatches.length, 0, 'In-flight verdict from superseded speech must be discarded');

    // Advance for combined speech stoppage
    clock.advance(950);
    await flush();
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0], 'Can you explain how you handle cache invalidation across regions?');
  });

  await t.test('inert user channel: you turns never clear candidate or abort answers', async () => {
    const clock = createFakeClock();
    const dispatches = [];

    const auto = createSimpleAutoAnswer({
      clock,
      onDispatch: (q) => dispatches.push(q),
      judgeCandidate: async () => ({
        isAsk: true,
        confidence: 0.95,
        questionText: 'What are your salary expectations for this position?'
      })
    });

    auto.onThemFinal('What are your salary expectations for this position?');
    // User speaks while stability window is counting down
    auto.onYouFinal('Um, let me consider that.');
    auto.onVadState('you', true);
    auto.onVadState('you', false);

    // Stoppage must still trigger
    clock.advance(950);
    await flush();

    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0], 'What are your salary expectations for this position?');
  });

  await t.test('gate check skips candidate when engine is busy', async () => {
    const clock = createFakeClock();
    const dispatches = [];
    let busyState = true;

    const auto = createSimpleAutoAnswer({
      clock,
      isBusy: () => busyState,
      onDispatch: (q) => dispatches.push(q),
      judgeCandidate: async () => ({ isAsk: true, confidence: 0.95 })
    });

    auto.onThemFinal('How do you design a distributed lock with Redis?');
    clock.advance(950);
    await flush();

    assert.equal(dispatches.length, 0, 'Must not dispatch while engine is busy');
    const log = auto.getDecisionLog();
    assert.equal(log[log.length - 1].verdict, 'silent');
    assert.equal(log[log.length - 1].reason, 'engine_busy');
  });
});
