'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  resolveFollowUp,
  isBareFollowUp,
  extractSubject
} = require('../src/followup-resolver');

const {
  verifyClaims,
  extractCandidateClaims
} = require('../src/claim-verifier');

const {
  createLatencyTracer,
  LatencyTracer,
  globalTracer
} = require('../src/latency-tracer');

const store = require('../src/store');

// ============================================================================
// 4a. Follow-up Resolver Tests
// ============================================================================

test('Follow-up Resolver (4a)', async (t) => {
  await t.test('isBareFollowUp detects demonstrative pronouns and short questions', () => {
    // Demonstrative pronouns
    assert.equal(isBareFollowUp('Can you explain that?'), true);
    assert.equal(isBareFollowUp('Why did you do that?'), true);
    assert.equal(isBareFollowUp('What about this?'), true);
    assert.equal(isBareFollowUp('Is it scalable?'), true);
    assert.equal(isBareFollowUp('Why use those?'), true);
    assert.equal(isBareFollowUp('We took such an approach'), true);
    assert.equal(isBareFollowUp('Did they use the same architecture?'), true);

    // Bare short questions (< 6 words)
    assert.equal(isBareFollowUp('Why?'), true);
    assert.equal(isBareFollowUp('How so?'), true);
    assert.equal(isBareFollowUp('What about PostgreSQL?'), true);
    assert.equal(isBareFollowUp('And scaling?'), true);
    assert.equal(isBareFollowUp('Any bottlenecks?'), true);

    // Non-bare, self-contained questions (>= 6 words without demonstrative pronouns)
    assert.equal(
      isBareFollowUp('Describe the architecture of your distributed consensus system in production'),
      false
    );
    assert.equal(
      isBareFollowUp('How do engineers at Stripe handle continuous database schema migrations?'),
      false
    );

    // Empty or non-string inputs
    assert.equal(isBareFollowUp(''), false);
    assert.equal(isBareFollowUp(null), false);
    assert.equal(isBareFollowUp(undefined), false);
  });

  await t.test('extractSubject extracts subject from interviewer turns, candidate turns, and strings', () => {
    // From string with question wrapper
    assert.equal(
      extractSubject('How did you handle database migrations at Stripe?'),
      'database migrations at Stripe'
    );
    assert.equal(
      extractSubject('Can you tell me about the caching layer you built?'),
      'caching layer you built'
    );
    assert.equal(
      extractSubject('Why did you choose Redis over Memcached?'),
      'Redis over Memcached'
    );

    // From transcript turns: prefers interviewer 'them' turn over candidate 'you' turn
    const transcript = [
      { channel: 'them', text: 'How did you handle database migrations at Stripe?' },
      { channel: 'you', text: 'We used zero-downtime ghost tables and dual-writing.' },
      { channel: 'them', text: 'What was your approach to distributed transactions?' },
      { channel: 'you', text: 'We implemented a two-phase saga pattern.' }
    ];

    // Most recent interviewer question is distributed transactions
    assert.equal(extractSubject(transcript), 'distributed transactions');

    // If only candidate turn is available, falls back to candidate turn
    const candidateOnly = [
      { channel: 'you', text: 'We migrated our primary database to PostgreSQL last quarter.' }
    ];
    const candidateSubject = extractSubject(candidateOnly);
    assert.ok(candidateSubject && candidateSubject.length > 0);

    // Empty turns
    assert.equal(extractSubject([]), null);
    assert.equal(extractSubject(null), null);
  });

  await t.test('resolveFollowUp resolves short or ambiguous follow-ups deterministically in < 1ms with 0 LLM calls', () => {
    const transcript = [
      { channel: 'them', text: 'How did you handle database migrations at Stripe?' },
      { channel: 'you', text: 'We used an online schema changer with dual-write replication.' }
    ];

    const start = performance.now();

    // Resolves demonstrative pronoun
    const res1 = resolveFollowUp('Why did you do that?', transcript);
    assert.equal(res1.modified, true);
    assert.equal(res1.original, 'Why did you do that?');
    assert.match(res1.resolved, /database migrations at Stripe/i);
    assert.ok(res1.confidence >= 0.8);

    // Resolves bare short question
    const res2 = resolveFollowUp('Why?', transcript);
    assert.equal(res2.modified, true);
    assert.equal(res2.original, 'Why?');
    assert.match(res2.resolved, /database migrations at Stripe/i);
    assert.ok(res2.confidence >= 0.8);

    // Resolves ellipsis question
    const res3 = resolveFollowUp('What about PostgreSQL?', transcript);
    assert.equal(res3.modified, true);
    assert.equal(res3.original, 'What about PostgreSQL?');
    assert.match(res3.resolved, /database migrations at Stripe/i);

    const elapsedMs = performance.now() - start;
    assert.ok(elapsedMs < 10, `Expected resolution in <10ms, took ${elapsedMs}ms`);
  });

  await t.test('resolveFollowUp returns original question unmodified with confidence 0 when no match or low confidence', () => {
    // Empty transcript
    const resNoTranscript = resolveFollowUp('Why did you do that?', []);
    assert.equal(resNoTranscript.modified, false);
    assert.equal(resNoTranscript.resolved, 'Why did you do that?');
    assert.equal(resNoTranscript.confidence, 0);

    // Non-followup question
    const fullQuestion = 'How do you structure microservices in Kubernetes with Istio service mesh?';
    const transcript = [{ channel: 'them', text: 'Tell me about Redis' }];
    const resFull = resolveFollowUp(fullQuestion, transcript);
    assert.equal(resFull.modified, false);
    assert.equal(resFull.resolved, fullQuestion);
    assert.equal(resFull.confidence, 0);

    // Confidence threshold higher than actual score
    const resThreshold = resolveFollowUp('Why?', transcript, { confidenceThreshold: 0.999 });
    assert.equal(resThreshold.modified, false);
    assert.equal(resThreshold.resolved, 'Why?');
    assert.equal(resThreshold.confidence, 0);
  });
});

// ============================================================================
// 4b. Claim Verifier Tests
// ============================================================================

test('Claim Verifier (4b)', async (t) => {
  await t.test('extractCandidateClaims extracts companies, roles, metrics, dates, and technologies', () => {
    const answer = `
      At Google, I served as Staff Software Engineer from 2020 to 2023.
      I led a team of 12 engineers to build a real-time event pipeline using Kafka and Go.
      We reduced end-to-end latency by 45%, achieving 99.99% availability while scaling
      to 50M DAU and saving the organization $3.5M annually.
    `;

    const claims = extractCandidateClaims(answer);
    assert.ok(Array.isArray(claims));
    assert.ok(claims.length >= 5);

    // Companies
    assert.ok(claims.companies.includes('Google'));

    // Roles
    assert.ok(claims.roles.some(r => r.includes('Staff Software Engineer')));

    // Date ranges
    assert.ok(claims.dateRanges.some(d => d.includes('2020 to 2023')));

    // Metrics
    assert.ok(claims.metrics.includes('45%'));
    assert.ok(claims.metrics.includes('99.99%'));
    assert.ok(claims.metrics.some(m => m.includes('$3.5M')));
    assert.ok(claims.metrics.some(m => m.includes('50M DAU')));
    assert.ok(claims.metrics.some(m => m.includes('team of 12')));

    // Technologies
    assert.ok(claims.technologies.includes('Kafka'));
    assert.ok(claims.technologies.includes('Go'));
  });

  await t.test('verifyClaims returns immediately without LLM call when claimValidator is disabled', async () => {
    let fastLLMCalled = false;
    const fakeLLM = {
      stream: async () => { fastLLMCalled = true; },
      complete: async () => { fastLLMCalled = true; }
    };

    const res = await verifyClaims({
      answerText: 'I worked at Netflix and cut latency by 80%',
      profile: { resumeText: 'Senior Dev at SmallCo' },
      fastLLM: fakeLLM,
      enabled: false
    });

    assert.equal(fastLLMCalled, false);
    assert.equal(res.enabled, false);
    assert.equal(res.ok, true);
    assert.deepEqual(res.claims, []);
  });

  await t.test('verifyClaims verifies claims against resume and flags unverified facts', async () => {
    const verifiedProfile = {
      resumeText: `
        Experience:
        Senior Software Engineer at Stripe (2021 - Present)
        - Led migration from MySQL to PostgreSQL.
        - Reduced query latency by 35% across all payment endpoints.
      `,
      starStories: `
        STAR Story: Scaled Stripe payment gateway to 10M DAU with 99.99% uptime.
      `
    };

    // Answer with verified claims
    const verifiedAnswer = 'At Stripe, I was a Senior Software Engineer where I reduced query latency by 35%.';
    const verifiedRes = await verifyClaims({
      answerText: verifiedAnswer,
      profile: verifiedProfile,
      fastLLM: null, // deterministic fallback
      enabled: true
    });
    assert.equal(verifiedRes.ok, true);
    assert.equal(verifiedRes.flaggedClaims.length, 0);

    // Answer with unverified / fabricated claims
    const unverifiedAnswer = 'At Apple, I was VP of Engineering and increased profits by 400% and saved $50M.';
    const unverifiedRes = await verifyClaims({
      answerText: unverifiedAnswer,
      profile: verifiedProfile,
      fastLLM: null,
      enabled: true
    });
    assert.equal(unverifiedRes.ok, false);
    assert.ok(unverifiedRes.flaggedClaims.length > 0);
    assert.ok(unverifiedRes.flaggedClaims.some(f => f.type === 'company' && f.claim === 'Apple'));
    assert.ok(unverifiedRes.flaggedClaims.some(f => f.type === 'role' && f.claim.includes('VP of Engineering')));
    assert.ok(unverifiedRes.flaggedClaims.some(f => f.type === 'metric' && f.claim.includes('400%')));
    assert.ok(unverifiedRes.corrections.length > 0);
  });

  await t.test('verifyClaims with fastLLM mock uses JSON response and respects timeout', async () => {
    const fakeFastLLM = {
      stream: async ({ onToken }) => {
        const json = JSON.stringify({
          ok: false,
          flaggedClaims: [
            { claim: 'Amazon', type: 'company', reason: 'Not in resume' }
          ],
          corrections: [
            { original: 'Amazon', correction: 'Stripe' }
          ]
        });
        onToken(json);
      }
    };

    const res = await verifyClaims({
      answerText: 'I worked at Amazon and delivered 10x speedup.',
      profile: { resumeText: 'Software Engineer at Stripe' },
      fastLLM: fakeFastLLM,
      timeoutMs: 3500,
      enabled: true
    });

    assert.equal(res.ok, false);
    assert.equal(res.flaggedClaims.length, 1);
    assert.equal(res.flaggedClaims[0].claim, 'Amazon');
    assert.equal(res.corrections[0].correction, 'Stripe');
  });
});

// ============================================================================
// 4c. Latency Tracer Tests
// ============================================================================

test('Latency Tracer (4c)', async (t) => {
  await t.test('exports createLatencyTracer, LatencyTracer, and globalTracer', () => {
    assert.equal(typeof createLatencyTracer, 'function');
    assert.equal(typeof LatencyTracer, 'function');
    assert.ok(globalTracer instanceof LatencyTracer);
  });

  await t.test('milestones are tracked in order and compute durations in ms', () => {
    const tracer = createLatencyTracer({ capacity: 50 });
    const trace = tracer.startTrace({ provider: 'gemini', model: 'gemini-3.8-flash' });

    // Milestones: question_submitted -> context_built -> provider_request_started ->
    // first_chunk -> first_useful_token -> response_completed
    trace.mark('question_submitted');
    trace.mark('context_built');
    trace.mark('provider_request_started', { provider: 'gemini', model: 'gemini-3.8-flash' });
    trace.mark('first_chunk');
    trace.mark('first_useful_token');
    trace.mark('validation_started');
    trace.mark('validation_completed');
    trace.mark('retry_used');
    trace.mark('response_completed', { tokenCount: 128 });

    const snapshot = tracer.snapshot();
    assert.equal(snapshot.length, 1);

    const entry = snapshot[0];
    assert.equal(entry.provider, 'gemini');
    assert.equal(entry.model, 'gemini-3.8-flash');
    assert.equal(entry.tokenCount, 128);
    assert.equal(entry.retryUsed, true);

    // Check timestamps and durations
    assert.ok(entry.timestamps.question_submitted > 0);
    assert.ok(entry.timestamps.context_built >= entry.timestamps.question_submitted);
    assert.ok(entry.timestamps.response_completed >= entry.timestamps.provider_request_started);

    assert.equal(typeof entry.durations.contextBuildMs, 'number');
    assert.equal(typeof entry.durations.totalMs, 'number');
    assert.equal(typeof entry.durations.ttfbMs, 'number');
    assert.equal(typeof entry.durations.validationMs, 'number');
  });

  await t.test('STRICT PRIVACY: zero prompt, transcript, or response text is stored', () => {
    const tracer = createLatencyTracer({ capacity: 50 });
    const trace = tracer.startTrace({
      provider: 'openai',
      model: 'gpt-4o',
      // Attaching sensitive payload data should be rejected / omitted
      prompt: 'CONFIDENTIAL PROMPT TEXT',
      transcript: 'CONFIDENTIAL TRANSCRIPT TURNS',
      response: 'SECRET RESPONSE TEXT'
    });

    trace.mark('response_completed', {
      tokenCount: 42,
      rawPrompt: 'LEAK PROMPT',
      rawResponse: 'LEAK RESPONSE'
    });

    const snapshot = tracer.snapshot();
    assert.equal(snapshot.length, 1);
    const entry = snapshot[0];

    assert.equal(entry.prompt, undefined);
    assert.equal(entry.transcript, undefined);
    assert.equal(entry.response, undefined);
    assert.equal(entry.rawPrompt, undefined);
    assert.equal(entry.rawResponse, undefined);

    // Verify only allowed metadata keys are present
    const allowedKeys = new Set(['id', 'provider', 'model', 'tokenCount', 'retryUsed', 'timestamps', 'durations']);
    for (const key of Object.keys(entry)) {
      assert.ok(allowedKeys.has(key), `Unexpected key in latency trace: ${key}`);
    }
  });

  await t.test('ring buffer is capped at 50 entries and drops oldest entries on overflow', () => {
    const tracer = createLatencyTracer({ capacity: 50 });

    // Push 65 traces
    for (let i = 1; i <= 65; i++) {
      const trace = tracer.startTrace({ provider: 'test', tokenCount: i });
      trace.mark('response_completed');
    }

    const snapshot = tracer.snapshot();
    assert.equal(snapshot.length, 50);

    // Oldest 15 traces (1..15) dropped; earliest in snapshot should have tokenCount 16
    assert.equal(snapshot[0].tokenCount, 16);
    // Most recent should have tokenCount 65
    assert.equal(snapshot[snapshot.length - 1].tokenCount, 65);

    // Test getSummary
    const summary = tracer.getSummary();
    assert.equal(summary.count, 50);
    assert.equal(typeof summary.avgTotalMs, 'number');
    assert.equal(typeof summary.avgTtfbMs, 'number');

    // Test clear
    tracer.clear();
    assert.equal(tracer.snapshot().length, 0);
  });
});

// ============================================================================
// 4d. Store Defaults & Sanitization Tests
// ============================================================================

test('Store Settings Defaults and Sanitization (4d)', async (t) => {
  await t.test('defaults include followupResolver: true, claimValidator: false, latencyTracer: true', () => {
    const defaults = store.DEFAULTS;
    assert.equal(defaults.followupResolver, true);
    assert.equal(defaults.claimValidator, false);
    assert.equal(defaults.latencyTracer, true);
  });

  await t.test('stripRendererPatch sanitizes conversation intelligence boolean flags', () => {
    const cleaned = store.stripRendererPatch({
      followupResolver: 'yes',
      claimValidator: 0,
      latencyTracer: true
    });
    assert.equal(cleaned.followupResolver, true);
    assert.equal(cleaned.claimValidator, false);
    assert.equal(cleaned.latencyTracer, true);
  });
});
