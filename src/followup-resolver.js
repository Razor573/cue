'use strict';

/**
 * src/followup-resolver.js
 *
 * Deterministic (ZERO LLM calls, <1ms) follow-up question resolver.
 * Disambiguates short or ambiguous follow-ups against recent transcript context
 * before dispatching to the LLM.
 */

const DEMONSTRATIVE_RE = /\b(that|it|this|those|such|the same)\b/i;

const COMMON_QUESTION_WRAPPERS = [
  /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:tell\s+(?:me|us)\s+about|explain|describe|walk\s+(?:me|us)\s+through|talk\s+about|discuss)\s+/i,
  /^(?:tell\s+(?:me|us)\s+about|walk\s+(?:me|us)\s+through|talk\s+about|describe|explain|discuss)\s+/i,
  /^(?:how\s+did\s+you|how\s+do\s+you|how\s+would\s+you)\s+(?:handle|approach|design|build|implement|solve|optimize|scale|architect|manage|deal\s+with)\s+/i,
  /^(?:what\s+was\s+your|what\s+is\s+your)\s+(?:approach\s+to|experience\s+with|strategy\s+for|process\s+for)\s+/i,
  /^(?:why\s+did\s+you\s+(?:choose|pick|use|decide\s+to\s+use|go\s+with|select))\s+/i,
  /^(?:let's\s+talk\s+about|let's\s+discuss|moving\s+on\s+to|going\s+back\s+to|regarding)\s+/i,
  /^(?:what\s+are\s+your\s+thoughts\s+on|what\s+do\s+you\s+think\s+about)\s+/i,
  /^(?:have\s+you\s+worked\s+with|do\s+you\s+have\s+experience\s+with)\s+/i,
  /^(?:what\s+about|how\s+about)\s+/i,
  /^(?:so\s+)?(?:how\s+did|how\s+do|what\s+was|what\s+is|why\s+did|why\s+do)\s+(?:you\s+)?/i
];

const SECONDARY_QUALIFIERS = [
  /^(?:your\s+experience\s+with|a\s+time\s+(?:when\s+)?you|the\s+way\s+you|how\s+you)\s+/i
];

const FILLERS_AND_STARTERS = /^(?:well|so|ok|okay|now|and|then|great|thanks|alright)[,\s]+/i;

/**
 * isBareFollowUp(text)
 * Detects demonstrative pronouns ("that", "it", "this", "those", "such", "the same")
 * or bare short questions (< 6 words).
 */
function isBareFollowUp(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (DEMONSTRATIVE_RE.test(trimmed)) {
    return true;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.length < 6) {
    return true;
  }

  return false;
}

/**
 * Clean and extract a candidate subject from a text string.
 */
function extractSubjectFromText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  let text = rawText.trim();
  if (!text) return null;

  // If text has multiple sentences, focus on the last sentence if it is a question or summary
  const sentences = text.split(/(?<=[.?!])\s+/).filter(Boolean);
  if (sentences.length > 1) {
    const last = sentences[sentences.length - 1].trim();
    if (/[?]/.test(last) || last.length > 10) {
      text = last;
    }
  }

  // Strip leading greetings/fillers
  text = text.replace(FILLERS_AND_STARTERS, '').trim();

  // Strip question wrapper patterns
  for (const wrapper of COMMON_QUESTION_WRAPPERS) {
    if (wrapper.test(text)) {
      text = text.replace(wrapper, '').trim();
      break;
    }
  }

  // Strip secondary qualifiers like "your experience with"
  for (const qualifier of SECONDARY_QUALIFIERS) {
    if (qualifier.test(text)) {
      text = text.replace(qualifier, '').trim();
      break;
    }
  }

  // Strip trailing punctuation
  text = text.replace(/[?.!]+$/, '').trim();

  // Strip leading articles
  text = text.replace(/^(?:the|a|an)\s+/i, '').trim();

  if (!text || text.length < 2) return null;

  // Bound to sensible topic length (~10 words max)
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 10) {
    text = words.slice(0, 10).join(' ');
  }

  return text;
}

/**
 * extractSubject(input)
 * Extracts subject/topic of the prior question from transcriptTurns
 * (preferring interviewer 'them' turns, else candidate 'you' turns),
 * or directly from a turn object or raw string.
 */
function extractSubject(input) {
  if (!input) return null;

  if (typeof input === 'string') {
    return extractSubjectFromText(input);
  }

  if (Array.isArray(input)) {
    if (input.length === 0) return null;

    // Prefer interviewer 'them' turns (search backwards)
    for (let i = input.length - 1; i >= 0; i--) {
      const turn = input[i];
      const channel = turn && (turn.channel || turn.speaker || turn.role);
      const text = turn && (typeof turn.text === 'string' ? turn.text : turn.content);
      if (channel === 'them' || channel === 'interviewer') {
        const subject = extractSubjectFromText(text);
        if (subject) return subject;
      }
    }

    // Fall back to candidate 'you' turns (search backwards)
    for (let i = input.length - 1; i >= 0; i--) {
      const turn = input[i];
      const channel = turn && (turn.channel || turn.speaker || turn.role);
      const text = turn && (typeof turn.text === 'string' ? turn.text : turn.content);
      if (channel === 'you' || channel === 'candidate') {
        const subject = extractSubjectFromText(text);
        if (subject) return subject;
      }
    }

    // If neither channel matched explicitly, check any turn from end
    for (let i = input.length - 1; i >= 0; i--) {
      const turn = input[i];
      const text = turn && (typeof turn.text === 'string' ? turn.text : turn.content);
      const subject = extractSubjectFromText(text);
      if (subject) return subject;
    }

    return null;
  }

  if (typeof input === 'object') {
    const text = input.text || input.content || '';
    return extractSubjectFromText(text);
  }

  return null;
}

/**
 * resolveFollowUp(question, transcriptTurns, options)
 *
 * Resolves short or ambiguous follow-ups against recent transcript context.
 * Returns { resolved: string, original: string, modified: boolean, confidence: number }.
 * If confidence < threshold or no match, returns original question unmodified with confidence 0.
 */
function resolveFollowUp(question, transcriptTurns = [], options = {}) {
  const original = typeof question === 'string' ? question : '';
  const threshold = typeof options.confidenceThreshold === 'number' ? options.confidenceThreshold : 0.5;

  if (!isBareFollowUp(original)) {
    return { resolved: original, original, modified: false, confidence: 0 };
  }

  if (!Array.isArray(transcriptTurns) || transcriptTurns.length === 0) {
    return { resolved: original, original, modified: false, confidence: 0 };
  }

  const subject = extractSubject(transcriptTurns);
  if (!subject) {
    return { resolved: original, original, modified: false, confidence: 0 };
  }

  // Calculate confidence score
  let confidence = 0.75;
  const trimmed = original.trim();

  if (DEMONSTRATIVE_RE.test(trimmed)) {
    confidence += 0.15;
  } else {
    // Bare short ellipsis question (< 6 words)
    confidence += 0.1;
  }

  // Bonus for detailed subject
  if (subject.split(/\s+/).length >= 2) {
    confidence += 0.05;
  }

  confidence = Math.min(1, Math.round(confidence * 100) / 100);

  if (confidence < threshold) {
    return { resolved: original, original, modified: false, confidence: 0 };
  }

  // Construct resolved question
  let resolved = trimmed;
  const directDemonstrativeRe = /\b(that|this|it|those)\b/i;

  if (directDemonstrativeRe.test(trimmed)) {
    // Direct substitution when appropriate: "Why did you do that?" -> "Why did you do database migrations?"
    resolved = trimmed.replace(directDemonstrativeRe, subject);
  } else if (/^such\b/i.test(trimmed) || /\bsuch\s+(?:an?\s+)?(?:approach|solution|method|architecture)\b/i.test(trimmed)) {
    resolved = trimmed.replace(/\bsuch\s+(?:an?\s+)?(?:approach|solution|method|architecture)\b/i, subject);
  } else {
    // Bare questions like "Why?", "How so?", "What about PostgreSQL?", "And scaling?"
    resolved = `Regarding ${subject}: ${trimmed}`;
  }

  return {
    resolved,
    original,
    modified: resolved !== original,
    confidence
  };
}

module.exports = {
  resolveFollowUp,
  isBareFollowUp,
  extractSubject
};
