// src/company-dossier.js
// Company extraction from Job Descriptions, research provider resolution,
// Google Search grounding metadata parsing, and dossier generation.

const GENERIC_COMPANY_WORDS = new Set([
  'team', 'company', 'the company', 'our company', 'role', 'requirements',
  'responsibilities', 'benefits', 'our team', 'the team', 'us', 'we', 'work',
  'job', 'you', 'careers', 'overview', 'position', 'opportunity', 'candidate',
  'the role', 'this role', 'ideal candidate', 'about', 'join', 'why', 'who we are',
  'what we do', 'skills', 'experience', 'qualifications', 'employment', 'who you are',
  'what you will do', 'what you bring', 'how to apply', 'equal opportunity',
  'location', 'department', 'salary', 'compensation', 'remote', 'engineering',
  'software', 'developer', 'manager', 'lead', 'director', 'vp', 'executive'
]);

function cleanCandidate(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  s = s.replace(/^[*_"`'#]+|[*_"`':,;.!?#-]+$/g, '').trim();
  if (s.length < 2 || s.length > 50) return '';
  if (GENERIC_COMPANY_WORDS.has(s.toLowerCase())) return '';
  const words = s.split(/\s+/);
  if (words.length > 5) return '';
  if (!/[a-zA-Z0-9]/.test(s)) return '';
  return s;
}

/**
 * extractCompanyFromJD(jdText)
 * Parses job description text to identify company name using rich heuristic extraction.
 * Returns { company, candidates, ambiguous }
 */
function extractCompanyFromJD(jdText) {
  if (!jdText || typeof jdText !== 'string' || !jdText.trim()) {
    return { company: null, candidates: [], ambiguous: false };
  }

  const cleanText = jdText.trim();
  const rawCandidates = [];

  // 1. Labeled lines: Company: <Name>, Employer: <Name>, Organization: <Name>, Client: <Name>
  const labeledRegex = /(?:^|\n)\s*(?:Company|Employer|Organization|Client)\s*:\s*([^\n\r,;]+)/gi;
  let lm;
  while ((lm = labeledRegex.exec(cleanText)) !== null) {
    const cleaned = cleanCandidate(lm[1]);
    if (cleaned) rawCandidates.push(cleaned);
  }

  // 2. Header / Title line patterns:
  // e.g. "Senior Software Engineer - Stripe", "Full Stack Developer at Linear", "Product Designer | Figma", "Staff SRE @ Datadog"
  const headerLines = cleanText.split(/\r?\n/).slice(0, 5);
  for (const line of headerLines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.length > 100) continue;
    // Format: Role - Company or Company - Role
    const dashMatch = trimmedLine.match(/^(?:.*?\b(?:engineer|developer|manager|lead|architect|designer|scientist|intern|vp|director|specialist|analyst|associate|head|consultant)\b.*?)?\s*[-–—|•·@]\s*([A-Z0-9][A-Za-z0-9&. -]{1,35})$/i);
    if (dashMatch) {
      const c = cleanCandidate(dashMatch[1]);
      if (c) rawCandidates.push(c);
    }
    const reverseDash = trimmedLine.match(/^([A-Z0-9][A-Za-z0-9&. -]{1,35})\s*[-–—|•·]\s*(?:.*?\b(?:engineer|developer|manager|lead|architect|designer|scientist|intern)\b.*?)$/i);
    if (reverseDash) {
      const c = cleanCandidate(reverseDash[1]);
      if (c) rawCandidates.push(c);
    }
  }

  // 3. High-confidence intro patterns: About <Company>, At <Company>, Join <Company>, Life at <Company>
  const introRegex = /(?:^|\n|\.\s+)(?:About|Join|Why|Welcome to|Working at|Life at|Careers at|At)\s+([A-Z0-9][A-Za-z0-9&. -]{1,40}?)(?=[,\n\r.!]|\s+(?:is|we|our|are|was|builds|helps|to|for|on)\b)/g;
  let im;
  while ((im = introRegex.exec(cleanText)) !== null) {
    const cleaned = cleanCandidate(im[1]);
    if (cleaned) rawCandidates.push(cleaned);
  }

  // 4. '<Company> is looking for', '<Company> is seeking', '<Company> is hiring', '<Company> builds'
  const seekingRegex = /(?:^|\n|\.\s+)([A-Z0-9][A-Za-z0-9&. -]{1,40}?)\s+is\s+(?:looking\s+for|seeking|hiring|building|revolutionizing|transforming)\b/gi;
  let sm;
  while ((sm = seekingRegex.exec(cleanText)) !== null) {
    const cleaned = cleanCandidate(sm[1]);
    if (cleaned) rawCandidates.push(cleaned);
  }

  // 5. 'joining <Company>', 'role at <Company>', 'opportunity with <Company>'
  const joiningRegex = /\b(?:joining|role at|position at|opportunity with|career at|team at)\s+([A-Z0-9][A-Za-z0-9&. -]{1,35}?)(?=[,\n\r.!]|\s+(?:team|as|in|where|to)\b)/gi;
  let jm;
  while ((jm = joiningRegex.exec(cleanText)) !== null) {
    const cleaned = cleanCandidate(jm[1]);
    if (cleaned) rawCandidates.push(cleaned);
  }

  // 6. '<Company> overview', '<Company> careers', '<Company> team'
  const overviewRegex = /(?:^|\n|\.\s+)([A-Z0-9][A-Za-z0-9&. -]{1,40}?)\s+(?:overview|careers|team)\b/gi;
  let om;
  while ((om = overviewRegex.exec(cleanText)) !== null) {
    const cleaned = cleanCandidate(om[1]);
    if (cleaned) rawCandidates.push(cleaned);
  }

  // 7. Domain names / URLs in JD (e.g. https://boards.greenhouse.io/stripe or jobs.lever.co/linear or apply@stripe.com)
  const urlRegex = /(?:https?:\/\/)?(?:careers\.|jobs\.|boards\.)?([a-zA-Z0-9-]+)\.(?:greenhouse\.io|lever\.co|workable\.com|ashbyhq\.com)/gi;
  let um;
  while ((um = urlRegex.exec(cleanText)) !== null) {
    const name = um[1].charAt(0).toUpperCase() + um[1].slice(1).toLowerCase();
    const cleaned = cleanCandidate(name);
    if (cleaned) rawCandidates.push(cleaned);
  }

  // 8. Ambiguity / multiple candidates patterns: 'formerly Google, Meta', 'clients include Microsoft, Apple'
  const multiRegex = /(?:formerly|clients include|clients such as|partners include|alumni from)\s+([^\n\r.]+)/gi;
  let mm;
  while ((mm = multiRegex.exec(cleanText)) !== null) {
    const parts = mm[1].split(/,\s*|\s+and\s+/);
    for (const part of parts) {
      const cleaned = cleanCandidate(part);
      if (cleaned) rawCandidates.push(cleaned);
    }
  }

  // Deduplicate case-insensitively, preserving original casing of first occurrence
  const uniqueCandidates = [];
  const seen = new Set();
  for (const c of rawCandidates) {
    const lower = c.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      uniqueCandidates.push(c);
    }
  }

  if (uniqueCandidates.length === 0) {
    return { company: null, candidates: [], ambiguous: false };
  }

  if (uniqueCandidates.length === 1) {
    return { company: uniqueCandidates[0], candidates: uniqueCandidates, ambiguous: false };
  }

  return {
    company: uniqueCandidates[0],
    candidates: uniqueCandidates,
    ambiguous: true
  };
}

/**
 * extractCompanyWithLLM({ jdText, llm, timeoutMs })
 * Uses the active LLM to analyze the entire job description context and accurately
 * identify the hiring company name. Falls back to extractCompanyFromJD on error/timeout.
 */
async function extractCompanyWithLLM({ jdText, llm, timeoutMs = 4000 } = {}) {
  if (!jdText || typeof jdText !== 'string' || !jdText.trim()) {
    return { company: null, candidates: [], ambiguous: false };
  }

  // First try fast heuristics
  const heuristic = extractCompanyFromJD(jdText);
  if (heuristic.company && !heuristic.ambiguous) {
    return heuristic;
  }

  // If heuristic failed or was ambiguous, use the LLM to analyze the entire context
  if (llm && typeof llm.stream === 'function' && llm.ready) {
    try {
      const sample = jdText.trim().slice(0, 3500);
      const prompt = `Analyze this Job Description and identify the company offering the job.

Job Description:
"""
${sample}
"""

Respond in RAW JSON ONLY (no markdown formatting, no other text):
{
  "company": "<Hiring Company Name, or null if unmentioned>",
  "candidates": ["<Hiring Company Name>"],
  "ambiguous": false
}`;

      let output = '';
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs));
      const streamPromise = llm.stream({
        system: 'You are an expert recruiter and job analyst. Analyze the full context of job descriptions to extract the exact hiring company name. Return only a raw JSON object.',
        turns: [{ role: 'user', text: prompt }],
        onToken: (t) => { output += t; }
      });

      await Promise.race([streamPromise, timeoutPromise]);
      const jsonStr = output.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(jsonStr);

      if (parsed && typeof parsed.company === 'string' && parsed.company.trim()) {
        const c = cleanCandidate(parsed.company);
        if (c) {
          const rawCands = Array.isArray(parsed.candidates) && parsed.candidates.length > 0
            ? parsed.candidates.map(cleanCandidate).filter(Boolean)
            : [c];
          return {
            company: c,
            candidates: rawCands.length ? rawCands : [c],
            ambiguous: Boolean(parsed.ambiguous && rawCands.length > 1)
          };
        }
      }
    } catch {
      // Fall through to heuristic result
    }
  }

  return heuristic;
}

/**
 * isSearchProviderConfigured(provider, settings)
 */
function isSearchProviderConfigured(provider, settings) {
  if (!settings) return false;
  if (provider === 'gemini') {
    return Boolean(settings.apiKeys?.gemini && String(settings.apiKeys.gemini).trim());
  }
  if (provider === 'vertex') {
    const hasKey = Boolean(settings.apiKeys?.vertex && String(settings.apiKeys.vertex).trim());
    const hasProject = Boolean(settings.vertexProject && String(settings.vertexProject).trim());
    return hasKey || hasProject;
  }
  if (provider === 'antigravity') {
    if (settings.antigravityStatus && settings.antigravityStatus.authenticated) return true;
    try {
      const { getAntigravityStatus } = require('./antigravity');
      const status = getAntigravityStatus(settings.oauthStorageOptions);
      return Boolean(status && status.authenticated);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * getProviderSmartModel(provider, settings)
 */
function getProviderSmartModel(provider, settings) {
  const models = settings && settings.models;
  if (provider === 'gemini') {
    return models?.gemini?.smart || 'gemini-3.1-pro-preview';
  }
  if (provider === 'vertex') {
    return models?.vertex?.smart || 'gemini-4-argon';
  }
  if (provider === 'antigravity') {
    return models?.antigravity?.smart || 'gemini-3.1-pro-high';
  }
  return null;
}

/**
 * resolveResearchProvider(settings)
 * Returns { provider, model } or null.
 */
function resolveResearchProvider(settings) {
  if (!settings) return null;
  const active = settings.provider;

  if (['gemini', 'vertex', 'antigravity'].includes(active) && isSearchProviderConfigured(active, settings)) {
    return {
      provider: active,
      model: getProviderSmartModel(active, settings)
    };
  }

  const searchCapable = ['gemini', 'vertex', 'antigravity'];
  for (const p of searchCapable) {
    if (isSearchProviderConfigured(p, settings)) {
      return {
        provider: p,
        model: getProviderSmartModel(p, settings)
      };
    }
  }

  return null;
}

/**
 * parseGroundingMetadata(metadata)
 * Parses citations from Google Search grounding metadata across Gemini/Vertex/Antigravity response shapes.
 * Returns array of { title, url }.
 */
function parseGroundingMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return [];

  const data = metadata.groundingMetadata || metadata;
  const citations = [];
  const seenUrls = new Set();

  function addCitation(url, title) {
    if (!url || typeof url !== 'string') return;
    const cleanUrl = url.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) return;
    const norm = cleanUrl.toLowerCase().replace(/\/+$/, '');
    if (seenUrls.has(norm)) return;
    seenUrls.add(norm);

    let cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (!cleanTitle) {
      try {
        cleanTitle = new URL(cleanUrl).hostname;
      } catch {
        cleanTitle = cleanUrl;
      }
    }
    citations.push({ title: cleanTitle, url: cleanUrl });
  }

  // 1. groundingChunks
  if (Array.isArray(data.groundingChunks)) {
    for (const chunk of data.groundingChunks) {
      if (!chunk) continue;
      const web = chunk.web || chunk;
      const url = web.uri || web.url;
      const title = web.title || chunk.title;
      addCitation(url, title);
    }
  }

  // 2. citations direct array
  if (Array.isArray(data.citations)) {
    for (const c of data.citations) {
      if (!c) continue;
      addCitation(c.url || c.uri, c.title);
    }
  }

  // 3. searchEntryPoint renderedContent HTML links
  if (data.searchEntryPoint && typeof data.searchEntryPoint.renderedContent === 'string') {
    const linkRe = /<a\s+[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>(.*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(data.searchEntryPoint.renderedContent)) !== null) {
      const url = m[1];
      const rawTitle = m[2].replace(/<[^>]+>/g, '').trim();
      addCitation(url, rawTitle);
    }
  }

  return citations;
}

/**
 * extractNotesForCompany(meetingsStoreOrNotes, companyName)
 * Extracts mentions of companyName bounded to ~1000 characters.
 */
function extractNotesForCompany(meetingsStoreOrNotes, companyName) {
  if (!meetingsStoreOrNotes || !companyName || typeof companyName !== 'string') return '';
  const needle = companyName.trim().toLowerCase();
  if (!needle) return '';

  const MAX_CHARS = 1000;

  if (typeof meetingsStoreOrNotes === 'string') {
    const raw = meetingsStoreOrNotes.trim();
    if (!raw.toLowerCase().includes(needle)) return '';
    if (raw.length <= MAX_CHARS) return raw;
    const sentences = raw.split(/(?<=[.!?\n])\s+/);
    const matching = [];
    let length = 0;
    for (const s of sentences) {
      if (s.toLowerCase().includes(needle)) {
        if (length + s.length > MAX_CHARS) {
          const rem = Math.max(0, MAX_CHARS - length);
          if (rem > 20) matching.push(s.slice(0, rem).trimEnd() + '…');
          break;
        }
        matching.push(s);
        length += s.length;
      }
    }
    return matching.join(' ').trim();
  }

  let meetings = [];
  if (typeof meetingsStoreOrNotes.search === 'function') {
    meetings = meetingsStoreOrNotes.search(needle) || [];
  } else if (typeof meetingsStoreOrNotes.all === 'function') {
    meetings = (meetingsStoreOrNotes.all() || []).filter((m) => {
      const str = [m.title, m.summary, ...(m.actionItems || []), ...(m.transcript || []).map(t => t.text)].join(' ');
      return str.toLowerCase().includes(needle);
    });
  } else if (Array.isArray(meetingsStoreOrNotes)) {
    meetings = meetingsStoreOrNotes;
  }

  if (!meetings.length) return '';

  const excerpts = [];
  let remaining = MAX_CHARS;

  for (const m of meetings) {
    if (remaining <= 30) break;
    const pieces = [];
    if (m.title && m.title.toLowerCase().includes(needle)) pieces.push(`[${m.title}]`);
    else if (m.title) pieces.push(`[${m.title}]`);
    if (m.summary) pieces.push(m.summary);
    if (Array.isArray(m.actionItems)) {
      const matchingItems = m.actionItems.filter(item => String(item).toLowerCase().includes(needle));
      if (matchingItems.length) pieces.push(`Action items: ${matchingItems.join('; ')}`);
    }
    if (Array.isArray(m.transcript)) {
      const matchingTurns = m.transcript.filter(t => String(t.text || '').toLowerCase().includes(needle));
      for (const t of matchingTurns) {
        pieces.push(`${t.channel || 'turn'}: "${t.text}"`);
      }
    }
    const combined = pieces.join(' — ');
    if (combined) {
      if (combined.length > remaining) {
        excerpts.push(combined.slice(0, remaining).trimEnd() + '…');
        break;
      }
      excerpts.push(combined);
      remaining -= combined.length;
    }
  }

  return excerpts.join('\n\n').slice(0, MAX_CHARS).trim();
}

/**
 * buildDossierPrompt(companyName, jdText)
 */
function buildDossierPrompt(companyName, jdText) {
  const jdExcerpt = jdText && typeof jdText === 'string' && jdText.trim()
    ? `\nTarget Role / Job Description excerpt:\n${jdText.trim().slice(0, 1500)}\n`
    : '';

  return `Conduct research on the company "${companyName}" and provide a concise, structured interview briefing based on live web search.

${jdExcerpt}
You MUST format your response using EXACTLY these 6 section headings:

Overview:
[Brief overview of ${companyName}, founding, mission, scale, and headquarters]

What They Do:
[Core products, services, target audience, and business model]

Recent News:
[Major news, product launches, funding, leadership changes, or announcements from the past 6-12 months]

Culture and Values:
[Engineering culture, operating principles, core company values, and work environment]

Likely Interview Topics:
[Key technical and behavioral topics commonly emphasized in interviews at ${companyName}]

Questions to Ask Them:
[3-5 thoughtful, high-signal questions for the candidate to ask interviewers at ${companyName}]`;
}

/**
 * parseDossierSections(responseText)
 * Extracts the 6 headings into a dictionary. Any missing section gets 'Unknown'.
 */
function parseDossierSections(responseText) {
  const defaults = {
    overview: 'Unknown',
    whatTheyDo: 'Unknown',
    recentNews: 'Unknown',
    cultureValues: 'Unknown',
    likelyTopics: 'Unknown',
    questionsToAsk: 'Unknown'
  };
  if (!responseText || typeof responseText !== 'string') return defaults;

  const sectionKeys = [
    { key: 'overview', re: /(?:^|\n)[#* \t\d.-]*(?:Overview)\s*:?[ \t]*\n?/i },
    { key: 'whatTheyDo', re: /(?:^|\n)[#* \t\d.-]*(?:What\s+They\s+Do)\s*:?[ \t]*\n?/i },
    { key: 'recentNews', re: /(?:^|\n)[#* \t\d.-]*(?:Recent\s+News)\s*:?[ \t]*\n?/i },
    { key: 'cultureValues', re: /(?:^|\n)[#* \t\d.-]*(?:Culture\s+(?:and|&)\s+Values)\s*:?[ \t]*\n?/i },
    { key: 'likelyTopics', re: /(?:^|\n)[#* \t\d.-]*(?:Likely\s+Interview\s+Topics?)\s*:?[ \t]*\n?/i },
    { key: 'questionsToAsk', re: /(?:^|\n)[#* \t\d.-]*(?:Questions\s+to\s+Ask(?:\s+Them)?)\s*:?[ \t]*\n?/i }
  ];

  const matches = [];
  for (const { key, re } of sectionKeys) {
    const m = re.exec(responseText);
    if (m) {
      matches.push({ key, index: m.index, matchLength: m[0].length });
    }
  }

  matches.sort((a, b) => a.index - b.index);

  const sections = { ...defaults };
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const startIndex = cur.index + cur.matchLength;
    const endIndex = (i + 1 < matches.length) ? matches[i + 1].index : responseText.length;
    const content = responseText.slice(startIndex, endIndex).trim();
    if (content) {
      sections[cur.key] = content;
    }
  }

  return sections;
}

/**
 * generateCompanyDossier({ companyName, jdText, settings, meetingsStore, llmFactory, fetchImpl, onToken })
 */
async function generateCompanyDossier({ companyName, jdText = '', settings = {}, meetingsStore = null, llmFactory = null, fetchImpl = fetch, onToken = null } = {}) {
  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    throw new Error('companyName is required to generate a dossier.');
  }

  const cleanCompany = companyName.trim();
  const notesExcerpt = extractNotesForCompany(meetingsStore, cleanCompany);
  const providerInfo = resolveResearchProvider(settings);

  if (!providerInfo) {
    return {
      company: cleanCompany,
      isNotesOnly: true,
      isGrounded: false,
      sections: {
        overview: 'No research-capable provider configured (configure Gemini or Vertex in Settings to enable live Google Search research).',
        whatTheyDo: 'Unknown',
        recentNews: 'Unknown (web research not configured)',
        cultureValues: 'Unknown',
        likelyTopics: 'Unknown',
        questionsToAsk: 'Unknown'
      },
      notesExcerpt,
      citations: [],
      lastUpdated: Date.now()
    };
  }

  const prompt = buildDossierPrompt(cleanCompany, jdText);

  const researchSettings = {
    ...settings,
    provider: providerInfo.provider,
    smart: true,
    geminiWebSearch: true,
    vertexWebSearch: true,
    antigravityWebSearch: true,
    models: {
      ...(settings.models || {}),
      [providerInfo.provider]: {
        ...((settings.models && settings.models[providerInfo.provider]) || {}),
        smart: providerInfo.model
      }
    }
  };

  const factory = llmFactory || ((s) => {
    const { createLLM } = require('./llm');
    return createLLM(s, fetchImpl);
  });

  const llm = factory(researchSettings);

  let capturedMetadata = null;
  let tokenAccumulator = '';
  const streamResult = await llm.stream({
    system: 'You are an executive research briefing analyst preparing structured company intelligence dossiers for job interviews.',
    turns: [{ role: 'user', text: prompt }],
    tools: [{ googleSearch: {} }],
    webSearch: true,
    onToken: (t) => {
      tokenAccumulator += t;
      if (typeof onToken === 'function') onToken(t);
    },
    onGroundingMetadata: (meta) => {
      capturedMetadata = meta;
    },
    onMetadata: (meta) => {
      capturedMetadata = meta;
    }
  });

  const responseText = (typeof streamResult === 'string' && streamResult.trim())
    ? streamResult
    : (streamResult && (streamResult.text || streamResult.fullText)) || tokenAccumulator;

  const metadata = capturedMetadata || (streamResult && (streamResult.metadata || streamResult.groundingMetadata)) || null;
  const citations = parseGroundingMetadata(metadata);
  const sections = parseDossierSections(responseText);

  return {
    company: cleanCompany,
    isNotesOnly: false,
    isGrounded: citations.length > 0,
    sections,
    citations,
    notesExcerpt,
    lastUpdated: Date.now()
  };
}

/**
 * formatDossierForPrompt(dossier)
 */
function formatDossierForPrompt(dossier) {
  if (!dossier || !dossier.company) return '';
  const sec = dossier.sections || {};
  const lines = [
    `=== Company Dossier: ${dossier.company} ===`
  ];
  if (sec.overview && sec.overview !== 'Unknown') {
    lines.push(`Overview: ${sec.overview}`);
  }
  if (sec.whatTheyDo && sec.whatTheyDo !== 'Unknown') {
    lines.push(`What they do: ${sec.whatTheyDo}`);
  }
  if (sec.cultureValues && sec.cultureValues !== 'Unknown') {
    lines.push(`Culture & Values: ${sec.cultureValues}`);
  }
  if (sec.likelyTopics && sec.likelyTopics !== 'Unknown') {
    lines.push(`Likely Topics: ${sec.likelyTopics}`);
  }
  if (dossier.notesExcerpt && dossier.notesExcerpt.trim()) {
    lines.push(`From your notes: ${dossier.notesExcerpt.trim()}`);
  }
  return lines.join('\n');
}

module.exports = {
  extractCompanyFromJD,
  extractCompanyWithLLM,
  resolveResearchProvider,
  parseGroundingMetadata,
  extractNotesForCompany,
  buildDossierPrompt,
  parseDossierSections,
  generateCompanyDossier,
  formatDossierForPrompt
};
