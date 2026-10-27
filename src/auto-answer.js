'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.CueAutoAnswer = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Common interviewer acknowledgements and backchannels (from SimpleAutoAnswer.ts)
  const USER_BACKCHANNEL = /^(?:(?:yeah|yes|yep|yup|ya|mm-?hm+|mhm+|uh-?huh|ok(?:ay)?|right|sure|cool|got it|i see|nice|great|perfect|exactly|interesting|makes sense|sounds good|true|correct|wow|oh|ah|hm+|haha+|alright|of course|fair enough|no problem|totally|absolutely|definitely|indeed|good|fine)[\s,.!?-]*){1,4}$/i;

  const STABILITY_MS = 900;
  const JUDGE_DEADLINE_MS = 2500;
  const JUDGE_CONTAINMENT_MIN = 0.65;
  const JUDGE_TURN_CHAR_CAP = 400;
  const JUDGE_CANDIDATE_CHAR_CAP = 1000;
  const DISPATCH_THRESHOLD = 0.88;
  const OFFER_THRESHOLD = 0.65;

  const AV_AND_LOGISTICS_RE = /\b(can you hear me|hear me okay|hear me alright|can you see my screen|see my screen|is my mic working|am i audible|am i on mute|you are on mute|you'?re on mute|let me share my screen|sharing my screen)\b/i;

  const GREETINGS_RE = /^(hi|hello|hey|good morning|good afternoon|good evening|how are you( doing| today)?|how'?s it going|how is it going|how was your weekend|how is your day( going)?|nice to meet you|great to meet you|pleasure to meet you|thanks for (joining|taking the time|coming)|where are you (calling|joining|based|located)( from)?|how is the weather)\b/i;

  const RHETORICAL_CHECKIN_RE = /^(does that make sense|make sense|makes sense|you know what i mean|right|okay|ok|all right|alright|sounds good|got it|(are you )?ready( to (get started|begin|start))?|shall we (begin|get started|start|jump in)|do you have a minute|any questions before we (start|begin)|let'?s get started|let us get started)$/i;

  const DANGLING_WORDS_RE = /\b(and|or|but|so|because|since|although|though|if|when|while|where|which|that|whether|like|such as|for example|for instance|in terms of|with|without|to|from|for|about|into|onto|between|regarding|concerning|as well as|including)\s*$/i;

  const LEADING_FILLER_RE = /^(\s*(um|uh|er|ah|so|okay|ok|alright|all right|well|now|and|right)[,.\s]+)+/i;

  const INTERVIEW_PROMPT_RE = /(\btell me about\b|\bwalk me through\b|\bdescribe a\b|\bgive me an example\b|\bshare an example\b|\btalk about a time\b|\bexplain how\b|\bexplain what\b|\bexplain why\b|\bwhat (was|were|is|are|would|did|do)\b|\bhow (did|do|would|can|could|should)\b|\bwhy (did|do|would|should|are|is)\b|\bwhen (did|was|have)\b|\bwhere (did|do|would)\b|\bwho (was|is|did)\b|\bwhich\b.*\b(prefer|choose|pick|best|better)\b|\bcan you (tell|describe|explain|walk|share|give|talk)\b|\bcould you (tell|describe|explain|walk|share|give|talk)\b|\bwould you (say|rather|prefer|describe|explain)\b|\bhave you ever\b)/i;

  const QUESTION_STARTER_RE = /^(what|how|why|when|where|who|which|tell|describe|explain|walk|give|share|can|could|would|should|have|has|did|do|does|is|are|was|were)\b/i;

  function normalizeText(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^a-z0-9'\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeForCompare(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenContainment(needle, haystack) {
    const nq = normalizeForCompare(needle).split(' ').filter(Boolean);
    if (nq.length === 0) return 0;
    const have = new Set(normalizeForCompare(haystack).split(' ').filter(Boolean));
    let hit = 0;
    for (const t of nq) {
      if (have.has(t)) hit++;
    }
    return hit / nq.length;
  }

  function keepTail(text, max) {
    const t = String(text ?? '');
    return t.length <= max ? t : `…${t.slice(t.length - max)}`;
  }

  function cleanLeadingFillers(text) {
    return String(text || '').trim().replace(LEADING_FILLER_RE, '').trim();
  }

  function extractFinalSentence(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const parts = raw
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length ? parts[parts.length - 1] : raw;
  }

  function isSmallTalkOrLogistics(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    const norm = normalizeText(raw);
    if (!norm) return false;

    if (AV_AND_LOGISTICS_RE.test(norm)) return true;
    if (RHETORICAL_CHECKIN_RE.test(norm)) return true;

    const strippedFiller = normalizeText(cleanLeadingFillers(raw));
    if (strippedFiller && RHETORICAL_CHECKIN_RE.test(strippedFiller)) return true;

    const words = norm.split(/\s+/).filter(Boolean);
    if (GREETINGS_RE.test(norm) && words.length <= 10 && !INTERVIEW_PROMPT_RE.test(norm)) {
      return true;
    }
    if (strippedFiller && GREETINGS_RE.test(strippedFiller) && words.length <= 10 && !INTERVIEW_PROMPT_RE.test(strippedFiller)) {
      return true;
    }

    return false;
  }

  function hasDanglingEnding(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    if (/[,…\-—]\s*$/.test(trimmed) || /\.\.\.\s*$/.test(trimmed)) return true;
    if (/\?\s*$/.test(trimmed)) return false;

    const withoutTrailingPeriod = trimmed.replace(/[.!]+\s*$/, '').trim();
    return DANGLING_WORDS_RE.test(withoutTrailingPeriod);
  }

  function stripDanglingEnding(text) {
    let cur = String(text || '').trim();
    cur = cur.replace(/[,…\-—.]+\s*$/, '').trim();
    cur = cur.replace(DANGLING_WORDS_RE, '').trim();
    cur = cur.replace(/[,…\-—.]+\s*$/, '').trim();
    return cur;
  }

  function evaluateQuestionCandidate(text) {
    const raw = String(text || '').trim();
    const cleaned = cleanLeadingFillers(raw);
    const words = cleaned.split(/\s+/).filter(Boolean);

    if (!cleaned || cleaned.length < 10 || words.length < 3) {
      return { decision: 'ignore', confidence: 'low', reason: 'too_short', settleMs: 0 };
    }

    const lastSentence = cleanLeadingFillers(extractFinalSentence(cleaned));
    if (isSmallTalkOrLogistics(raw) || isSmallTalkOrLogistics(cleaned) || (lastSentence && isSmallTalkOrLogistics(lastSentence))) {
      return { decision: 'ignore', confidence: 'low', reason: 'small_talk', settleMs: 0 };
    }

    if (hasDanglingEnding(cleaned)) {
      return { decision: 'incomplete', confidence: 'accumulating', reason: 'dangling_ending', settleMs: 3200 };
    }

    if (/\?\s*$/.test(cleaned) && words.length >= 4) {
      return { decision: 'question', confidence: 'high', reason: 'explicit_question', settleMs: 1400 };
    }

    const lastWords = lastSentence ? lastSentence.split(/\s+/).filter(Boolean) : words;
    if (words.length >= 5) {
      if (INTERVIEW_PROMPT_RE.test(cleaned) || (lastSentence && INTERVIEW_PROMPT_RE.test(lastSentence))) {
        return { decision: 'question', confidence: 'medium', reason: 'interview_prompt', settleMs: 2000 };
      }
      if (QUESTION_STARTER_RE.test(cleaned) || (lastWords.length >= 5 && QUESTION_STARTER_RE.test(lastSentence))) {
        return { decision: 'question', confidence: 'medium', reason: 'interview_prompt', settleMs: 2000 };
      }
    }

    return { decision: 'ignore', confidence: 'low', reason: 'statement', settleMs: 0 };
  }

  function createAutoAnswerController(options = {}) {
    const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};
    const onTriggerAnswer = typeof options.onTriggerAnswer === 'function' ? options.onTriggerAnswer : () => {};
    const onAbortAnswer = typeof options.onAbortAnswer === 'function' ? options.onAbortAnswer : () => {};
    const setTimer = typeof options.setTimer === 'function' ? options.setTimer : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : (id) => clearTimeout(id);
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const cooldownMs = typeof options.cooldownMs === 'number' ? options.cooldownMs : 1800;

    let state = 'off';
    let enabled = false;
    let capturing = false;
    let candidateText = '';
    let lastAnsweredText = '';
    let lastTriggerAt = 0;
    let lastInterimAt = 0;
    let themSpeaking = false;
    let youSpeaking = false;
    let youSpokeSinceLastTrigger = false;
    let pendingContinuation = false;
    let receivedFirstToken = false;

    let settleTimer = null;
    let incompleteTimer = null;
    let cooldownTimer = null;
    let vadFallbackTimer = null;

    function clearSettleTimer() {
      if (settleTimer !== null) {
        clearTimer(settleTimer);
        settleTimer = null;
      }
    }

    function clearIncompleteTimer() {
      if (incompleteTimer !== null) {
        clearTimer(incompleteTimer);
        incompleteTimer = null;
      }
    }

    function clearCooldownTimer() {
      if (cooldownTimer !== null) {
        clearTimer(cooldownTimer);
        cooldownTimer = null;
      }
    }

    function clearVadFallbackTimer() {
      if (vadFallbackTimer !== null) {
        clearTimer(vadFallbackTimer);
        vadFallbackTimer = null;
      }
    }

    function clearAllTimers() {
      clearSettleTimer();
      clearIncompleteTimer();
      clearCooldownTimer();
      clearVadFallbackTimer();
    }

    function transition(nextState, detail = {}) {
      const prev = state;
      state = nextState;
      if (prev !== nextState || detail.force) {
        onStateChange(state, {
          previousState: prev,
          enabled,
          capturing,
          candidateText,
          ...detail
        });
      }
    }

    function fireTrigger(questionText, ev) {
      clearAllTimers();
      const q = String(questionText || '').trim();
      if (!q) {
        candidateText = '';
        pendingContinuation = false;
        transition(enabled && capturing ? 'quiet' : 'off');
        return;
      }
      const isCont = pendingContinuation;
      lastAnsweredText = q;
      lastTriggerAt = now();
      youSpokeSinceLastTrigger = false;
      candidateText = '';
      pendingContinuation = false;
      receivedFirstToken = false;
      transition('thinking', {
        question: q,
        isContinuation: isCont,
        confidence: ev.confidence,
        reason: ev.reason
      });
      onTriggerAnswer(q, {
        isContinuation: isCont,
        confidence: ev.confidence,
        reason: ev.reason
      });
    }

    function scheduleQuestionSettle(ev) {
      clearSettleTimer();
      clearVadFallbackTimer();
      transition('settling', { confidence: ev.confidence, reason: ev.reason });

      if (themSpeaking) {
        vadFallbackTimer = setTimer(() => {
          vadFallbackTimer = null;
          themSpeaking = false;
          if ((state === 'settling' || state === 'listening') && candidateText) {
            const currentEv = evaluateQuestionCandidate(candidateText);
            if (currentEv.decision === 'question') {
              fireTrigger(candidateText, currentEv);
            }
          }
        }, 2500);
        return;
      }

      settleTimer = setTimer(() => {
        settleTimer = null;
        if (state !== 'settling' && state !== 'listening') return;
        fireTrigger(candidateText, ev);
      }, ev.settleMs);
    }

    function scheduleIncompleteSettle(ev) {
      clearSettleTimer();
      clearIncompleteTimer();
      transition('listening', { confidence: ev.confidence, reason: ev.reason });
      settleTimer = setTimer(() => {
        settleTimer = null;
        if (!enabled || !capturing || !candidateText) return;
        const stripped = stripDanglingEnding(candidateText);
        const retryEv = evaluateQuestionCandidate(stripped);
        if (retryEv.decision === 'question') {
          fireTrigger(stripped, retryEv);
        } else {
          candidateText = '';
          pendingContinuation = false;
          transition('quiet', { reason: 'incomplete_expired' });
        }
      }, ev.settleMs);
    }

    function evaluateAndSchedule() {
      const ev = evaluateQuestionCandidate(candidateText);
      if (ev.decision === 'ignore') {
        if (ev.reason === 'small_talk') {
          clearAllTimers();
          candidateText = '';
          pendingContinuation = false;
          transition('quiet', { reason: 'small_talk' });
          return;
        }
        transition('listening', { reason: ev.reason });
        clearIncompleteTimer();
        incompleteTimer = setTimer(() => {
          incompleteTimer = null;
          candidateText = '';
          pendingContinuation = false;
          if (state === 'listening') {
            transition('quiet', { reason: 'statement_timeout' });
          }
        }, 4500);
        return;
      }

      if (ev.decision === 'incomplete') {
        scheduleIncompleteSettle(ev);
        return;
      }

      if (ev.decision === 'question') {
        if (
          !pendingContinuation &&
          lastAnsweredText &&
          normalizeText(candidateText) === normalizeText(lastAnsweredText) &&
          (now() - lastTriggerAt) < 10000
        ) {
          clearAllTimers();
          candidateText = '';
          transition('quiet', { reason: 'duplicate' });
          return;
        }
        scheduleQuestionSettle(ev);
      }
    }

    return {
      setConfig(patch = {}) {
        if (typeof patch.enabled === 'boolean') enabled = patch.enabled;
        if (typeof patch.capturing === 'boolean') capturing = patch.capturing;

        if (!enabled || !capturing) {
          clearAllTimers();
          candidateText = '';
          pendingContinuation = false;
          themSpeaking = false;
          youSpeaking = false;
          transition('off');
          return;
        }

        if (state === 'off') {
          transition('quiet');
        }
      },

      onVadState(channel, speaking) {
        if (!enabled || !capturing) return;

        if (channel === 'them') {
          themSpeaking = !!speaking;
          if (themSpeaking) {
            clearSettleTimer();
            clearVadFallbackTimer();
            if (state === 'settling' || state === 'quiet') {
              transition('listening');
            }
          } else {
            clearVadFallbackTimer();
            if ((state === 'listening' || state === 'settling') && candidateText) {
              evaluateAndSchedule();
            }
          }
          return;
        }

        if (channel === 'you') {
          youSpeaking = !!speaking;
          if (youSpeaking) {
            youSpokeSinceLastTrigger = true;
            if (state === 'settling') {
              clearAllTimers();
              candidateText = '';
              pendingContinuation = false;
              transition('quiet', { reason: 'user_spoke' });
            } else if (state === 'thinking' && !receivedFirstToken) {
              clearAllTimers();
              candidateText = '';
              pendingContinuation = false;
              onAbortAnswer();
              transition('quiet', { reason: 'user_spoke' });
            }
          }
        }
      },

      onThemInterim(text) {
        if (!enabled || !capturing) return;
        if (!text || !String(text).trim()) return;
        lastInterimAt = now();
        clearSettleTimer();
        if (state === 'settling' || state === 'quiet') {
          transition('listening');
        }
      },

      onThemFinal(text) {
        if (!enabled || !capturing) return;
        const clean = String(text || '').trim();
        if (!clean) return;

        clearSettleTimer();
        clearIncompleteTimer();
        clearVadFallbackTimer();

        const isContinuationWindow =
          (state === 'thinking' || (state === 'cooldown' && (now() - lastTriggerAt) <= 3500)) &&
          !youSpokeSinceLastTrigger &&
          Boolean(lastAnsweredText);

        if (isContinuationWindow && !isSmallTalkOrLogistics(clean)) {
          if (state === 'thinking') {
            onAbortAnswer();
          }
          clearCooldownTimer();
          candidateText = (lastAnsweredText + ' ' + clean).trim();
          pendingContinuation = true;
        } else {
          candidateText = candidateText ? (candidateText + ' ' + clean).trim() : clean;
        }

        evaluateAndSchedule();
      },

      onYouFinal(text) {
        if (!text || !String(text).trim()) return;
        youSpokeSinceLastTrigger = true;
        candidateText = '';
        pendingContinuation = false;
        clearSettleTimer();
        clearIncompleteTimer();
        clearVadFallbackTimer();
        if (state === 'listening' || state === 'settling') {
          transition('quiet', { reason: 'user_spoke' });
        }
      },

      onLlmStart() {
        if (!enabled || !capturing) return;
        if (state === 'settling' || state === 'thinking') {
          receivedFirstToken = false;
          transition('thinking');
        }
      },

      onLlmToken() {
        if (state === 'thinking') {
          receivedFirstToken = true;
        }
      },

      onLlmDone() {
        if (state === 'thinking') {
          clearCooldownTimer();
          transition('cooldown');
          cooldownTimer = setTimer(() => {
            cooldownTimer = null;
            if (state === 'cooldown') {
              transition(enabled && capturing ? 'quiet' : 'off');
            }
          }, cooldownMs);
        }
      },

      cancel() {
        clearAllTimers();
        const wasThinking = state === 'thinking';
        candidateText = '';
        pendingContinuation = false;
        receivedFirstToken = false;
        if (wasThinking) {
          onAbortAnswer();
        }
        transition(enabled && capturing ? 'quiet' : 'off', { reason: 'cancelled' });
      },

      getState() {
        return {
          state,
          enabled,
          capturing,
          candidateText,
          lastAnsweredText,
          themSpeaking,
          youSpeaking,
          lastInterimAt
        };
      }
    };
  }

  // ---------------- Section 2: SimpleAutoAnswer (Beta) ----------------

  function buildJudgePrompt({ candidateText, recentTurns }) {
    const kept = (recentTurns || []).slice(-8);
    const context = kept
      .map((t) => {
        const text = keepTail(t.text, JUDGE_TURN_CHAR_CAP);
        const speaker = t.channel === 'you' || t.role === 'user' ? 'USER' : 'OTHERS';
        return `${speaker}: ${text}`;
      })
      .join('\n');
    const candidate = keepTail(candidateText, JUDGE_CANDIDATE_CHAR_CAP);

    return `You analyze a live conversation transcript to decide if the latest speech directed at the USER contains a question or task they should answer.
Recent transcript (oldest first):
${context || '(none)'}

Latest speech:
<candidate>
${candidate}
</candidate>

Determine:
1. isAsk: true if the candidate contains a question or actionable task directed at the USER to answer; false if it is small talk, self-answered, a statement, or incomplete.
2. questionText: the extracted core question or task quoted verbatim from the candidate (or null if not an ask).
3. confidence: a score between 0.0 and 1.0 representing how confident you are that the user wants an answer right now.

Respond ONLY with this JSON format:
{"isAsk": boolean, "questionText": string|null, "confidence": number}`;
  }

  function parseJudgeVerdict(raw, candidateText) {
    if (!raw) return null;
    let parsed = null;
    if (typeof raw === 'object' && raw !== null) {
      parsed = raw;
    } else if (typeof raw === 'string') {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          parsed = JSON.parse(raw.slice(start, end + 1));
        } catch (_) {
          return null;
        }
      }
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const isAsk = parsed.isAsk !== undefined ? Boolean(parsed.isAsk) : Boolean(parsed.is_ask);
    let confidence = typeof parsed.confidence === 'number'
      ? parsed.confidence
      : (typeof parsed.answerability === 'number' ? parsed.answerability : 0);
    if (Number.isNaN(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));

    let questionText = null;
    const rawQ = parsed.questionText !== undefined ? parsed.questionText : parsed.question_text;
    if (typeof rawQ === 'string' && rawQ.trim()) {
      questionText = rawQ.trim();
    }

    return { isAsk, questionText, confidence };
  }

  function createSimpleAutoAnswer(options = {}) {
    const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => (options.enabled !== undefined ? !!options.enabled : true);
    const isCapturing = typeof options.isCapturing === 'function' ? options.isCapturing : () => (options.capturing !== undefined ? !!options.capturing : true);
    const isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false;
    const recentTurns = typeof options.recentTurns === 'function' ? options.recentTurns : () => [];
    const judgeCandidate = typeof options.judgeCandidate === 'function' ? options.judgeCandidate : null;
    const onDispatch = typeof options.onDispatch === 'function' ? options.onDispatch : () => {};
    const onOffer = typeof options.onOffer === 'function' ? options.onOffer : () => {};

    const clock = options.clock || {};
    const now = clock.now || options.now || (() => Date.now());
    const setTimer = clock.setTimeout || clock.setTimer || options.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = clock.clearTimeout || clock.clearTimer || options.clearTimer || ((id) => clearTimeout(id));

    const stabilityMs = typeof options.stabilityMs === 'number' ? options.stabilityMs : STABILITY_MS;
    const judgeDeadlineMs = typeof options.judgeDeadlineMs === 'number' ? options.judgeDeadlineMs : JUDGE_DEADLINE_MS;

    let enabled = typeof options.enabled === 'boolean' ? options.enabled : true;
    let capturing = typeof options.capturing === 'boolean' ? options.capturing : true;

    let candidate = '';
    let debounceTimer = null;
    let themSpeaking = false;
    let judgeSeq = 0;
    let inFlightAbort = null;

    const decisionLog = [];
    const MAX_LOG = 50;

    const answeredQuestions = new Set();
    if (options.lastAnsweredText) {
      const norm = normalizeForCompare(options.lastAnsweredText);
      if (norm) answeredQuestions.add(norm);
    }

    function recordDecision(entry) {
      const item = {
        timestamp: entry.timestamp || now(),
        candidate: entry.candidate || '',
        verdict: entry.verdict || 'silent',
        reason: entry.reason || '',
        confidence: typeof entry.confidence === 'number' ? entry.confidence : 0,
        extractedQuestion: entry.extractedQuestion || null
      };
      decisionLog.push(item);
      if (decisionLog.length > MAX_LOG) {
        decisionLog.shift();
      }
      return item;
    }

    function clearDebounceTimer() {
      if (debounceTimer !== null) {
        clearTimer(debounceTimer);
        debounceTimer = null;
      }
    }

    function restartStabilityWindow() {
      clearDebounceTimer();
      debounceTimer = setTimer(() => {
        debounceTimer = null;
        if (themSpeaking) {
          return;
        }
        onStoppage();
      }, stabilityMs);
    }

    async function onStoppage() {
      const effectiveEnabled = typeof options.isEnabled === 'function' ? options.isEnabled() : enabled;
      const effectiveCapturing = typeof options.isCapturing === 'function' ? options.isCapturing() : capturing;

      if (!effectiveEnabled || !effectiveCapturing) {
        return;
      }

      const candidateText = candidate.trim();
      if (!candidateText) {
        return;
      }

      // Gate check: engine busy
      if (isBusy()) {
        recordDecision({
          timestamp: now(),
          candidate: candidateText,
          verdict: 'silent',
          reason: 'engine_busy',
          confidence: 0,
          extractedQuestion: null
        });
        return;
      }

      // Prefilter 1: Duplicate check (normalized token hash)
      const candidateNorm = normalizeForCompare(candidateText);
      if (answeredQuestions.has(candidateNorm)) {
        candidate = '';
        recordDecision({
          timestamp: now(),
          candidate: candidateText,
          verdict: 'silent',
          reason: 'duplicate',
          confidence: 0,
          extractedQuestion: null
        });
        return;
      }

      // Prefilter 2: Backchannel check
      if (USER_BACKCHANNEL.test(candidateText) || isSmallTalkOrLogistics(candidateText)) {
        candidate = '';
        recordDecision({
          timestamp: now(),
          candidate: candidateText,
          verdict: 'silent',
          reason: 'backchannel',
          confidence: 0,
          extractedQuestion: null
        });
        return;
      }

      // Prefilter 3: Too short check (< 4 words and does not end with '?')
      const words = candidateText.split(/\s+/).filter(Boolean);
      if (words.length < 4 && !/\?\s*$/.test(candidateText)) {
        candidate = '';
        recordDecision({
          timestamp: now(),
          candidate: candidateText,
          verdict: 'silent',
          reason: 'too_short',
          confidence: 0,
          extractedQuestion: null
        });
        return;
      }

      // Passed prefilter: exactly ONE judge call per stoppage
      const currentSeq = ++judgeSeq;
      if (inFlightAbort) {
        try { inFlightAbort.abort(); } catch (_) {}
        inFlightAbort = null;
      }
      const abort = typeof AbortController !== 'undefined' ? new AbortController() : { abort() {}, signal: null };
      inFlightAbort = abort;

      let deadlineTimer = null;
      let timedOut = false;
      let judgeResult = null;
      let judgeError = null;

      if (!judgeCandidate) {
        executeFallback(candidateText, 'judge_error_fallback');
        return;
      }

      try {
        const turns = (typeof recentTurns === 'function' ? recentTurns() : []).slice(-8);
        const judgePromise = judgeCandidate({
          candidateText,
          recentTurns: turns
        }, abort.signal);

        const timeoutPromise = new Promise((resolve) => {
          deadlineTimer = setTimer(() => {
            timedOut = true;
            try { abort.abort(); } catch (_) {}
            resolve(null);
          }, judgeDeadlineMs);
        });

        judgeResult = await Promise.race([judgePromise, timeoutPromise]);
      } catch (err) {
        judgeError = err;
      } finally {
        if (deadlineTimer !== null) {
          clearTimer(deadlineTimer);
          deadlineTimer = null;
        }
        if (inFlightAbort === abort) {
          inFlightAbort = null;
        }
      }

      // Supersede check: if new speech arrived during judge call, discard verdict
      if (currentSeq !== judgeSeq) {
        return;
      }

      if (timedOut) {
        executeFallback(candidateText, 'judge_timeout_fallback');
        return;
      }

      if (judgeError !== null || judgeResult === null || judgeResult === undefined) {
        executeFallback(candidateText, 'judge_error_fallback');
        return;
      }

      const verdictObj = parseJudgeVerdict(judgeResult, candidateText);
      if (!verdictObj) {
        executeFallback(candidateText, 'judge_error_fallback');
        return;
      }

      // Containment check
      if (verdictObj.questionText) {
        const containment = tokenContainment(verdictObj.questionText, candidateText);
        if (containment < JUDGE_CONTAINMENT_MIN) {
          candidate = '';
          recordDecision({
            timestamp: now(),
            candidate: candidateText,
            verdict: 'silent',
            reason: 'containment_failed',
            confidence: verdictObj.confidence,
            extractedQuestion: verdictObj.questionText
          });
          return;
        }
      }

      const extracted = verdictObj.questionText || candidateText;

      if (!verdictObj.isAsk) {
        candidate = '';
        recordDecision({
          timestamp: now(),
          candidate: candidateText,
          verdict: 'silent',
          reason: 'not_ask',
          confidence: verdictObj.confidence,
          extractedQuestion: extracted
        });
        return;
      }

      if (verdictObj.confidence >= DISPATCH_THRESHOLD) {
        answeredQuestions.add(candidateNorm);
        answeredQuestions.add(normalizeForCompare(extracted));
        candidate = '';
        recordDecision({
          timestamp: now(),
          candidate: candidateText,
          verdict: 'dispatch',
          reason: 'confidence_high',
          confidence: verdictObj.confidence,
          extractedQuestion: extracted
        });
        onDispatch(extracted);
        return;
      }

      if (verdictObj.confidence >= OFFER_THRESHOLD) {
        candidate = '';
        recordDecision({
          timestamp: now(),
          candidate: candidateText,
          verdict: 'offer',
          reason: 'confidence_medium',
          confidence: verdictObj.confidence,
          extractedQuestion: extracted
        });
        onOffer(extracted);
        return;
      }

      candidate = '';
      recordDecision({
        timestamp: now(),
        candidate: candidateText,
        verdict: 'silent',
        reason: 'below_threshold',
        confidence: verdictObj.confidence,
        extractedQuestion: extracted
      });
    }

    function executeFallback(candidateText, reason) {
      candidate = '';
      const candidateNorm = normalizeForCompare(candidateText);
      if (/\?\s*$/.test(candidateText)) {
        answeredQuestions.add(candidateNorm);
        candidate = '';
        recordDecision({
          timestamp: now(),
          candidate: candidateText,
          verdict: 'dispatch',
          reason,
          confidence: 1.0,
          extractedQuestion: candidateText
        });
        onDispatch(candidateText);
      } else {
        recordDecision({
          timestamp: now(),
          candidate: candidateText,
          verdict: 'silent',
          reason,
          confidence: 0,
          extractedQuestion: null
        });
      }
    }

    return {
      setConfig(patch = {}) {
        if (typeof patch.enabled === 'boolean') enabled = patch.enabled;
        if (typeof patch.capturing === 'boolean') capturing = patch.capturing;
        if (!enabled || !capturing) {
          clearDebounceTimer();
          judgeSeq++;
          if (inFlightAbort) {
            try { inFlightAbort.abort(); } catch (_) {}
            inFlightAbort = null;
          }
        }
      },

      onVadState(channel, speaking) {
        if (channel === 'them') {
          themSpeaking = Boolean(speaking);
          if (themSpeaking) {
            judgeSeq++;
            if (inFlightAbort) {
              try { inFlightAbort.abort(); } catch (_) {}
              inFlightAbort = null;
            }
            clearDebounceTimer();
          } else {
            if (candidate.trim()) {
              restartStabilityWindow();
            }
          }
        }
      },

      onThemInterim(text) {
        if (!text || !String(text).trim()) return;
        judgeSeq++;
        if (inFlightAbort) {
          try { inFlightAbort.abort(); } catch (_) {}
          inFlightAbort = null;
        }
        restartStabilityWindow();
      },

      onThemFinal(text) {
        const clean = String(text || '').trim();
        if (!clean) return;
        judgeSeq++;
        if (inFlightAbort) {
          try { inFlightAbort.abort(); } catch (_) {}
          inFlightAbort = null;
        }
        candidate = candidate ? (candidate + ' ' + clean).trim() : clean;
        restartStabilityWindow();
      },

      onYouFinal(_text) {
        // Inert user channel: mic is transcribed for context, but inert for triggers.
      },

      recordConfirmation(questionText) {
        if (questionText) {
          answeredQuestions.add(normalizeForCompare(questionText));
        }
      },

      recordDismissal(questionText) {
        if (questionText) {
          answeredQuestions.add(normalizeForCompare(questionText));
        }
      },

      cancel() {
        clearDebounceTimer();
        judgeSeq++;
        if (inFlightAbort) {
          try { inFlightAbort.abort(); } catch (_) {}
          inFlightAbort = null;
        }
        candidate = '';
      },

      getDecisionLog() {
        return [...decisionLog];
      },

      getState() {
        return {
          enabled: typeof options.isEnabled === 'function' ? options.isEnabled() : enabled,
          capturing: typeof options.isCapturing === 'function' ? options.isCapturing() : capturing,
          candidate,
          themSpeaking,
          judgeInFlight: inFlightAbort !== null
        };
      }
    };
  }

  return {
    normalizeText,
    isSmallTalkOrLogistics,
    hasDanglingEnding,
    stripDanglingEnding,
    evaluateQuestionCandidate,
    createAutoAnswerController,
    // Section 2: SimpleAutoAnswer (Beta)
    USER_BACKCHANNEL,
    STABILITY_MS,
    JUDGE_DEADLINE_MS,
    JUDGE_CONTAINMENT_MIN,
    DISPATCH_THRESHOLD,
    OFFER_THRESHOLD,
    normalizeForCompare,
    tokenContainment,
    buildJudgePrompt,
    parseJudgeVerdict,
    createSimpleAutoAnswer
  };
});
