'use strict';

/**
 * src/claim-verifier.js
 *
 * Post-generation verification for candidate facts/credentials.
 * Extracts specific candidate claims (companies, roles, dates, metrics, technologies)
 * and verifies them against the user's profile (resumeText, starStories).
 */

const KNOWN_COMPANIES = [
  'Google', 'Apple', 'Meta', 'Facebook', 'Amazon', 'Netflix', 'Microsoft',
  'Stripe', 'Uber', 'Airbnb', 'Twitter', 'Datadog', 'Snowflake', 'Salesforce',
  'Coinbase', 'Robinhood', 'Palantir', 'Oracle', 'Cisco', 'IBM', 'Intel', 'NVIDIA'
];

const KNOWN_ROLES = [
  'Senior Software Engineer', 'Staff Software Engineer', 'Staff Engineer',
  'Principal Software Engineer', 'Principal Engineer', 'Senior Engineer',
  'Software Engineer', 'Systems Engineer', 'Backend Engineer', 'Frontend Engineer',
  'Full-Stack Engineer', 'Full Stack Engineer', 'DevOps Engineer', 'Site Reliability Engineer',
  'Engineering Manager', 'Tech Lead', 'VP of Engineering', 'Director of Engineering',
  'Chief Technology Officer', 'CTO', 'Solutions Architect', 'Cloud Architect',
  'Product Manager', 'Data Scientist', 'Data Engineer', 'Machine Learning Engineer'
];

const KNOWN_TECHS = [
  'Kafka', 'Redis', 'PostgreSQL', 'Postgres', 'MySQL', 'MongoDB', 'Cassandra',
  'DynamoDB', 'Elasticsearch', 'Kubernetes', 'Docker', 'AWS', 'GCP', 'Azure',
  'React', 'Node.js', 'Go', 'Golang', 'Python', 'Java', 'Rust', 'C++',
  'TypeScript', 'GraphQL', 'gRPC', 'Terraform', 'RabbitMQ', 'CockroachDB'
];

/**
 * extractCandidateClaims(answerText)
 * Extracts candidate claims: employers/companies, role titles, employment date ranges,
 * specific metrics, technologies or project achievements claimed.
 */
function extractCandidateClaims(answerText) {
  if (!answerText || typeof answerText !== 'string') {
    const empty = [];
    empty.companies = [];
    empty.roles = [];
    empty.dateRanges = [];
    empty.metrics = [];
    empty.technologies = [];
    empty.achievements = [];
    return empty;
  }

  const text = answerText.trim();
  const claims = [];
  const companies = [];
  const roles = [];
  const dateRanges = [];
  const metrics = [];
  const technologies = [];
  const achievements = [];

  // 1. Metrics: Percentages, dollar values, large scale quantities, latencies, team sizes
  const percentRe = /(?:\+|-)?\b\d+(?:\.\d+)?%/g;
  let pm;
  while ((pm = percentRe.exec(text)) !== null) {
    const val = pm[0];
    metrics.push(val);
    claims.push({ type: 'metric', claim: val, text: val });
  }

  const dollarRe = /\$\d+(?:\.\d+)?\s*(?:k|m|b|million|billion)?\b/gi;
  let dm;
  while ((dm = dollarRe.exec(text)) !== null) {
    const val = dm[0];
    metrics.push(val);
    claims.push({ type: 'metric', claim: val, text: val });
  }

  const scaleRe = /\b\d+(?:\.\d+)?\s*(?:k|m|b|million|billion)\s+(?:users|requests|queries|events|qps|rps|dau|mau|records|nodes)\b/gi;
  let sm;
  while ((sm = scaleRe.exec(text)) !== null) {
    const val = sm[0];
    metrics.push(val);
    claims.push({ type: 'metric', claim: val, text: val });
  }

  const latencyRe = /\b\d+(?:\.\d+)?\s*(?:ms|seconds|minutes)\b/gi;
  let lm;
  while ((lm = latencyRe.exec(text)) !== null) {
    const val = lm[0];
    metrics.push(val);
    claims.push({ type: 'metric', claim: val, text: val });
  }

  const teamRe = /\bteam\s+of\s+\d+\b/gi;
  let tm;
  while ((tm = teamRe.exec(text)) !== null) {
    const val = tm[0];
    metrics.push(val);
    claims.push({ type: 'metric', claim: val, text: val });
  }

  // 2. Roles
  for (const role of KNOWN_ROLES) {
    const escaped = role.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const roleRe = new RegExp(`\\b${escaped}\\b`, 'i');
    if (roleRe.test(text)) {
      roles.push(role);
      claims.push({ type: 'role', claim: role, text: role });
    }
  }

  // 3. Date ranges / Durations
  const dateRangeRe = /\b(?:from\s+)?(20\d\d|19\d\d)\s*(?:-|to|through|until)\s*(20\d\d|present|now)\b/gi;
  let drm;
  while ((drm = dateRangeRe.exec(text)) !== null) {
    const val = drm[0];
    dateRanges.push(val);
    claims.push({ type: 'dateRange', claim: val, text: val });
  }

  const durationRe = /\b(?:for|over|nearly|about)\s+(\d+|\w+)\s+(?:years?|months?)\b/gi;
  let durm;
  while ((durm = durationRe.exec(text)) !== null) {
    const val = durm[0];
    dateRanges.push(val);
    claims.push({ type: 'dateRange', claim: val, text: val });
  }

  // 4. Employers / Companies
  const companyPattern = /(?:^|\b)(?:at|for|joined|with)\s+([A-Z][A-Za-z0-9&]+(?:\s+[A-Z][A-Za-z0-9&]+){0,2})(?=[,\s.!?]|$)/gi;
  let cm;
  const genericWords = new Set(['the', 'our', 'my', 'this', 'that', 'a', 'an', 'some', 'work', 'scale', 'high', 'low', 'least', 'most', 'first', 'last']);
  while ((cm = companyPattern.exec(text)) !== null) {
    const rawComp = cm[1].trim();
    if (rawComp && !genericWords.has(rawComp.toLowerCase()) && rawComp.length > 1) {
      if (!companies.includes(rawComp)) {
        companies.push(rawComp);
        claims.push({ type: 'company', claim: rawComp, text: rawComp });
      }
    }
  }

  // Also match known companies directly if mentioned
  for (const comp of KNOWN_COMPANIES) {
    const escaped = comp.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const compRe = new RegExp(`\\b${escaped}\\b`, 'i');
    if (compRe.test(text) && !companies.some(c => c.toLowerCase() === comp.toLowerCase())) {
      companies.push(comp);
      claims.push({ type: 'company', claim: comp, text: comp });
    }
  }

  // 5. Technologies
  for (const tech of KNOWN_TECHS) {
    const escaped = tech.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const techRe = new RegExp(`\\b${escaped}\\b`, 'i');
    if (techRe.test(text)) {
      technologies.push(tech);
      claims.push({ type: 'technology', claim: tech, text: tech });
    }
  }

  // 6. Achievements
  const achievementRe = /\b(?:architected|built|migrated|scaled|optimized|decreased|increased|shipped)\s+[^,.?!]{5,50}/gi;
  let am;
  while ((am = achievementRe.exec(text)) !== null) {
    const val = am[0].trim();
    achievements.push(val);
    claims.push({ type: 'achievement', claim: val, text: val });
  }

  claims.companies = companies;
  claims.roles = roles;
  claims.dateRanges = dateRanges;
  claims.metrics = metrics;
  claims.technologies = technologies;
  claims.achievements = achievements;

  return claims;
}

/**
 * verifyClaims({ answerText, profile, fastLLM, timeoutMs, enabled, screenshot })
 *
 * Post-generation verification for candidate facts/credentials.
 * Never alters the generated answer text; returns { ok: boolean, flaggedClaims: [...], corrections: [...] }.
 */
async function verifyClaims({
  answerText = '',
  profile = {},
  fastLLM = null,
  timeoutMs = 3500,
  enabled = true,
  screenshot = null
} = {}) {
  // If claimValidator setting is disabled (default off), return immediately without LLM call
  if (!enabled) {
    return { enabled: false, ok: true, claims: [] };
  }

  const effectiveTimeout = screenshot ? Math.max(timeoutMs, 6000) : timeoutMs;
  const claims = extractCandidateClaims(answerText);

  if (!claims || claims.length === 0) {
    return { ok: true, claims: [], flaggedClaims: [], corrections: [] };
  }

  const resumeText = profile.resumeText || '';
  const starStories = profile.starStories || '';
  const profileCorpus = `${resumeText}\n${starStories}`.toLowerCase();

  // Try LLM verification if fastLLM is provided
  if (fastLLM) {
    try {
      const promptText = `
Candidate Profile:
Resume:
${resumeText || '(No resume text provided)'}

STAR Stories:
${starStories || '(No STAR stories provided)'}

Candidate Answer:
${answerText}

Extracted Candidate Claims to Verify:
${claims.map(c => `- [${c.type}] ${c.claim}`).join('\n')}

Verify whether each claim is backed by the Candidate Profile.
Return valid JSON only in this exact format:
{
  "ok": true/false,
  "flaggedClaims": [
    { "claim": "claim string", "type": "company|role|metric|dateRange|technology", "reason": "why unverified" }
  ],
  "corrections": [
    { "original": "original claim", "correction": "suggested verified alternative" }
  ]
}
`.trim();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);

      let responseText = '';
      try {
        if (typeof fastLLM.stream === 'function') {
          await fastLLM.stream({
            system: 'You are an objective credential verification assistant. Return JSON only.',
            turns: [{ role: 'user', text: promptText }],
            signal: controller.signal,
            onToken: (t) => { responseText += t; }
          });
        } else if (typeof fastLLM.complete === 'function') {
          const res = await fastLLM.complete({
            system: 'You are an objective credential verification assistant. Return JSON only.',
            turns: [{ role: 'user', text: promptText }],
            signal: controller.signal
          });
          responseText = typeof res === 'string' ? res : (res && res.text) || '';
        } else if (typeof fastLLM === 'function') {
          const res = await fastLLM({ prompt: promptText, signal: controller.signal });
          responseText = typeof res === 'string' ? res : (res && res.text) || '';
        }
      } finally {
        clearTimeout(timer);
      }

      // Parse LLM response
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            ok: Array.isArray(parsed.flaggedClaims) ? parsed.flaggedClaims.length === 0 : Boolean(parsed.ok),
            claims,
            flaggedClaims: Array.isArray(parsed.flaggedClaims) ? parsed.flaggedClaims : [],
            corrections: Array.isArray(parsed.corrections) ? parsed.corrections : []
          };
        }
      }
    } catch (_) {
      // On LLM failure or timeout, fall back to deterministic comparison below
    }
  }

  // Deterministic fallback comparison against profile text
  const flaggedClaims = [];
  const corrections = [];

  // Check metrics
  for (const m of claims.metrics) {
    if (profileCorpus && !profileCorpus.includes(m.toLowerCase())) {
      flaggedClaims.push({
        claim: m,
        type: 'metric',
        reason: `Metric "${m}" not found in candidate resume or STAR stories`
      });
      corrections.push({
        original: m,
        correction: 'Omit specific unverified metric or use verified metric from resume'
      });
    }
  }

  // Check companies
  for (const c of claims.companies) {
    if (profileCorpus && !profileCorpus.includes(c.toLowerCase())) {
      flaggedClaims.push({
        claim: c,
        type: 'company',
        reason: `Company "${c}" not found in candidate profile credentials`
      });
      corrections.push({
        original: c,
        correction: 'Ensure company name aligns with resume experience'
      });
    }
  }

  // Check roles
  for (const r of claims.roles) {
    if (profileCorpus && !profileCorpus.includes(r.toLowerCase())) {
      flaggedClaims.push({
        claim: r,
        type: 'role',
        reason: `Role "${r}" not found in candidate profile credentials`
      });
      corrections.push({
        original: r,
        correction: 'Use verified title from resume'
      });
    }
  }

  return {
    ok: flaggedClaims.length === 0,
    claims,
    flaggedClaims,
    corrections
  };
}

module.exports = {
  verifyClaims,
  extractCandidateClaims
};
