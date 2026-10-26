'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isSmallTalkOrLogistics,
  hasDanglingEnding,
  evaluateQuestionCandidate,
  createAutoAnswerController
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
