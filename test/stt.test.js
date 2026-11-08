const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createSTT,
  classifySttError,
  describeSttError,
  formatSttFailureStatus,
  sanitizeSttTerms,
  deepgramHintParams,
  whisperGlossaryPrompt,
  isGlossaryEcho,
  filterHallucination,
  whisperTextWithoutHallucinations,
  transcribeGroq,
  transcribeOpenAI,
  MAX_STT_DICTIONARY_TERMS
} = require('../src/stt');

const {
  startDeepgramStream,
  startSonioxStream,
  startGoogleCloudStream,
  startOpenAIRealtimeStream
} = require('../src/stt-streaming');

class FakeWebSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 1; // OPEN
    this.sent = [];
    this.closed = false;
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}
FakeWebSocket.OPEN = 1;

test('keeps Custom chat credentials separate from speech-to-text providers', async () => {
  const speechToText = createSTT({
    apiKeys: {
      custom: 'gateway-token'
    }
  });

  assert.equal(speechToText.available, false);
  assert.deepEqual(speechToText.providers, []);
  assert.deepEqual(await speechToText.transcribe(Buffer.alloc(6400)), { text: '' });
});

test('Step 5.1: classifySttError and describeSttError classify quota, auth, and no mic with explicit failed (<cause>) messages', () => {
  // Quota
  assert.equal(classifySttError({ status: 402 }), 'quota');
  assert.equal(classifySttError({ status: 429 }), 'quota');
  assert.equal(classifySttError(new Error('You exceeded your current quota, please check billing')), 'quota');
  assert.equal(classifySttError('RESOURCE_EXHAUSTED: rate limit reached'), 'quota');
  assert.match(describeSttError('Deepgram', { status: 402 }), /^failed \(quota\): Deepgram quota or credits exhausted/i);

  // Auth
  assert.equal(classifySttError({ status: 401 }), 'auth');
  assert.equal(classifySttError({ status: 403 }), 'auth');
  assert.equal(classifySttError(new Error('Invalid API key provided')), 'auth');
  assert.equal(classifySttError('401 Unauthorized: bad credentials'), 'auth');
  assert.match(describeSttError('Groq', { status: 401 }), /^failed \(auth\): Groq API key rejected/i);

  // No mic
  assert.equal(classifySttError({ name: 'NotFoundError', message: 'Requested device not found' }), 'no mic');
  assert.equal(classifySttError({ name: 'NotAllowedError', message: 'Permission denied' }), 'no mic');
  assert.equal(classifySttError('No audio input device available'), 'no mic');
  assert.equal(classifySttError('Microphone unavailable or disconnected'), 'no mic');
  assert.match(describeSttError('Deepgram', { name: 'NotFoundError' }), /^failed \(no mic\): Microphone unavailable or permission denied/i);

  const statusObj = formatSttFailureStatus('Deepgram', { status: 429 }, 'you');
  assert.equal(statusObj.state, 'failed');
  assert.equal(statusObj.status, 'failed');
  assert.equal(statusObj.cause, 'quota');
  assert.equal(statusObj.channel, 'you');
  assert.match(statusObj.message, /^failed \(quota\):/);
});

test('Step 5.1: streaming STT stops reconnecting immediately on fatal quota/auth/no-mic errors and emits state: "failed"', () => {
  const createdSockets = [];
  const statuses = [];
  const errors = [];

  const handle = startDeepgramStream({
    apiKey: 'dg-bad-key',
    channel: 'you',
    WebSocketImpl: class extends FakeWebSocket {
      constructor(url, opts) {
        super(url, opts);
        createdSockets.push(this);
      }
    },
    onStatus: (st) => statuses.push(st),
    onError: (err) => errors.push(err)
  });

  assert.equal(createdSockets.length, 1);
  // Simulate HTTP 401 upgrade rejection
  createdSockets[0].emit('unexpected-response', {}, { statusCode: 401, statusMessage: 'Unauthorized' });

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].state, 'failed');
  assert.equal(statuses[0].cause, 'auth');
  assert.match(statuses[0].message, /^failed \(auth\):/);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].cause, 'auth');
  // Ensure no reconnect socket was spawned
  assert.equal(createdSockets.length, 1);
  handle.stop();
});

test('Step 5.1: streaming STT emits failed (quota) on HTTP 402/429 without infinite reconnect', () => {
  const createdSockets = [];
  const statuses = [];

  const handle = startDeepgramStream({
    apiKey: 'dg-exhausted-key',
    channel: 'them',
    WebSocketImpl: class extends FakeWebSocket {
      constructor(url, opts) {
        super(url, opts);
        createdSockets.push(this);
      }
    },
    onStatus: (st) => statuses.push(st)
  });

  createdSockets[0].emit('unexpected-response', {}, { statusCode: 402, statusMessage: 'Payment Required' });

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].state, 'failed');
  assert.equal(statuses[0].cause, 'quota');
  assert.match(statuses[0].message, /^failed \(quota\):/);
  assert.equal(createdSockets.length, 1);
  handle.stop();
});

test('Step 5.2: sanitizeSttTerms enforces 100-term cap, 40-char limit, control-char stripping, and case-insensitive deduplication', () => {
  assert.equal(MAX_STT_DICTIONARY_TERMS, 100);

  const messy = [
    '  Kubernetes\n\t ',
    'kubernetes',
    'PostgreSQL',
    'a'.repeat(60),
    '',
    '   '
  ];
  const cleaned = sanitizeSttTerms(messy);
  assert.deepEqual(cleaned, [
    'Kubernetes',
    'PostgreSQL',
    'a'.repeat(40)
  ]);

  const manyTerms = Array.from({ length: 135 }, (_, i) => `Term_${i + 1}`).join(', ');
  const capped = sanitizeSttTerms(manyTerms);
  assert.equal(capped.length, 100);
  assert.equal(capped[0], 'Term_1');
  assert.equal(capped[99], 'Term_100');
});

test('Step 5.2: deepgramHintParams, Soniox, Google Cloud Speech, and OpenAI Realtime wire dictionary terms into provider payloads', () => {
  const terms = ['Kubernetes', 'gRPC', ' CockroachDB '];

  // Deepgram nova-3 uses keyterm, nova-2 uses keywords
  assert.deepEqual(deepgramHintParams('nova-3', terms), [
    ['keyterm', 'Kubernetes'],
    ['keyterm', 'gRPC'],
    ['keyterm', 'CockroachDB']
  ]);
  assert.deepEqual(deepgramHintParams('nova-2-general', terms), [
    ['keywords', 'Kubernetes'],
    ['keywords', 'gRPC'],
    ['keywords', 'CockroachDB']
  ]);

  let dgUrl = '';
  const dg = startDeepgramStream({
    apiKey: 'dg-key',
    model: 'nova-3',
    terms,
    WebSocketImpl: class extends FakeWebSocket {
      constructor(url, opts) {
        super(url, opts);
        dgUrl = url;
      }
    }
  });
  const parsedUrl = new URL(dgUrl);
  assert.deepEqual(parsedUrl.searchParams.getAll('keyterm'), ['Kubernetes', 'gRPC', 'CockroachDB']);
  dg.stop();

  // Soniox includes context: { terms } in initial config frame
  let sonioxSocket = null;
  const soniox = startSonioxStream({
    apiKey: 'soniox-key',
    terms,
    WebSocketImpl: class extends FakeWebSocket {
      constructor(url, opts) {
        super(url, opts);
        sonioxSocket = this;
      }
    }
  });
  sonioxSocket.emit('open');
  assert.equal(sonioxSocket.sent.length, 1);
  const sonioxConfig = JSON.parse(sonioxSocket.sent[0]);
  assert.deepEqual(sonioxConfig.context, { terms: ['Kubernetes', 'gRPC', 'CockroachDB'] });
  soniox.stop();

  // Google Cloud Speech includes speechContexts: [{ phrases: terms }]
  let capturedGoogleConfig = null;
  const google = startGoogleCloudStream({
    terms,
    speechClient: {
      streamingRecognize(cfg) {
        capturedGoogleConfig = cfg;
        const stream = new EventEmitter();
        stream.write = () => {};
        stream.end = () => {};
        stream.destroy = () => {};
        return stream;
      }
    }
  });
  assert.ok(capturedGoogleConfig);
  assert.deepEqual(capturedGoogleConfig.config.speechContexts, [
    { phrases: ['Kubernetes', 'gRPC', 'CockroachDB'] }
  ]);
  google.stop();

  // OpenAI Realtime includes prompt: whisperGlossaryPrompt(terms) in input_audio_transcription
  let oaiSocket = null;
  const oai = startOpenAIRealtimeStream({
    apiKey: 'oai-key',
    terms,
    WebSocketImpl: class extends FakeWebSocket {
      constructor(url, opts) {
        super(url, opts);
        oaiSocket = this;
      }
    }
  });
  oaiSocket.emit('open');
  assert.equal(oaiSocket.sent.length, 1);
  const oaiSession = JSON.parse(oaiSocket.sent[0]);
  assert.equal(
    oaiSession.session.input_audio_transcription.prompt,
    'Glossary: Kubernetes, gRPC, CockroachDB.'
  );
  oai.stop();
});

test('Step 5.2 & 5.3: whisperGlossaryPrompt, isGlossaryEcho, filterHallucination, and whisperTextWithoutHallucinations', () => {
  const prompt = whisperGlossaryPrompt(['CueApp', 'Deepgram', 'Soniox', 'Antigravity']);
  assert.equal(prompt, 'Glossary: CueApp, Deepgram, Soniox, Antigravity.');

  // Glossary echo detection
  assert.equal(isGlossaryEcho('Glossary: CueApp, Deepgram, Soniox, Antigravity.', prompt), true);
  assert.equal(isGlossaryEcho('CueApp, Deepgram, Soniox', prompt), true);
  assert.equal(isGlossaryEcho('We integrated Deepgram and Soniox into our pipeline yesterday.', prompt), false);

  // Bracketed tag & exact hallucination blocklist
  assert.equal(filterHallucination('[Music]'), '');
  assert.equal(filterHallucination('[BLANK_AUDIO]'), '');
  assert.equal(filterHallucination('[Applause]'), '');
  assert.equal(filterHallucination('[Laughter]'), '');
  assert.equal(filterHallucination('[Inaudible]'), '');
  assert.equal(filterHallucination('Thank you.'), '');
  assert.equal(filterHallucination('Thanks for watching!'), '');
  assert.equal(filterHallucination('...'), '');
  assert.equal(filterHallucination('Hello [Music] world [BLANK_AUDIO]'), 'Hello world');

  // verbose_json segment filtering by no_speech_prob > 0.6 and avg_logprob < -1.0
  const verboseResponse = {
    text: 'Thank you. Can you explain your system design for rate limiting? [Music]',
    segments: [
      { text: 'Thank you.', no_speech_prob: 0.85, avg_logprob: -0.4 },
      { text: 'Mumbled noise', no_speech_prob: 0.75, avg_logprob: -1.45 },
      { text: 'Can you explain your system design for rate limiting?', no_speech_prob: 0.05, avg_logprob: -0.18 },
      { text: '[Music]', no_speech_prob: 0.9, avg_logprob: -1.8 }
    ]
  };
  assert.equal(
    whisperTextWithoutHallucinations(verboseResponse, prompt),
    'Can you explain your system design for rate limiting?'
  );
});

test('Step 5.2 & 5.3: transcribeGroq requests verbose_json, sends Glossary prompt, filters segment hallucinations and glossary echoes', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init, bodyText: init.body.toString('utf8') });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        text: 'Thanks for watching. How does consistent hashing work?',
        segments: [
          { text: 'Thanks for watching.', no_speech_prob: 0.82, avg_logprob: -1.3 },
          { text: 'How does consistent hashing work?', no_speech_prob: 0.04, avg_logprob: -0.22 }
        ]
      })
    };
  };

  const result = await transcribeGroq({
    apiKey: 'gsk-test',
    wav: Buffer.from('RIFF....WAVEfmt '),
    terms: ['ConsistentHashing', 'DynamoDB', ' ZooKeeper '],
    fetchImpl: fakeFetch
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].bodyText, /name="response_format"\r\n\r\nverbose_json/);
  assert.match(calls[0].bodyText, /name="prompt"\r\n\r\nGlossary: ConsistentHashing, DynamoDB, ZooKeeper\./);
  assert.equal(result, 'How does consistent hashing work?');

  // Verify glossary echo on silence is dropped
  const echoResult = await transcribeGroq({
    apiKey: 'gsk-test',
    wav: Buffer.from('RIFF....WAVEfmt '),
    terms: ['ConsistentHashing', 'DynamoDB', 'ZooKeeper'],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        text: 'Glossary: ConsistentHashing, DynamoDB, ZooKeeper.',
        segments: [
          { text: 'Glossary: ConsistentHashing, DynamoDB, ZooKeeper.', no_speech_prob: 0.2, avg_logprob: -0.3 }
        ]
      })
    })
  });
  assert.equal(echoResult, '');

  // Verify transcribeOpenAI also sends Glossary prompt and filters hallucinations
  const oaiCalls = [];
  const oaiResult = await transcribeOpenAI({
    apiKey: 'sk-test',
    wav: Buffer.from('RIFF....WAVEfmt '),
    terms: ['ConsistentHashing', 'DynamoDB'],
    fetchImpl: async (url, init) => {
      oaiCalls.push(init.body.toString('utf8'));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: '[Music] Explain Raft consensus.' })
      };
    }
  });
  assert.equal(oaiCalls.length, 1);
  assert.match(oaiCalls[0], /name="prompt"\r\n\r\nGlossary: ConsistentHashing, DynamoDB\./);
  assert.equal(oaiResult, 'Explain Raft consensus.');
});
