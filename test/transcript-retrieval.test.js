const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MERGE_GAP_MS,
  MIN_WORDS,
  TARGET_TOKENS,
  MAX_TOKENS,
  OVERLAP_TARGET_TOKENS,
  DEFAULT_BM25,
  estimateTokens,
  cleanSegmentText,
  preprocessTranscript,
  chunkTranscript,
  formatChunkForContext,
  tokenize,
  Bm25Index,
  searchTranscriptAndNotes,
} = require('../src/transcript-retrieval');
const {
  InterviewContext,
  buildInterviewContext,
  buildContextBlock,
  searchContext,
} = require('../src/interview-context');

test('constants match specification', () => {
  assert.equal(MERGE_GAP_MS, 5000);
  assert.equal(MIN_WORDS, 3);
  assert.equal(TARGET_TOKENS, 300);
  assert.equal(MAX_TOKENS, 400);
  assert.equal(OVERLAP_TARGET_TOKENS, 50);
  assert.deepEqual(DEFAULT_BM25, { k1: 1.5, b: 0.75 });
});

test('preprocessTranscript merges consecutive same-speaker segments under 5s apart and keeps >=5s separate', () => {
  const raw = [
    { speaker: 'Interviewer', text: 'Can you walk me through', timestamp: 1000 },
    { speaker: 'Interviewer', text: 'the distributed caching layer?', timestamp: 4500 }, // 3500ms gap (< 5000ms) -> merge
    { speaker: 'Interviewer', text: 'Also how do you handle invalidation across regions?', timestamp: 10500 }, // 6000ms gap (>= 5000ms) -> separate
  ];

  const cleaned = preprocessTranscript(raw);
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[0].speaker, 'Interviewer');
  assert.equal(cleaned[0].text, 'Can you walk me through the distributed caching layer?');
  assert.equal(cleaned[0].timestamp, 1000);
  assert.equal(cleaned[0].endTimestamp, 4500);
  assert.equal(cleaned[0].isQuestion, true);

  assert.equal(cleaned[1].text, 'Also how do you handle invalidation across regions?');
  assert.equal(cleaned[1].timestamp, 10500);
  assert.equal(cleaned[1].isQuestion, true);
});

test('preprocessTranscript strips fillers, pure acknowledgements, repeated words, and drops <3 word segments', () => {
  const raw = [
    { speaker: 'Interviewer', text: 'Yeah', timestamp: 1000 },
    { speaker: 'Candidate', text: 'Sounds good!', timestamp: 1500 },
    { speaker: 'Candidate', text: 'Ok cool', timestamp: 2000 }, // 2 words & pure ack -> dropped
    { speaker: 'Candidate', text: 'Too short', timestamp: 8000 }, // 2 words -> dropped
    {
      speaker: 'Candidate',
      text: 'Like, um, you know, we we basically built the the payment service in Go.',
      timestamp: 15000,
    },
  ];

  const cleaned = preprocessTranscript(raw);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].text, 'we built the payment service in Go.');
  assert.ok(cleaned[0].wordCount >= 3);
});

test('preprocessTranscript tags questions, decisions, and action items accurately', () => {
  const raw = [
    {
      speaker: 'Interviewer',
      text: 'Tell me about a time you resolved a production incident.',
      timestamp: 1000,
    },
    {
      speaker: 'TeamLead',
      text: "We decided to migrate the primary cluster to PostgreSQL 16.",
      timestamp: 10000,
    },
    {
      speaker: 'Candidate',
      text: "I'll send the architecture diagram and benchmark report by Friday.",
      timestamp: 20000,
    },
  ];

  const cleaned = preprocessTranscript(raw);
  assert.equal(cleaned.length, 3);

  assert.equal(cleaned[0].isQuestion, true);
  assert.equal(cleaned[0].isDecision, false);
  assert.equal(cleaned[0].isActionItem, false);

  assert.equal(cleaned[1].isQuestion, false);
  assert.equal(cleaned[1].isDecision, true);

  assert.equal(cleaned[2].isQuestion, false);
  assert.equal(cleaned[2].isActionItem, true);
});

test('chunkTranscript enforces 300 target / 400 max tokens, never splits question from answer, and keeps ~50 token overlap', () => {
  // Build segments where a chunk is around ~270 tokens, followed by a ~35-token question
  // (bringing chunk to ~305 tokens, just over 300 target) and a ~60-token answer from the other speaker
  // (305 + 60 = 365 <= 400 max). The answer MUST stay in the same chunk as its question!
  const seg1Text = 'We designed the ingestion pipeline using Kafka partitions keyed by tenant identifier for ordering guarantees. '.repeat(5).trim(); // ~140 tokens
  const seg2Text = 'Each consumer group processes batches asynchronously and writes idempotent records into ClickHouse tables. '.repeat(4).trim(); // ~110 tokens
  const questionText = 'How did you handle backpressure when downstream ClickHouse replicas experienced high write latency during peak traffic?'; // ~30 tokens
  const answerText = 'We implemented adaptive concurrency limits with exponential backoff and spilled excess batches to dead-letter object storage queues for replay.'; // ~36 tokens
  const nextTurnText = 'After that we also added Prometheus alerts on consumer lag and automated partition rebalancing across worker nodes in Kubernetes. '.repeat(5).trim(); // ~155 tokens

  const segments = [
    { speaker: 'You', text: seg1Text, timestamp: 1000 },
    { speaker: 'You', text: seg2Text, timestamp: 8000 },
    { speaker: 'Them', text: questionText, timestamp: 15000, isQuestion: true },
    { speaker: 'You', text: answerText, timestamp: 22000, isQuestion: false },
    { speaker: 'You', text: nextTurnText, timestamp: 30000 },
  ];

  const chunks = chunkTranscript('m-1', segments);
  assert.ok(chunks.length >= 2, 'should split into at least 2 chunks');

  // Verify Chunk 0 contains BOTH the question and its immediate answer
  const chunk0Texts = chunks[0].segments.map((s) => s.text);
  assert.ok(chunk0Texts.includes(questionText), 'chunk 0 must include the question');
  assert.ok(
    chunk0Texts.includes(answerText),
    'chunk 0 must NOT split the question from its immediate answer when within 400 max tokens'
  );
  assert.ok(chunks[0].tokenCount <= MAX_TOKENS, `chunk 0 tokenCount (${chunks[0].tokenCount}) must not exceed ${MAX_TOKENS}`);

  // Verify Chunk 1 carries overlap (~50 tokens) from the end of Chunk 0
  assert.ok(chunks[1].overlapCount > 0, 'chunk 1 must carry overlapped segments from chunk 0');
  const chunk1FirstSegs = chunks[1].segments.slice(0, chunks[1].overlapCount);
  const overlapTokens = chunk1FirstSegs.reduce((sum, s) => sum + s.tokens, 0);
  assert.ok(overlapTokens >= 30 && overlapTokens <= 120, `overlap tokens (${overlapTokens}) should be around ~50 tokens`);

  const formatted = formatChunkForContext(chunks[0], 0);
  assert.match(formatted, /^\[00:01\]/);
  assert.ok(formatted.includes('Them: ' + questionText));
});

test('chunkTranscript flushes before a question when question + answer would exceed 400 max tokens', () => {
  const bigContext = 'The payment settlement service reconciles ledger entries across multi-currency accounts every hour. '.repeat(11).trim(); // ~280 tokens
  const question = 'Can you explain in detail how your distributed two-phase commit recovery protocol handles coordinator crashes mid-transaction?'; // ~32 tokens
  const longAnswer = 'When the coordinator crashes before emitting the commit record, participant nodes hold prepared locks until the backup coordinator runs the consensus recovery phase and queries every participant log. '.repeat(3).trim(); // ~140 tokens

  const segments = [
    { speaker: 'You', text: bigContext, timestamp: 1000 },
    { speaker: 'Them', text: question, timestamp: 10000, isQuestion: true },
    { speaker: 'You', text: longAnswer, timestamp: 18000, isQuestion: false },
  ];

  const chunks = chunkTranscript('m-2', segments);
  assert.equal(chunks.length, 2);

  // The question and longAnswer together (~172 tokens) would exceed 400 if added to bigContext (~280 tokens),
  // so they must be kept together in chunk 1!
  const chunk1Texts = chunks[1].segments.map((s) => s.text);
  assert.ok(chunk1Texts.includes(question), 'question must be in chunk 1');
  assert.ok(chunk1Texts.includes(longAnswer), 'answer must be in chunk 1 alongside its question');
});

test('Bm25Index uses k1=1.5, b=0.75 and ranks relevant transcript chunks and user notes first', () => {
  const index = new Bm25Index();
  assert.equal(index.k1, 1.5);
  assert.equal(index.b, 0.75);

  index.addDocuments([
    {
      id: 'chunk-0',
      text: 'Them: How did you reduce p99 latency in the checkout service?\nYou: We replaced synchronous REST calls with gRPC and a local Redis read-through cache, cutting p99 from 420ms to 38ms.',
      meta: { source: 'transcript' },
    },
    {
      id: 'chunk-1',
      text: 'Them: Tell me about team onboarding.\nYou: I mentored four junior engineers and wrote the runbook for on-call incident response.',
      meta: { source: 'transcript' },
    },
    {
      id: 'note-0',
      text: 'Target compensation: $195k base salary, $50k equity grant, flexible remote schedule.',
      meta: { source: 'notes' },
    },
  ]);

  const latencyHits = index.search('Redis p99 latency checkout', 2);
  assert.ok(latencyHits.length > 0);
  assert.equal(latencyHits[0].id, 'chunk-0');

  const compHits = index.search('base salary equity compensation', 2);
  assert.ok(compHits.length > 0);
  assert.equal(compHits[0].id, 'note-0');

  const normHits = index.scoreNormalized('Redis p99 latency');
  assert.equal(normHits[0].normalizedScore, 1);
});

test('searchTranscriptAndNotes and InterviewContext.searchContext retrieve across transcript and notes', () => {
  const transcript = [
    { channel: 'them', text: 'What database did you use for the analytics event store?', ts: 1000 },
    { channel: 'you', text: 'We used ClickHouse partitioned by month with Kafka consumers.', ts: 4000 },
    { channel: 'them', text: 'How did you manage schema migrations?', ts: 12000 },
    { channel: 'you', text: 'We ran blue-green materialized views with zero downtime.', ts: 16000 },
  ];
  const notes = [
    'Remember to mention the 99.99% uptime SLA on the billing webhook.',
    'Hiring manager cares deeply about Kubernetes cost optimization.',
  ];

  const hits = searchTranscriptAndNotes({
    transcript,
    notes,
    query: 'ClickHouse Kafka analytics database',
    topK: 3,
  });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].meta.source, 'transcript');
  assert.match(hits[0].text, /ClickHouse/);

  const noteHits = searchTranscriptAndNotes({
    transcript,
    notes,
    query: 'Kubernetes cost optimization',
    topK: 3,
  });
  assert.ok(noteHits.length > 0);
  assert.equal(noteHits[0].meta.source, 'notes');
  assert.match(noteHits[0].text, /Kubernetes cost optimization/);

  const ic = new InterviewContext({ transcript, notes });
  const icHits = ic.searchContext('billing webhook uptime SLA');
  assert.ok(icHits.length > 0);
  assert.match(icHits[0].text, /99\.99% uptime SLA/);

  const block = ic.buildContextBlock(
    { resumeText: 'Alex Rivera\nSenior Backend Engineer' },
    'say',
    transcript,
    null,
    { query: 'billing webhook uptime SLA' }
  );
  assert.match(block, /Retrieved Context \(BM25\)/);
  assert.match(block, /99\.99% uptime SLA/);
});
