// transcript-retrieval.js
// Pure-JS deterministic transcript preprocessor, semantic exchange-based chunker,
// and BM25 (k1 = 1.5, b = 0.75) lexical search over transcript chunks and notes.
// No vector store and no embeddings.

const MERGE_GAP_MS = 5000;
const MIN_WORDS = 3;
const TARGET_TOKENS = 300;
const MAX_TOKENS = 400;
const OVERLAP_TARGET_TOKENS = 50;
const DEFAULT_BM25 = Object.freeze({ k1: 1.5, b: 0.75 });

// Pure acknowledgement utterances (dropped when they are the entire segment,
// or stripped when appearing as a leading clause before a comma).
const PURE_ACKNOWLEDGEMENTS = new Set([
  'yeah',
  'yes',
  'yep',
  'yup',
  'no',
  'nope',
  'ok',
  'okay',
  'sure',
  'right',
  'uh huh',
  'uh-huh',
  'mm hmm',
  'mm-hmm',
  'got it',
  'i see',
  'makes sense',
  'sounds good',
  'cool',
  'nice',
  'great',
  'thanks',
  'thank you',
  'alright',
  'all right',
  'exactly',
  'totally',
  'definitely',
  'absolutely',
]);

// Multi-word and single-word filler patterns removed during cleaning.
const MULTI_WORD_FILLERS_RE = /\b(you know|i mean|sort of|kind of|uh-huh|uh huh|mm-hmm|mm hmm)\b[,\s]*/gi;
const SINGLE_WORD_FILLERS_RE = /\b(um+|uh+|er+|ah+|hmm+|hm+|basically|literally|actually|honestly)\b[,\s]*/gi;
const LEADING_LIKE_RE = /^like\s*,\s*/i;
const INLINE_COMMA_LIKE_RE = /,\s*like\s*,/gi;

// Consecutive repeated words: "the the", "I I", "we we" -> single word.
const REPEATED_WORDS_RE = /\b(\w+)(\s+\1)+\b/gi;

// Semantic tagging regexes
const QUESTION_START_RE =
  /^(what|where|when|why|how|who|which|whose|whom|can|could|would|should|will|shall|may|might|do|does|did|is|are|was|were|have|has|had)\b/i;
const QUESTION_PROMPT_RE = /\b(tell me about|walk me through|explain|describe)\b/i;
const QUESTION_TAIL_RE = /\b(any thoughts|what do you think|does that make sense)\b|right\?\s*$/i;

const DECISION_RE =
  /\b(we('ll| will| should| decided| agreed)|let'?s go with|the plan is|decided to|agreed (on|to)|going (to go )?with|settled on|final (call|decision))\b/i;

const ACTION_ITEM_RE =
  /\b(i'?ll|i will|we'?ll|we will|todo|to-do|action item|follow up|follow-up|next step|take care of|make sure to|need to|should probably)\b/i;
const ACTION_VERB_DEADLINE_RE =
  /\b(send|share|schedule|create|update|review|check|look into|set up|write|prepare)\b.*\b(by|before|tomorrow|monday|tuesday|wednesday|thursday|friday|next week|end of day|eod|asap)\b/i;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'for', 'from', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'might', 'more',
  'most', 'my', 'no', 'nor', 'not', 'now', 'of', 'on', 'once', 'only', 'or',
  'other', 'our', 'ours', 'out', 'over', 'own', 'same', 'she', 'should', 'so',
  'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then',
  'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under',
  'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours',
]);

function estimateTokens(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

function normalizeForAckCheck(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[!.,?;:'"()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPureAcknowledgement(text) {
  const norm = normalizeForAckCheck(text);
  if (!norm) return true;
  if (PURE_ACKNOWLEDGEMENTS.has(norm)) return true;
  // Also check if it's a combination of two pure acknowledgements like "yeah, okay" or "sure, sounds good"
  const parts = String(text || '')
    .split(/[,;.!]+/)
    .map((p) => normalizeForAckCheck(p))
    .filter(Boolean);
  if (parts.length > 0 && parts.every((p) => PURE_ACKNOWLEDGEMENTS.has(p))) {
    return true;
  }
  return false;
}

function cleanSegmentText(rawText) {
  let text = String(rawText || '').trim();
  if (!text) return '';

  // Remove multi-word and single-word fillers
  text = text.replace(MULTI_WORD_FILLERS_RE, ' ');
  text = text.replace(SINGLE_WORD_FILLERS_RE, ' ');
  text = text.replace(INLINE_COMMA_LIKE_RE, ', ');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(LEADING_LIKE_RE, '').trim();

  // Strip leading pure acknowledgement clauses (e.g. "Yeah, we should deploy" -> "we should deploy")
  const leadingAckMatch = text.match(/^([a-zA-Z\s-]+?),\s+(.+)$/);
  if (leadingAckMatch && isPureAcknowledgement(leadingAckMatch[1])) {
    text = leadingAckMatch[2].trim();
  }
  text = text.replace(LEADING_LIKE_RE, '').trim();

  // Collapse consecutive repeated words (loop until fixed point for triple+ repeats)
  let prev;
  do {
    prev = text;
    text = text.replace(REPEATED_WORDS_RE, '$1');
  } while (text !== prev);

  // Clean up orphaned punctuation / spacing
  text = text
    .replace(/^[,;:\s]+/, '')
    .replace(/\s+([,.;?!])/g, '$1')
    .replace(/([,.;?!])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (isPureAcknowledgement(text)) {
    return '';
  }

  return text;
}

function countWords(text) {
  const cleaned = String(text || '')
    .replace(/[?!.,;:'"()[\]{}]/g, ' ')
    .trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

function detectQuestion(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/\?\s*$/.test(s)) return true;
  if (QUESTION_START_RE.test(s)) return true;
  if (QUESTION_PROMPT_RE.test(s)) return true;
  if (QUESTION_TAIL_RE.test(s)) return true;
  return false;
}

function detectDecision(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return DECISION_RE.test(s);
}

function detectActionItem(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return ACTION_ITEM_RE.test(s) || ACTION_VERB_DEADLINE_RE.test(s);
}

function resolveSpeaker(seg) {
  if (seg && typeof seg.speaker === 'string' && seg.speaker.trim()) {
    return seg.speaker.trim();
  }
  if (seg && seg.channel === 'them') return 'Them';
  if (seg && seg.channel === 'you') return 'You';
  return 'Speaker';
}

function resolveTimestamp(seg) {
  const ts = seg && (seg.timestamp ?? seg.ts ?? seg.startMs ?? 0);
  return Number.isFinite(Number(ts)) ? Number(ts) : 0;
}

/**
 * Deterministic Transcript Preprocessor:
 * 1. Drops standalone filler/acknowledgement-only turns before merging so backchannels
 *    don't fragment or pollute adjacent turns.
 * 2. Merges consecutive same-speaker segments under 5000ms apart.
 * 3. Strips filler phrases, pure acknowledgements, and collapses repeated words.
 * 4. Drops segments with < 3 words after cleaning.
 * 5. Tags each cleaned segment with { isQuestion, isDecision, isActionItem }.
 */
function preprocessTranscript(segments, options = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const mergeGapMs = options.mergeGapMs ?? MERGE_GAP_MS;
  const minWords = options.minWords ?? MIN_WORDS;

  // Step 1: Normalize and pre-filter pure backchannel/empty segments
  const normalized = [];
  for (const raw of segments) {
    if (!raw || typeof raw.text !== 'string') continue;
    const preCleaned = cleanSegmentText(raw.text);
    if (!preCleaned) continue;
    const ts = resolveTimestamp(raw);
    const endTs = Number.isFinite(Number(raw.endTimestamp)) ? Number(raw.endTimestamp) : ts;
    normalized.push({
      ...raw,
      speaker: resolveSpeaker(raw),
      channel: raw.channel || (resolveSpeaker(raw).toLowerCase() === 'them' ? 'them' : 'you'),
      rawText: raw.text,
      text: preCleaned,
      timestamp: ts,
      endTimestamp: endTs,
    });
  }

  // Step 2: Merge consecutive same-speaker segments < 5000ms apart
  const merged = [];
  for (const seg of normalized) {
    const prev = merged[merged.length - 1];
    const gap = prev ? seg.timestamp - prev.lastTimestamp : Infinity;
    if (prev && prev.speaker === seg.speaker && gap >= 0 && gap < mergeGapMs) {
      prev.text = `${prev.text} ${seg.text}`;
      prev.lastTimestamp = seg.timestamp;
      prev.endTimestamp = Math.max(prev.endTimestamp, seg.endTimestamp);
      prev.mergedCount = (prev.mergedCount || 1) + 1;
    } else {
      merged.push({
        ...seg,
        lastTimestamp: seg.timestamp,
        mergedCount: 1,
      });
    }
  }

  // Step 3: Final clean, < 3 words filter, and boolean tagging
  const out = [];
  for (const seg of merged) {
    const text = cleanSegmentText(seg.text);
    if (!text) continue;
    const wordCount = countWords(text);
    if (wordCount < minWords) continue;

    const isQuestion = detectQuestion(text);
    const isDecision = detectDecision(text);
    const isActionItem = detectActionItem(text);
    const tokens = estimateTokens(text);

    const { lastTimestamp, rawText, ...rest } = seg;
    out.push({
      ...rest,
      text,
      wordCount,
      tokens,
      isQuestion,
      isDecision,
      isActionItem,
    });
  }

  return out;
}

/**
 * Normalize segments for chunking (preserving already-preprocessed segments or
 * tagging raw segments without destructively collapsing synthetic test strings).
 */
function normalizeSegmentsForChunking(segments, options = {}) {
  if (options.preprocess) {
    return preprocessTranscript(segments, options);
  }
  const out = [];
  for (const seg of segments || []) {
    if (!seg || typeof seg.text !== 'string') continue;
    const text = seg.text.trim();
    if (!text) continue;
    const ts = resolveTimestamp(seg);
    const endTs = Number.isFinite(Number(seg.endTimestamp)) ? Number(seg.endTimestamp) : ts;
    out.push({
      ...seg,
      speaker: resolveSpeaker(seg),
      text,
      timestamp: ts,
      endTimestamp: endTs,
      wordCount: typeof seg.wordCount === 'number' ? seg.wordCount : countWords(text),
      tokens: typeof seg.tokens === 'number' ? seg.tokens : estimateTokens(text),
      isQuestion: typeof seg.isQuestion === 'boolean' ? seg.isQuestion : detectQuestion(text),
      isDecision: typeof seg.isDecision === 'boolean' ? seg.isDecision : detectDecision(text),
      isActionItem: typeof seg.isActionItem === 'boolean' ? seg.isActionItem : detectActionItem(text),
    });
  }
  return out;
}

function buildChunkObject(meetingId, chunkIndex, segments, overlapCount = 0) {
  const text = segments.map((s) => `${s.speaker}: ${s.text}`).join('\n');
  const tokenCount = segments.reduce((sum, s) => sum + (s.tokens || estimateTokens(s.text)), 0);
  const speakers = Array.from(new Set(segments.map((s) => s.speaker)));
  return {
    id: `${meetingId}#chunk-${chunkIndex}`,
    meetingId,
    chunkIndex,
    segments: segments.slice(),
    text,
    tokenCount,
    startTimestamp: segments[0] ? segments[0].timestamp : 0,
    endTimestamp: segments[segments.length - 1] ? segments[segments.length - 1].endTimestamp : 0,
    speakers,
    hasQuestion: segments.some((s) => s.isQuestion),
    hasDecision: segments.some((s) => s.isDecision),
    hasActionItem: segments.some((s) => s.isActionItem),
    overlapCount,
  };
}

function computeOverlapSegments(chunkSegments, overlapTargetTokens, maxTokens) {
  if (!chunkSegments.length || overlapTargetTokens <= 0) return [];
  const selected = [];
  let tokens = 0;

  for (let i = chunkSegments.length - 1; i >= 0; i--) {
    const seg = chunkSegments[i];
    const segTokens = seg.tokens || estimateTokens(seg.text);
    if (selected.length > 0 && tokens + segTokens > overlapTargetTokens * 1.8) {
      break;
    }
    if (tokens + segTokens > maxTokens * 0.5 && selected.length > 0) {
      break;
    }
    selected.unshift(seg);
    tokens += segTokens;
    if (tokens >= overlapTargetTokens) {
      // If the first overlapped segment is an answer to an immediately preceding question
      // from a different speaker, include that question so Q&A is not split in the overlap.
      if (i > 0) {
        const prev = chunkSegments[i - 1];
        const prevTokens = prev.tokens || estimateTokens(prev.text);
        if (
          (prev.isQuestion || /\?\s*$/.test(prev.text)) &&
          prev.speaker !== seg.speaker &&
          tokens + prevTokens <= maxTokens * 0.6
        ) {
          selected.unshift(prev);
        }
      }
      break;
    }
  }
  return selected;
}

/**
 * Semantic Exchange-Based Chunker:
 * - Splits segments into chunks with TARGET_TOKENS = 300 and MAX_TOKENS = 400.
 * - Never splits a question from its immediate answer across chunk boundaries.
 * - Carries ~50 tokens of overlap into the next chunk.
 *
 * Supports both chunkTranscript(meetingId, segments, options) and chunkTranscript(segments, options).
 */
function chunkTranscript(meetingIdOrSegments, maybeSegments, maybeOptions) {
  let meetingId = 'meeting';
  let rawSegments = [];
  let options = {};

  if (Array.isArray(meetingIdOrSegments)) {
    rawSegments = meetingIdOrSegments;
    options = maybeSegments || {};
    meetingId = options.meetingId || 'meeting';
  } else {
    meetingId = String(meetingIdOrSegments || 'meeting');
    rawSegments = Array.isArray(maybeSegments) ? maybeSegments : [];
    options = maybeOptions || {};
  }

  const targetTokens = options.targetTokens ?? TARGET_TOKENS;
  const maxTokens = options.maxTokens ?? MAX_TOKENS;
  const overlapTargetTokens = options.overlapTokens ?? OVERLAP_TARGET_TOKENS;

  const segments = normalizeSegmentsForChunking(rawSegments, options);
  if (segments.length === 0) return [];

  const chunks = [];
  let current = [];
  let currentTokens = 0;
  let currentOverlapCount = 0;

  const flush = (carryOverlap = true) => {
    if (current.length === 0) return;
    const chunk = buildChunkObject(meetingId, chunks.length, current, currentOverlapCount);
    chunks.push(chunk);
    if (carryOverlap) {
      const overlap = computeOverlapSegments(current, overlapTargetTokens, maxTokens);
      current = overlap.slice();
      currentTokens = current.reduce((sum, s) => sum + s.tokens, 0);
      currentOverlapCount = current.length;
    } else {
      current = [];
      currentTokens = 0;
      currentOverlapCount = 0;
    }
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segTokens = seg.tokens;
    const nextSeg = i + 1 < segments.length ? segments[i + 1] : null;
    const isSegQuestion = seg.isQuestion || /\?\s*$/.test(seg.text);
    const isNextAnswer =
      isSegQuestion &&
      nextSeg &&
      nextSeg.speaker !== seg.speaker;

    // Lookahead: if `seg` is a question answered by `nextSeg`, and adding both to a non-empty
    // chunk would exceed maxTokens (or exceed targetTokens while the pair itself fits in maxTokens),
    // flush BEFORE `seg` so the question and its answer stay together in the next chunk.
    if (
      current.length > currentOverlapCount &&
      isNextAnswer &&
      currentTokens + segTokens + nextSeg.tokens > maxTokens &&
      segTokens + nextSeg.tokens <= maxTokens
    ) {
      flush(true);
      // Ensure overlap + question + answer still fits within maxTokens
      while (current.length > 0 && currentTokens + segTokens + nextSeg.tokens > maxTokens) {
        const removed = current.shift();
        currentTokens -= removed.tokens;
        currentOverlapCount = Math.max(0, currentOverlapCount - 1);
      }
    }

    if (current.length > 0 && currentTokens + segTokens > targetTokens) {
      const last = current[current.length - 1];
      const lastIsQuestion = last.isQuestion || /\?\s*$/.test(last.text);
      const segAnswersLast = lastIsQuestion && seg.speaker !== last.speaker;

      if (segAnswersLast && currentTokens + segTokens <= maxTokens) {
        // Keep the answer in the same chunk as its question, then flush!
        current.push(seg);
        currentTokens += segTokens;
        flush(true);
        continue;
      }

      // Otherwise flush current chunk before adding `seg`
      flush(true);
      while (current.length > 0 && currentTokens + segTokens > maxTokens) {
        const removed = current.shift();
        currentTokens -= removed.tokens;
        currentOverlapCount = Math.max(0, currentOverlapCount - 1);
      }
    }

    current.push(seg);
    currentTokens += segTokens;
  }

  if (current.length > currentOverlapCount || (chunks.length === 0 && current.length > 0)) {
    flush(false);
  }

  return chunks;
}

function formatChunkForContext(chunk, meetingStartMs = 0) {
  if (!chunk || !Array.isArray(chunk.segments) || chunk.segments.length === 0) return '';
  const relMs = Math.max(0, (chunk.startTimestamp || 0) - (meetingStartMs || 0));
  const totalSec = Math.floor(relMs / 1000);
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  const tags = [];
  if (chunk.hasQuestion) tags.push('Q&A');
  if (chunk.hasDecision) tags.push('Decision');
  if (chunk.hasActionItem) tags.push('Action');
  const tagSuffix = tags.length ? ` [${tags.join(', ')}]` : '';
  return `[${mins}:${secs}]${tagSuffix}\n${chunk.text}`;
}

/**
 * Tokenizer for BM25: lowercase, split on non-word characters, strip leading/trailing
 * punctuation, filter stopwords and tokens < 2 chars.
 */
function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_+#.-]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Pure-JS BM25 Lexical Search Index (default k1 = 1.5, b = 0.75).
 */
class Bm25Index {
  constructor(options = {}) {
    this.k1 = options.k1 ?? DEFAULT_BM25.k1;
    this.b = options.b ?? DEFAULT_BM25.b;
    this.docs = [];
    this.df = new Map();
    this.totalLength = 0;
  }

  get size() {
    return this.docs.length;
  }

  get avgdl() {
    return this.docs.length > 0 ? this.totalLength / this.docs.length : 0;
  }

  addDocument(idOrDoc, text, meta = {}) {
    let docId = idOrDoc;
    let docText = text;
    let docMeta = meta;

    if (idOrDoc && typeof idOrDoc === 'object' && !Array.isArray(idOrDoc)) {
      docId = idOrDoc.id ?? String(this.docs.length);
      docText = idOrDoc.text ?? '';
      docMeta = idOrDoc.meta ?? idOrDoc;
    }

    const tokens = tokenize(docText);
    const tf = new Map();
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) || 0) + 1);
    }
    for (const term of tf.keys()) {
      this.df.set(term, (this.df.get(term) || 0) + 1);
    }

    this.totalLength += tokens.length;
    this.docs.push({
      id: docId,
      text: String(docText || ''),
      tokens,
      length: tokens.length,
      tf,
      meta: docMeta || {},
    });
    return this;
  }

  addDocuments(docs) {
    if (!Array.isArray(docs)) return this;
    for (const d of docs) {
      this.addDocument(d);
    }
    return this;
  }

  score(query) {
    const qTokens = Array.from(new Set(tokenize(query)));
    if (qTokens.length === 0 || this.docs.length === 0) return [];

    const N = this.docs.length;
    const avgdl = this.avgdl || 1;
    const results = [];

    for (const doc of this.docs) {
      let s = 0;
      for (const term of qTokens) {
        const f = doc.tf.get(term) || 0;
        if (f === 0) continue;
        const nq = this.df.get(term) || 0;
        const idf = Math.log(1 + (N - nq + 0.5) / (nq + 0.5));
        const denom = f + this.k1 * (1 - this.b + this.b * (doc.length / avgdl));
        s += idf * ((f * (this.k1 + 1)) / denom);
      }
      if (s > 0) {
        results.push({
          id: doc.id,
          score: s,
          text: doc.text,
          meta: doc.meta,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  scoreNormalized(query) {
    const raw = this.score(query);
    if (raw.length === 0) return [];
    const maxScore = raw[0].score || 1;
    return raw.map((item) => ({
      ...item,
      normalizedScore: item.score / maxScore,
    }));
  }

  search(query, topK = 5) {
    return this.score(query).slice(0, Math.max(1, topK));
  }
}

function normalizeNotesList(notes) {
  if (!notes) return [];
  if (typeof notes === 'string') {
    return notes
      .split(/\n{2,}|\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text, idx) => ({ id: `note-${idx}`, text, meta: { source: 'notes' } }));
  }
  if (Array.isArray(notes)) {
    return notes
      .map((n, idx) => {
        if (typeof n === 'string') {
          return { id: `note-${idx}`, text: n.trim(), meta: { source: 'notes' } };
        }
        if (n && typeof n === 'object' && typeof n.text === 'string') {
          return {
            id: n.id || `note-${idx}`,
            text: n.text.trim(),
            meta: { ...n, source: 'notes' },
          };
        }
        return null;
      })
      .filter((n) => n && n.text);
  }
  if (typeof notes === 'object') {
    const items = [];
    if (notes.summary) items.push({ id: 'note-summary', text: String(notes.summary), meta: { source: 'notes', section: 'summary' } });
    for (const key of ['keyPoints', 'decisions', 'actionItems', 'followUp']) {
      if (Array.isArray(notes[key])) {
        notes[key].forEach((entry, idx) => {
          if (entry) items.push({ id: `note-${key}-${idx}`, text: String(entry), meta: { source: 'notes', section: key } });
        });
      }
    }
    return items;
  }
  return [];
}

/**
 * Convenience helper to index both transcript turns/chunks and user notes
 * with BM25 (k1 = 1.5, b = 0.75) and search for `query`.
 */
function searchTranscriptAndNotes({
  transcript = [],
  notes = [],
  query = '',
  topK = 5,
  meetingId = 'meeting',
  bm25Options = DEFAULT_BM25,
} = {}) {
  const index = new Bm25Index(bm25Options);

  if (Array.isArray(transcript) && transcript.length > 0) {
    // Check if already chunked (has chunkIndex / segments)
    const isAlreadyChunked = transcript[0] && Array.isArray(transcript[0].segments);
    const chunks = isAlreadyChunked
      ? transcript
      : chunkTranscript(meetingId, preprocessTranscript(transcript));

    for (const chunk of chunks) {
      index.addDocument(chunk.id, chunk.text, {
        source: 'transcript',
        chunk,
        startTimestamp: chunk.startTimestamp,
        endTimestamp: chunk.endTimestamp,
        hasQuestion: chunk.hasQuestion,
        hasDecision: chunk.hasDecision,
        hasActionItem: chunk.hasActionItem,
      });
    }
  }

  const noteDocs = normalizeNotesList(notes);
  for (const note of noteDocs) {
    index.addDocument(note.id, note.text, note.meta);
  }

  return index.search(query, topK);
}

module.exports = {
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
};
