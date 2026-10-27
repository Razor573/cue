const test = require('node:test');
const assert = require('node:assert');
const {
  extractCompanyFromJD,
  resolveResearchProvider,
  parseGroundingMetadata,
  extractNotesForCompany,
  buildDossierPrompt,
  parseDossierSections,
  generateCompanyDossier,
  formatDossierForPrompt
} = require('../src/company-dossier');
const { buildInterviewContext } = require('../src/interview-context');

test('extractCompanyFromJD - extracts single company from common patterns', () => {
  const stripeJD = 'About Stripe\nStripe builds economic infrastructure for the internet.';
  const resStripe = extractCompanyFromJD(stripeJD);
  assert.strictEqual(resStripe.company, 'Stripe');
  assert.strictEqual(resStripe.ambiguous, false);
  assert.deepStrictEqual(resStripe.candidates, ['Stripe']);

  const figmaJD = 'Join Figma to help build the future of design and creativity.';
  const resFigma = extractCompanyFromJD(figmaJD);
  assert.strictEqual(resFigma.company, 'Figma');
  assert.strictEqual(resFigma.ambiguous, false);

  const labeledJD = 'Job Posting\nCompany: Acme Corp\nRole: Principal Systems Engineer';
  const resLabeled = extractCompanyFromJD(labeledJD);
  assert.strictEqual(resLabeled.company, 'Acme Corp');
  assert.strictEqual(resLabeled.ambiguous, false);

  const seekingJD = 'Vercel is looking for a Senior Developer Relations Engineer.';
  const resSeeking = extractCompanyFromJD(seekingJD);
  assert.strictEqual(resSeeking.company, 'Vercel');
  assert.strictEqual(resSeeking.ambiguous, false);
});

test('extractCompanyFromJD - detects ambiguity when multiple companies are mentioned', () => {
  const jd = 'Join Acme Corp. We are founded by engineers formerly Google, Meta.';
  const res = extractCompanyFromJD(jd);
  assert.strictEqual(res.ambiguous, true);
  assert.strictEqual(res.company, 'Acme Corp');
  assert.ok(res.candidates.includes('Acme Corp'));
  assert.ok(res.candidates.includes('Google'));
  assert.ok(res.candidates.includes('Meta'));

  const clientJD = 'Our clients include Microsoft, Apple.';
  const resClient = extractCompanyFromJD(clientJD);
  assert.strictEqual(resClient.ambiguous, true);
  assert.ok(resClient.candidates.length >= 2);
});

test('extractCompanyFromJD - returns null when no company is found', () => {
  const jd = 'Senior Backend Engineer.\nRequirements: 5 years experience with Node.js and SQL.\nResponsibilities: build REST APIs.';
  const res = extractCompanyFromJD(jd);
  assert.strictEqual(res.company, null);
  assert.deepStrictEqual(res.candidates, []);
  assert.strictEqual(res.ambiguous, false);

  assert.strictEqual(extractCompanyFromJD('').company, null);
  assert.strictEqual(extractCompanyFromJD(null).company, null);
});

test('resolveResearchProvider - resolves active or fallback research-capable providers', () => {
  const activeGemini = {
    provider: 'gemini',
    apiKeys: { gemini: 'test-gemini-key' },
    models: { gemini: { smart: 'gemini-3.1-pro-preview' } }
  };
  assert.deepStrictEqual(resolveResearchProvider(activeGemini), {
    provider: 'gemini',
    model: 'gemini-3.1-pro-preview'
  });

  const activeOpenAIFallbackGemini = {
    provider: 'openai',
    apiKeys: { openai: 'sk-test', gemini: 'test-gemini-key' },
    models: { gemini: { smart: 'gemini-3.1-pro-preview' } }
  };
  assert.deepStrictEqual(resolveResearchProvider(activeOpenAIFallbackGemini), {
    provider: 'gemini',
    model: 'gemini-3.1-pro-preview'
  });

  const activeVertex = {
    provider: 'vertex',
    vertexProject: 'test-gcp-project',
    models: { vertex: { smart: 'gemini-4-argon' } }
  };
  assert.deepStrictEqual(resolveResearchProvider(activeVertex), {
    provider: 'vertex',
    model: 'gemini-4-argon'
  });

  const noCapable = {
    provider: 'openai',
    apiKeys: { openai: 'sk-test', anthropic: 'sk-ant-test' }
  };
  assert.strictEqual(resolveResearchProvider(noCapable), null);
  assert.strictEqual(resolveResearchProvider(null), null);
});

test('parseGroundingMetadata - parses citations from chunks, entrypoint, and queries', () => {
  const metadata = {
    groundingChunks: [
      { web: { uri: 'https://stripe.com/about', title: 'About Stripe' } },
      { web: { uri: 'https://en.wikipedia.org/wiki/Stripe_(company)', title: 'Stripe - Wikipedia' } }
    ]
  };
  const citations = parseGroundingMetadata(metadata);
  assert.strictEqual(citations.length, 2);
  assert.strictEqual(citations[0].title, 'About Stripe');
  assert.strictEqual(citations[0].url, 'https://stripe.com/about');
  assert.strictEqual(citations[1].title, 'Stripe - Wikipedia');

  const htmlMeta = {
    searchEntryPoint: {
      renderedContent: '<div><a href="https://example.com/news">Example News</a></div>'
    }
  };
  const htmlCitations = parseGroundingMetadata(htmlMeta);
  assert.strictEqual(htmlCitations.length, 1);
  assert.strictEqual(htmlCitations[0].url, 'https://example.com/news');
  assert.strictEqual(htmlCitations[0].title, 'Example News');

  assert.deepStrictEqual(parseGroundingMetadata(null), []);
  assert.deepStrictEqual(parseGroundingMetadata({}), []);
});

test('extractNotesForCompany - bounds extraction to ~1000 characters', () => {
  const notesString = 'We met with Stripe on Tuesday. Discussed payment latency and idempotency keys.';
  const extracted = extractNotesForCompany(notesString, 'Stripe');
  assert.ok(extracted.includes('Discussed payment latency'));

  const longNotes = 'Met Stripe. ' + 'x'.repeat(1500);
  const bounded = extractNotesForCompany(longNotes, 'Stripe');
  assert.ok(bounded.length <= 1001);

  const mockStore = {
    search: (query) => [
      { title: 'Stripe sync', summary: 'Aligned on API redesign', actionItems: ['Send Stripe spec'] }
    ]
  };
  const storeExtracted = extractNotesForCompany(mockStore, 'Stripe');
  assert.ok(storeExtracted.includes('Stripe sync'));
  assert.ok(storeExtracted.includes('Aligned on API redesign'));
});

test('buildDossierPrompt - requests structured briefing with the 6 exact headings', () => {
  const prompt = buildDossierPrompt('Stripe', 'Senior Backend Role');
  assert.ok(prompt.includes('"Stripe"'));
  assert.ok(prompt.includes('Overview:'));
  assert.ok(prompt.includes('What They Do:'));
  assert.ok(prompt.includes('Recent News:'));
  assert.ok(prompt.includes('Culture and Values:'));
  assert.ok(prompt.includes('Likely Interview Topics:'));
  assert.ok(prompt.includes('Questions to Ask Them:'));
});

test('parseDossierSections - extracts the 6 headings and fills missing with Unknown', () => {
  const fullResponse = `
Overview:
Stripe builds economic infrastructure for the internet.

What They Do:
Payment processing, billing, and financial automation APIs.

Recent News:
Launched Agentic Commerce Payments support.

Culture and Values:
Users first, macro thinking, high agency.

Likely Interview Topics:
Distributed transactions, API idempotency, rate limiting.

Questions to Ask Them:
How do you structure product teams around rapid iteration?
`;
  const sections = parseDossierSections(fullResponse);
  assert.ok(sections.overview.includes('economic infrastructure'));
  assert.ok(sections.whatTheyDo.includes('Payment processing'));
  assert.ok(sections.recentNews.includes('Agentic Commerce'));
  assert.ok(sections.cultureValues.includes('Users first'));
  assert.ok(sections.likelyTopics.includes('Distributed transactions'));
  assert.ok(sections.questionsToAsk.includes('product teams'));

  const partialResponse = 'Overview:\nAcme Corp is a widget maker.';
  const partial = parseDossierSections(partialResponse);
  assert.ok(partial.overview.includes('widget maker'));
  assert.strictEqual(partial.whatTheyDo, 'Unknown');
  assert.strictEqual(partial.recentNews, 'Unknown');
});

test('generateCompanyDossier - grounded vs notes-only handling', async () => {
  // 1. Provider null -> isNotesOnly: true
  const noProviderDossier = await generateCompanyDossier({
    companyName: 'Stripe',
    settings: { provider: 'openai', apiKeys: {} }
  });
  assert.strictEqual(noProviderDossier.isNotesOnly, true);
  assert.strictEqual(noProviderDossier.isGrounded, false);
  assert.ok(noProviderDossier.sections.overview.includes('No research-capable provider configured'));

  // 2. Mock LLM with grounded search metadata
  const mockGroundedLLM = {
    stream: async (params) => {
      params.onGroundingMetadata({
        groundingChunks: [{ web: { uri: 'https://stripe.com', title: 'Stripe Home' } }]
      });
      return `Overview:\nGlobal payment platform.\n\nWhat They Do:\nPayment APIs.\n\nRecent News:\nIPO plans.\n\nCulture and Values:\nHigh agency.\n\nLikely Interview Topics:\nSystem design.\n\nQuestions to Ask Them:\nWhat is the top priority this year?`;
    }
  };

  const groundedDossier = await generateCompanyDossier({
    companyName: 'Stripe',
    settings: { provider: 'gemini', apiKeys: { gemini: 'key' } },
    llmFactory: () => mockGroundedLLM
  });
  assert.strictEqual(groundedDossier.isNotesOnly, false);
  assert.strictEqual(groundedDossier.isGrounded, true);
  assert.strictEqual(groundedDossier.citations.length, 1);
  assert.strictEqual(groundedDossier.citations[0].url, 'https://stripe.com');

  // 3. Mock LLM without metadata -> isGrounded: false
  const mockUngroundedLLM = {
    stream: async () => 'Overview:\nBasic summary.'
  };
  const ungroundedDossier = await generateCompanyDossier({
    companyName: 'Stripe',
    settings: { provider: 'gemini', apiKeys: { gemini: 'key' } },
    llmFactory: () => mockUngroundedLLM
  });
  assert.strictEqual(ungroundedDossier.isNotesOnly, false);
  assert.strictEqual(ungroundedDossier.isGrounded, false);
  assert.strictEqual(ungroundedDossier.citations.length, 0);
});

test('formatDossierForPrompt & interview-context integration', () => {
  const dossier = {
    company: 'Stripe',
    sections: {
      overview: 'Financial infrastructure platform.',
      whatTheyDo: 'Payment processing APIs.',
      cultureValues: 'High agency and users first.',
      likelyTopics: 'Distributed systems and idempotency.'
    },
    notesExcerpt: 'Founder met on Tuesday.'
  };

  const formatted = formatDossierForPrompt(dossier);
  assert.ok(formatted.includes('=== Company Dossier: Stripe ==='));
  assert.ok(formatted.includes('Overview: Financial infrastructure platform.'));
  assert.ok(formatted.includes('What they do: Payment processing APIs.'));
  assert.ok(formatted.includes('Culture & Values: High agency and users first.'));
  assert.ok(formatted.includes('Likely Topics: Distributed systems and idempotency.'));
  assert.ok(formatted.includes('From your notes: Founder met on Tuesday.'));

  // Test interview context integration
  const settings = {
    jobDescription: 'Senior Infrastructure Engineer',
    currentDossier: dossier
  };
  const ctx = buildInterviewContext(settings, 'behavioral', []);
  assert.ok(ctx.includes('=== Company Dossier: Stripe ==='));
  assert.ok(ctx.includes('Financial infrastructure platform.'));

  // Coding problems (LeetCode) never include personal or company context
  const leetcodeCtx = buildInterviewContext(settings, 'leetcode', []);
  assert.strictEqual(leetcodeCtx, null);
});
